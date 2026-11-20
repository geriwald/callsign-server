import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import {
  agents,
  ownerQuestions,
  owners,
  pushSubscriptions,
  type Owner,
  type PushSubscription,
} from "../db/schema.ts";
import { randomToken } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { pushEnabled, sendPush, type PushPayload } from "../lib/push.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { redis } from "../lib/redis.ts";
import { answerTargets } from "./answer-channels.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { holdForApprover } from "./holds.ts";
import { ownerKey } from "./keys.ts";
import { openQuestion, questionIsConfidential } from "./questions.ts";

const TEST_TTL_SECONDS = 15 * 60;
const testKey = (token: string) => `push-test:${token}`;

const subscriptionSchema = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
  label: z.string().trim().min(1).max(80),
});

function deviceView(row: PushSubscription) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    tested: row.testedAt !== null,
  };
}

export function pushPublicKey(): string | null {
  return pushEnabled() ? (config.VAPID_PUBLIC_KEY ?? null) : null;
}

export async function listPushDevices(owner: Owner) {
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.ownerId, owner.id))
    .orderBy(pushSubscriptions.createdAt);
  return rows.map(deviceView);
}

export async function subscribePush(owner: Owner, input: unknown) {
  if (!pushEnabled()) throw new AppError("not_found", "Push notifications aren't set up here.");
  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", "That isn't a push subscription.");
  const { endpoint, keys, label } = parsed.data;
  await rateLimit(`push-subscribe:${owner.id}`, 20, 3600);
  // A browser keeps its endpoint across sign-ins, so the latest owner takes it over, untested.
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      id: uuidv7(),
      ownerId: owner.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      label,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { ownerId: owner.id, p256dh: keys.p256dh, auth: keys.auth, label, testedAt: null },
    })
    .returning();
  if (!row) throw new Error("push subscription insert returned no row");
  return deviceView(row);
}

/**
 * Forgets a device. When no tested device is left and the web app was on, it turns off, and
 * email turns back on if nothing else reaches the owner.
 */
async function forgetDevice(ownerId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
    const [left] = await tx
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.ownerId, ownerId), isNotNull(pushSubscriptions.testedAt)))
      .limit(1);
    if (left) return;
    const [owner] = await tx.select().from(owners).where(eq(owners.id, ownerId)).for("update");
    if (!owner?.answerPush) return;
    const telegram = owner.answerTelegram && owner.telegramChatId !== null;
    await tx
      .update(owners)
      .set({ answerPush: false, answerEmail: owner.answerEmail || !telegram })
      .where(eq(owners.id, ownerId));
  });
}

async function ownedDevice(owner: Owner, id: string): Promise<PushSubscription> {
  const [row] = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.ownerId, owner.id)));
  if (!row) throw new AppError("not_found", "Device not found.");
  return row;
}

export async function removePushDevice(owner: Owner, id: string): Promise<void> {
  await ownedDevice(owner, id);
  await forgetDevice(owner.id, id);
}

async function deliver(row: PushSubscription, payload: PushPayload): Promise<boolean> {
  const result = await sendPush(row, payload);
  if (result === "gone") await forgetDevice(row.ownerId, row.id);
  return result === "sent";
}

export async function sendPushTest(
  owner: Owner,
  id: string,
  kind: "notification" | "question",
): Promise<void> {
  const row = await ownedDevice(owner, id);
  await rateLimit(`push-test:${owner.id}`, 10, 600);
  let payload: PushPayload = {
    title: "@hello",
    body: "Test: notifications work.",
    url: "/dashboard/account",
    tag: "test",
  };
  if (kind === "question") {
    const token = randomToken();
    await redis.set(testKey(token), row.id, "EX", TEST_TTL_SECONDS);
    payload = {
      title: "@hello asks",
      body: "Test question: tap to confirm.",
      url: `/dashboard/account?push-test=${token}`,
      tag: "test",
    };
  }
  if (!(await deliver(row, payload))) {
    throw new AppError(
      "not_found",
      "This device stopped accepting notifications. Turn them on again.",
    );
  }
}

/** The tapped test notification opened the signed-in app: this device is proven. */
export async function confirmPushTest(owner: Owner, token: string): Promise<void> {
  const id = await redis.get(testKey(token));
  if (!id) throw new AppError("invalid_input", "This test has expired. Send a new one.");
  const [row] = await db
    .update(pushSubscriptions)
    .set({ testedAt: new Date() })
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.ownerId, owner.id)))
    .returning();
  if (!row) throw new AppError("not_found", "Device not found.");
  await redis.del(testKey(token));
}

async function pushToOwner(ownerId: string, payload: PushPayload): Promise<void> {
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.ownerId, ownerId), isNotNull(pushSubscriptions.testedAt)));
  await Promise.allSettled(rows.map((row) => deliver(row, payload)));
}

export async function sendQuestionPush({ questionId }: { questionId: string }): Promise<void> {
  const [found] = await db
    .select({ question: ownerQuestions, agent: agents, owner: owners })
    .from(ownerQuestions)
    .innerJoin(agents, eq(agents.id, ownerQuestions.agentId))
    .innerJoin(owners, eq(owners.id, agents.ownerId))
    .where(eq(ownerQuestions.id, questionId));
  if (!found || found.question.answeredAt) return;
  const handle = formatHandle(found.agent.handle);
  const url = `/dashboard?question=${questionId}`;
  if (await questionIsConfidential(found.question.conversationId, found.owner)) {
    await pushToOwner(found.owner.id, {
      title: `${handle} has a question`,
      body: "Confidential: tap to read.",
      url,
      tag: questionId,
    });
    return;
  }
  const { question } = openQuestion(await ownerKey(found.owner.id), found.question);
  await pushToOwner(found.owner.id, {
    title: `${handle} asks`,
    body: question,
    url,
    tag: questionId,
  });
}

export async function sendHoldPush({ holdId }: { holdId: string }): Promise<void> {
  const found = await holdForApprover(holdId);
  if (!found || !answerTargets(found.owner).push) return;
  await pushToOwner(found.owner.id, {
    title: `${found.view.agent} needs approval`,
    body: found.confidential ? "Confidential: tap to review." : found.outline,
    url: "/dashboard/approvals",
    tag: holdId,
  });
}
