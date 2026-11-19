import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { owners, type Owner } from "../db/schema.ts";
import { safeEqual, sha256 } from "../lib/crypto.ts";
import { sendMail } from "../lib/mailer.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { redis } from "../lib/redis.ts";
import { telegram, telegramEnabled } from "../lib/telegram.ts";
import { AppError } from "./errors.ts";

const CODE_TTL_SECONDS = 15 * 60;
const codeKey = (ownerId: string) => `answer-address:${ownerId}`;

export type AnswerTargets = { email: string | null; telegramChatId: string | null };

function telegramReachable(owner: Owner): boolean {
  return owner.telegramChatId !== null && telegramEnabled();
}

/**
 * Where a question or an approval reaches the owner now. When none of the chosen channels can
 * reach them (Telegram chosen but unlinked), email takes over so nothing is lost.
 */
export function answerTargets(owner: Owner): AnswerTargets {
  const telegramChatId =
    owner.answerTelegram && telegramReachable(owner) ? owner.telegramChatId : null;
  const email = owner.answerEmail || !telegramChatId ? answerAddress(owner) : null;
  return { email, telegramChatId };
}

export function answerAddress(owner: Owner): string {
  return owner.answerEmailAddress ?? owner.email;
}

export function answerView(owner: Owner) {
  return {
    email: owner.answerEmail,
    telegram: owner.answerTelegram && telegramReachable(owner),
    address: answerAddress(owner),
    customAddress: owner.answerEmailAddress !== null,
  };
}

async function save(owner: Owner, fields: Partial<Owner>): Promise<Owner> {
  const [updated] = await db.update(owners).set(fields).where(eq(owners.id, owner.id)).returning();
  if (!updated) throw new AppError("not_found", "Account not found.");
  return updated;
}

export async function setAnswerChannels(
  owner: Owner,
  input: { email?: boolean | undefined; telegram?: boolean | undefined },
): Promise<Owner> {
  const email = input.email ?? owner.answerEmail;
  const wantsTelegram = input.telegram ?? (owner.answerTelegram && telegramReachable(owner));
  if (wantsTelegram && !telegramReachable(owner)) {
    throw new AppError("invalid_input", "Link Telegram before you choose it.");
  }
  if (!email && !wantsTelegram) {
    throw new AppError("invalid_input", "Keep at least one way to answer your agents.");
  }
  return save(owner, { answerEmail: email, answerTelegram: wantsTelegram });
}

export async function requestAnswerAddress(owner: Owner, address: string): Promise<void> {
  const email = z.email().safeParse(address.trim().toLowerCase());
  if (!email.success) throw new AppError("invalid_input", "That isn't an email address.");
  await rateLimit(`answer-address:${owner.id}`, 5, 3600);
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await redis.set(
    codeKey(owner.id),
    JSON.stringify({ address: email.data, codeHash: sha256(code) }),
    "EX",
    CODE_TTL_SECONDS,
  );
  await sendMail({
    to: email.data,
    subject: "Your Callsign confirmation code",
    text: [
      `Your code is ${code}.`,
      "",
      `Type it on the Account page of your Callsign dashboard to receive your agents' questions at this address. It expires in 15 minutes.`,
      "",
      `If you didn't ask for it, ignore this email: nothing changes.`,
    ].join("\n"),
  });
}

export async function confirmAnswerAddress(owner: Owner, code: string): Promise<Owner> {
  await rateLimit(`answer-address-confirm:${owner.id}`, 10, 900);
  const raw = await redis.get(codeKey(owner.id));
  const pending = raw ? (JSON.parse(raw) as { address: string; codeHash: string }) : null;
  if (!pending || !safeEqual(pending.codeHash, sha256(code.trim()))) {
    throw new AppError("invalid_input", "That code is wrong or has expired.");
  }
  await redis.del(codeKey(owner.id));
  return save(owner, {
    answerEmailAddress: pending.address === owner.email ? null : pending.address,
  });
}

export async function resetAnswerAddress(owner: Owner): Promise<Owner> {
  await redis.del(codeKey(owner.id));
  return save(owner, { answerEmailAddress: null });
}

export async function sendAnswerTest(owner: Owner, channel: "email" | "telegram"): Promise<void> {
  if (channel === "telegram" && !telegramReachable(owner)) {
    throw new AppError("invalid_input", "Link Telegram before you test it.");
  }
  await rateLimit(`answer-test:${owner.id}`, 5, 600);
  const text =
    "Test from your Callsign dashboard: your agents' questions and approvals can reach you here.";
  if (channel === "email") {
    await sendMail({ to: answerAddress(owner), subject: "Callsign test", text });
    return;
  }
  await telegram("sendMessage", { chat_id: owner.telegramChatId, text });
}
