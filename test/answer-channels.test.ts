import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.ts";
import { db } from "../src/db/client.ts";
import { jobs, owners, type Owner } from "../src/db/schema.ts";
import {
  confirmAnswerAddress,
  requestAnswerAddress,
  resetAnswerAddress,
  sendAnswerTest,
  setAnswerChannels,
} from "../src/domain/answer-channels.ts";
import { raiseAlert } from "../src/domain/alerts.ts";
import { createSession } from "../src/domain/owners.ts";
import { askOwner } from "../src/domain/questions.ts";
import { unlinkTelegram } from "../src/domain/telegram.ts";
import { createApp } from "../src/http/app.ts";
import { sendMail, type Mail } from "../src/lib/mailer.ts";
import { createAgentWithToken } from "./helpers.ts";

vi.mock("../src/lib/mailer.ts", () => ({ sendMail: vi.fn(async () => {}) }));

type Call = { method: string; body: Record<string, unknown> };
const calls: Call[] = [];
let failSends = false;

const telegramApi = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const method = req.url?.split("/").at(-1) ?? "";
    calls.push({ method, body: JSON.parse(raw || "{}") as Record<string, unknown> });
    if (failSends && method === "sendMessage") {
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }));
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => telegramApi.listen(0, "127.0.0.1", resolve));
  config.TELEGRAM_API_URL = `http://127.0.0.1:${(telegramApi.address() as AddressInfo).port}`;
  config.TELEGRAM_BOT_TOKEN = "123:test";
});

afterAll(() => {
  config.TELEGRAM_BOT_TOKEN = undefined;
  telegramApi.close();
});

beforeEach(() => {
  calls.length = 0;
  failSends = false;
  vi.mocked(sendMail).mockClear();
});

function mails(): Mail[] {
  return vi.mocked(sendMail).mock.calls.map(([mail]) => mail);
}

async function linkTelegram(owner: Owner, chatId = "555"): Promise<Owner> {
  const [linked] = await db
    .update(owners)
    .set({ telegramChatId: chatId })
    .where(eq(owners.id, owner.id))
    .returning();
  return linked as Owner;
}

async function reload(owner: Owner): Promise<Owner> {
  const [row] = await db.select().from(owners).where(eq(owners.id, owner.id));
  return row as Owner;
}

async function jobKinds(kind: string) {
  return db.select().from(jobs).where(eq(jobs.kind, kind));
}

describe("answer channels", () => {
  it("sends questions only where the owner chose", async () => {
    const { owner, agent } = await createAgentWithToken("chooser");
    await setAnswerChannels(await linkTelegram(owner), { email: false, telegram: true });

    await askOwner(agent, { question: "Ship it?" });
    expect(await jobKinds("email.question")).toHaveLength(0);
    expect(await jobKinds("telegram.question")).toHaveLength(1);
  });

  it("falls back to email when the chosen channel can't reach the owner", async () => {
    const { owner, agent } = await createAgentWithToken("stranded");
    const linked = await linkTelegram(owner);
    await setAnswerChannels(linked, { email: false, telegram: true });
    await db.update(owners).set({ telegramChatId: null }).where(eq(owners.id, owner.id));

    await askOwner(agent, { question: "Ship it?" });
    expect(await jobKinds("email.question")).toHaveLength(1);
    expect(await jobKinds("telegram.question")).toHaveLength(0);
  });

  it("keeps at least one channel, and Telegram only while linked", async () => {
    const { owner } = await createAgentWithToken("careful");
    await expect(setAnswerChannels(owner, { email: false, telegram: false })).rejects.toThrow(
      /at least one/,
    );
    await expect(setAnswerChannels(owner, { telegram: true, email: false })).rejects.toThrow(
      /Link Telegram/,
    );
  });

  it("turns email back on when the only channel is unlinked, even if the bot can't write", async () => {
    const { owner } = await createAgentWithToken("unlinker");
    const linked = await setAnswerChannels(await linkTelegram(owner), {
      email: false,
      telegram: true,
    });
    failSends = true;
    await unlinkTelegram(linked);
    const after = await reload(owner);
    expect(after.telegramChatId).toBeNull();
    expect(after.answerEmail).toBe(true);
  });

  it("uses a new answer address only once its code is confirmed", async () => {
    const { owner, agent } = await createAgentWithToken("mover");
    await requestAnswerAddress(owner, "phone@example.com");
    const codeMail = mails().find((mail) => mail.to === "phone@example.com");
    const code = /\b(\d{6})\b/.exec(codeMail?.text ?? "")?.[1] ?? "";
    expect(code).toHaveLength(6);

    await askOwner(agent, { question: "Before?" });
    await expect(confirmAnswerAddress(owner, "000000")).rejects.toThrow(/code/);
    const confirmed = await confirmAnswerAddress(owner, code);
    expect(confirmed.answerEmailAddress).toBe("phone@example.com");
    await askOwner(agent, { question: "After?" });

    const sent = (await jobKinds("email.question")).map(
      (job) => (job.payload as { email: string }).email,
    );
    expect(sent).toEqual([owner.email, "phone@example.com"]);

    const reset = await resetAnswerAddress(confirmed);
    expect(reset.answerEmailAddress).toBeNull();
  });

  it("sends a test on the chosen channel", async () => {
    const { owner } = await createAgentWithToken("tester");
    await sendAnswerTest(owner, "email");
    expect(mails().map((mail) => mail.to)).toEqual([owner.email]);

    await expect(sendAnswerTest(owner, "telegram")).rejects.toThrow(/Link Telegram/);
    await sendAnswerTest(await linkTelegram(owner, "777"), "telegram");
    expect(calls.filter((call) => call.method === "sendMessage")).toMatchObject([
      { body: { chat_id: "777" } },
    ]);
  });

  it("lets the owner choose channels and test them from the account API", async () => {
    const { owner } = await createAgentWithToken("account_user");
    const app = createApp();
    const { sessionToken } = await createSession(db, owner.id);
    const auth = {
      cookie: `callsign_session=${sessionToken}`,
      "content-type": "application/json",
      origin: "http://localhost:3001",
    };

    const me = (await (await app.request("/v1/me", { headers: auth })).json()) as {
      owner: { answer: unknown };
    };
    expect(me.owner.answer).toEqual({
      email: true,
      telegram: false,
      push: false,
      address: owner.email,
      customAddress: false,
    });

    const refused = await app.request("/v1/me", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ answerEmail: false }),
    });
    expect(refused.status).toBe(400);

    await linkTelegram(owner);
    const chosen = await app.request("/v1/me", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ answerEmail: false, answerTelegram: true }),
    });
    expect(((await chosen.json()) as { owner: { answer: unknown } }).owner.answer).toMatchObject({
      email: false,
      telegram: true,
    });

    const test = await app.request("/v1/me/answer-test", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "telegram" }),
    });
    expect(await test.json()).toEqual({ sent: true });
  });

  it("still emails security alerts when email is off for questions", async () => {
    const { owner, agent } = await createAgentWithToken("alerted");
    await setAnswerChannels(await linkTelegram(owner), { email: false, telegram: true });
    await raiseAlert({ agent, kind: "burst", details: { messages: 50 } });
    const alertJobs = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "alert.email")));
    expect(alertJobs).toHaveLength(1);
  });
});
