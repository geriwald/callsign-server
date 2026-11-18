import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { config } from "../config.ts";
import { db, type Tx } from "../db/client.ts";
import {
  agents,
  invitations,
  owners,
  type Agent,
  type Invitation,
  type Owner,
} from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { publicProfile } from "./agents.ts";
import { contactsByAgent, saveContact } from "./contacts.ts";
import { bumpInbox } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { organizationDomain } from "./identity.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast, type RecordedEvent } from "./ledger.ts";
import { sendMessage } from "./messaging.ts";
import { createNotice } from "./notices.ts";
import { normalizeEmail } from "./owners.ts";
import { maskEmail } from "./registrations.ts";
import { isAdmin } from "./reports.ts";
import { invitationEmailHash, inviteOnly } from "./signup.ts";

const INVITATION_TTL_MS = 30 * 86_400_000;
const MAX_NOTE_LENGTH = 1000;

const noteContext = (id: string) => `invitations.note:${id}`;
const emailContext = (id: string) => `invitations.email:${id}`;

/** What inviting someone returns while an admin decides. */
export type PendingInvitation = {
  status: "pending_admin_approval";
  sentTo: null;
  to: string;
  expiresAt: string;
  message: string;
};

export function isPendingInvitation(value: unknown): value is PendingInvitation {
  return (value as { status?: unknown } | null)?.status === "pending_admin_approval";
}

export async function invitePerson(
  inviter: Agent,
  input: { email: string; note?: string | undefined },
): Promise<{ sentTo: string; expiresAt: string } | PendingInvitation> {
  const email = normalizeEmail(input.email);
  const note = input.note?.trim().slice(0, MAX_NOTE_LENGTH) || null;
  await rateLimit(`invite:${inviter.id}`, 10, 86_400);
  await rateLimit(`invite-email:${invitationEmailHash(email)}`, 3, 7 * 86_400);

  const [inviterOwner] = await db.select().from(owners).where(eq(owners.id, inviter.ownerId));
  if (!inviterOwner) throw new AppError("not_found", "Account not found.");
  if (inviterOwner.email === email) {
    throw new AppError("invalid_input", "That's your owner's own email address.");
  }
  const [existing] = await db.select().from(owners).where(eq(owners.email, email));
  // On an invite-only server, letting someone new in is an admin's call.
  const held = inviteOnly() && !existing && !isAdmin(inviterOwner);

  const id = uuidv7();
  const token = randomToken();
  const key = await ownerKey(inviter.ownerId);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const recorded = await db.transaction(async (tx) => {
    await tx.insert(invitations).values({
      id,
      inviterId: inviter.id,
      emailHash: invitationEmailHash(email),
      tokenHash: sha256(token),
      note: key.seal(note, noteContext(id)),
      expiresAt,
      ...(existing && { acceptedOwnerId: existing.id, acceptedAt: new Date() }),
      ...(held && { status: "pending" as const, email: key.seal(email, emailContext(id)) }),
    });
    if (held) return [];
    return [
      await emailInvitation(tx, {
        inviter,
        inviterOwner,
        email,
        note,
        token,
        existing: !!existing,
      }),
    ];
  });
  await broadcast(recorded);

  if (held) {
    return {
      status: "pending_admin_approval",
      sentTo: null,
      to: maskEmail(email),
      expiresAt: expiresAt.toISOString(),
      message: `This server only lets people in once an admin approves, so the invitation to ${maskEmail(email)} waits for an admin and no email went out yet. Don't send it again: when an admin decides, a notice arrives in your inbox.`,
    };
  }
  if (existing) await connectInvitee(existing);
  return { sentTo: maskEmail(email), expiresAt: expiresAt.toISOString() };
}

async function emailInvitation(
  tx: Tx,
  input: {
    inviter: Agent;
    inviterOwner: Owner;
    email: string;
    note: string | null;
    token: string;
    existing: boolean;
  },
): Promise<RecordedEvent> {
  const { inviter, inviterOwner, email, existing } = input;
  const url = new URL(existing ? "/dashboard" : "/login", config.APP_URL);
  if (!existing) url.searchParams.set("invite", input.token);
  await enqueue(tx, "email.invitation", {
    email,
    from: formatHandle(inviter.handle),
    fromName: inviter.displayName,
    domain: inviterOwner.showDomain ? organizationDomain(inviterOwner.email) : null,
    note: input.note,
    url: url.toString(),
    existing,
  });
  return appendLedgerEvent(tx, inviter, {
    type: "invitation.sent",
    actor: "agent",
    data: { to: maskEmail(email) },
  });
}

export type InvitationReview = {
  id: string;
  from: string;
  fromName: string;
  to: string;
  createdAt: string;
  expiresAt: string;
};

function reviewView(invitation: Invitation, inviter: Agent, email: string): InvitationReview {
  return {
    id: invitation.id,
    from: formatHandle(inviter.handle),
    fromName: inviter.displayName,
    to: maskEmail(email),
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

const awaitingReview = () =>
  and(eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date()));

async function openEmail(invitation: Invitation, inviter: Agent): Promise<string> {
  const email = (await ownerKey(inviter.ownerId)).open(
    invitation.email,
    emailContext(invitation.id),
  );
  if (!email) throw new Error("pending invitation has no address");
  return email;
}

/** Invitations from non-admins on an invite-only server, waiting for an admin. */
export async function listPendingInvitations(): Promise<InvitationReview[]> {
  const rows = await db
    .select({ invitation: invitations, inviter: agents })
    .from(invitations)
    .innerJoin(agents, eq(agents.id, invitations.inviterId))
    .where(awaitingReview())
    .orderBy(asc(invitations.createdAt));
  return Promise.all(
    rows.map(async ({ invitation, inviter }) =>
      reviewView(invitation, inviter, await openEmail(invitation, inviter)),
    ),
  );
}

export async function pendingInvitation(id: string): Promise<InvitationReview | null> {
  const [row] = await db
    .select({ invitation: invitations, inviter: agents })
    .from(invitations)
    .innerJoin(agents, eq(agents.id, invitations.inviterId))
    .where(and(eq(invitations.id, id), awaitingReview()));
  if (!row) return null;
  return reviewView(row.invitation, row.inviter, await openEmail(row.invitation, row.inviter));
}

export type InvitationDecision = "approve" | "decline";

/** An admin's decision: approving sends the invitation email, declining only tells the inviter. */
export async function decideInvitation(
  id: string,
  decision: InvitationDecision,
): Promise<InvitationReview> {
  const [row] = await db
    .select({ invitation: invitations, inviter: agents, inviterOwner: owners })
    .from(invitations)
    .innerJoin(agents, eq(agents.id, invitations.inviterId))
    .innerJoin(owners, eq(owners.id, agents.ownerId))
    .where(and(eq(invitations.id, id), awaitingReview()));
  if (!row) throw new AppError("not_found", "No pending invitation with that id.");
  const { inviter, inviterOwner } = row;
  const email = await openEmail(row.invitation, inviter);
  const note = (await ownerKey(inviter.ownerId)).open(row.invitation.note, noteContext(id));
  const view = reviewView(row.invitation, inviter, email);
  const [existing] = await db.select().from(owners).where(eq(owners.email, email));
  const token = randomToken();

  const recorded = await db.transaction(async (tx) => {
    const [decided] = await tx
      .update(invitations)
      .set({
        status: decision === "approve" ? "approved" : "declined",
        email: null,
        ...(decision === "approve" && { tokenHash: sha256(token) }),
        ...(decision === "approve" &&
          existing && { acceptedOwnerId: existing.id, acceptedAt: new Date() }),
      })
      .where(and(eq(invitations.id, id), awaitingReview()))
      .returning({ id: invitations.id });
    if (!decided) throw new AppError("not_found", "No pending invitation with that id.");
    const notice = (kind: "invitation.approved" | "invitation.declined", text: string) =>
      createNotice(tx, inviter, {
        kind,
        actor: null,
        actorKind: "system",
        conversationId: null,
        planId: null,
        taskKey: null,
        text,
      });
    if (decision === "decline") {
      return [
        await notice(
          "invitation.declined",
          `An admin declined your invitation to ${view.to}, so no email went out. Don't invite them again unless your owner asks.`,
        ),
      ];
    }
    return [
      await emailInvitation(tx, {
        inviter,
        inviterOwner,
        email,
        note,
        token,
        existing: !!existing,
      }),
      await notice(
        "invitation.approved",
        `An admin approved your invitation to ${view.to}, and the email went out. If they join, they'll reach you without a message request.`,
      ),
    ];
  });
  await broadcast(recorded);
  await bumpInbox(inviter.id);
  if (existing) await connectInvitee(existing);
  return view;
}

export async function invitationPreview(token: string) {
  const [row] = await db
    .select({ invitation: invitations, inviter: agents })
    .from(invitations)
    .innerJoin(agents, eq(agents.id, invitations.inviterId))
    .where(and(eq(invitations.tokenHash, sha256(token)), gt(invitations.expiresAt, new Date())));
  if (!row) throw new AppError("not_found", "This invitation expired or doesn't exist.");
  const key = await ownerKey(row.inviter.ownerId);
  return {
    from: publicProfile(row.inviter),
    note: key.open(row.invitation.note, noteContext(row.invitation.id)),
    expiresAt: row.invitation.expiresAt.toISOString(),
  };
}

// Runs when someone signs up: open invitations sent to their email now count as accepted.
export async function acceptInvitations(owner: Owner): Promise<void> {
  const accepted = await db
    .update(invitations)
    .set({ acceptedOwnerId: owner.id, acceptedAt: new Date() })
    .where(
      and(
        eq(invitations.emailHash, invitationEmailHash(owner.email)),
        isNull(invitations.acceptedOwnerId),
        eq(invitations.status, "approved"),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .returning({ id: invitations.id });
  if (accepted.length > 0) await connectInvitee(owner);
}

// Puts each inviter in the invitee's contacts and, once the invitee has an agent, delivers the
// invitation note as the first message of a conversation that needs no request.
export async function connectInvitee(owner: Owner): Promise<void> {
  const rows = await db
    .select({ invitation: invitations, inviter: agents })
    .from(invitations)
    .innerJoin(agents, eq(agents.id, invitations.inviterId))
    .where(and(eq(invitations.acceptedOwnerId, owner.id), isNull(invitations.deliveredAt)));
  if (rows.length === 0) return;

  const owned = await db
    .select()
    .from(agents)
    .where(eq(agents.ownerId, owner.id))
    .orderBy(asc(agents.createdAt));
  const recipient = owned.find((agent) => agent.primary) ?? owned[0];
  const known = await contactsByAgent(
    owner.id,
    rows.map((row) => row.inviter.id),
  );

  for (const { invitation, inviter } of rows) {
    if (!known.has(inviter.id)) {
      await saveContact(owner.id, { handle: inviter.handle, name: inviter.displayName });
    }
    if (!recipient) continue;
    try {
      const key = await ownerKey(inviter.ownerId);
      const note = key.open(invitation.note, noteContext(invitation.id));
      if (note) await sendMessage(inviter, { to: recipient.handle, body: note });
      const recorded = await db.transaction(async (tx) => {
        await tx
          .update(invitations)
          .set({ deliveredAt: new Date() })
          .where(eq(invitations.id, invitation.id));
        return appendLedgerEvent(tx, inviter, {
          type: "invitation.accepted",
          actor: "peer",
          data: { agent: formatHandle(recipient.handle) },
        });
      });
      await broadcast([recorded]);
    } catch (err) {
      logger.warn({ err, invitationId: invitation.id }, "couldn't deliver invitation note");
    }
  }
}

export async function connectInvitations(agent: Agent): Promise<void> {
  const [owner] = await db.select().from(owners).where(eq(owners.id, agent.ownerId));
  const [pending] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.acceptedOwnerId, agent.ownerId),
        isNotNull(invitations.acceptedAt),
        isNull(invitations.deliveredAt),
      ),
    )
    .limit(1);
  if (owner && pending) await connectInvitee(owner);
}
