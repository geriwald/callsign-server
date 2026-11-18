import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db, type Executor } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  owners,
  type Agent,
  type Conversation,
} from "../db/schema.ts";
import { findAgentByHandle } from "./agents.ts";
import { directKey } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { isGroupRef, normalizeGroupName } from "./groups.ts";
import { normalizeHandle } from "./handles.ts";

// A member who left or was removed no longer keeps the conversation confidential.
const GONE = ["left", "removed"];

export type Confidentiality = { confidential: boolean; myConfidential: boolean };

/** A conversation is confidential as soon as one member's owner flagged it. */
export async function isConfidential(
  conversationId: string,
  executor: Executor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ agentId: conversationMembers.agentId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.confidential, true),
        notInArray(conversationMembers.status, GONE),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether these owners' defaults make something outside an existing conversation confidential. */
export async function confidentialByDefault(ownerIds: string[]): Promise<boolean> {
  if (ownerIds.length === 0) return false;
  const [row] = await db
    .select({ id: owners.id })
    .from(owners)
    .where(and(inArray(owners.id, [...new Set(ownerIds)]), eq(owners.confidentialDefault, true)))
    .limit(1);
  return row !== undefined;
}

/** The conversation an agent belongs to with a peer handle or a #group, if there is one. */
export async function findConversation(
  agent: Agent,
  ref: string,
): Promise<Conversation | undefined> {
  if (isGroupRef(ref)) {
    const [row] = await db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, conversations.id),
          eq(conversationMembers.agentId, agent.id),
        ),
      )
      .where(and(eq(conversations.kind, "group"), eq(conversations.name, normalizeGroupName(ref))));
    return row?.conversation;
  }
  const peer = await findAgentByHandle(normalizeHandle(ref));
  if (!peer) return undefined;
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.directKey, directKey(agent.id, peer.id)));
  return conversation;
}

/** For each conversation, whether it is confidential and whether this owner's flag is on. */
export async function confidentialityFor(
  ownerId: string,
  conversationIds: string[],
): Promise<Map<string, Confidentiality>> {
  const found = new Map<string, Confidentiality>();
  if (conversationIds.length === 0) return found;
  const rows = await db
    .select({
      conversationId: conversationMembers.conversationId,
      ownerId: agents.ownerId,
      status: conversationMembers.status,
      confidential: conversationMembers.confidential,
    })
    .from(conversationMembers)
    .innerJoin(agents, eq(agents.id, conversationMembers.agentId))
    .where(inArray(conversationMembers.conversationId, conversationIds));
  for (const id of conversationIds) found.set(id, { confidential: false, myConfidential: false });
  for (const row of rows) {
    const entry = found.get(row.conversationId);
    if (!entry || !row.confidential) continue;
    if (!GONE.includes(row.status)) entry.confidential = true;
    if (row.ownerId === ownerId) entry.myConfidential = true;
  }
  return found;
}

/** Sets the owner's flag on a conversation, for every one of their agents in it. */
export async function setConfidential(
  agent: Agent,
  ref: string,
  confidential: boolean,
): Promise<Confidentiality> {
  const conversation = await findConversation(agent, ref);
  if (!conversation) throw new AppError("not_found", "Conversation not found.");
  await db
    .update(conversationMembers)
    .set({ confidential })
    .where(
      and(
        eq(conversationMembers.conversationId, conversation.id),
        inArray(
          conversationMembers.agentId,
          db.select({ id: agents.id }).from(agents).where(eq(agents.ownerId, agent.ownerId)),
        ),
      ),
    );
  const result = (await confidentialityFor(agent.ownerId, [conversation.id])).get(conversation.id);
  return result ?? { confidential, myConfidential: confidential };
}
