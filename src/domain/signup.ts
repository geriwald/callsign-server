import { and, eq, gt } from "drizzle-orm";
import { config } from "../config.ts";
import type { Executor } from "../db/client.ts";
import { invitations, owners } from "../db/schema.ts";
import { sha256 } from "../lib/crypto.ts";

export const invitationEmailHash = (email: string) => sha256(`invitation:${email}`);

export function inviteOnly(): boolean {
  return config.SIGNUP_MODE === "invite";
}

/**
 * Whether this email may have an account. Always true on an open server; on an invite-only one,
 * only for owners, admins and people with an approved, unexpired invitation.
 */
export async function canSignIn(executor: Executor, email: string): Promise<boolean> {
  if (!inviteOnly() || config.ADMIN_EMAILS.includes(email)) return true;
  const [owner] = await executor
    .select({ id: owners.id })
    .from(owners)
    .where(eq(owners.email, email));
  if (owner) return true;
  const [invited] = await executor
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.emailHash, invitationEmailHash(email)),
        eq(invitations.status, "approved"),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invited !== undefined;
}
