import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { db } from "../src/db/client.ts";
import { jobs, owners, type Owner } from "../src/db/schema.ts";
import { checkInbox } from "../src/domain/messaging.ts";
import { createSession } from "../src/domain/owners.ts";
import { askOwner } from "../src/domain/questions.ts";
import { createApp } from "../src/http/app.ts";
import { telegramWebhookSecret } from "../src/lib/telegram.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { createAgentWithToken } from "./helpers.ts";

type Call = { method: string; body: Record<string, unknown>; messageId?: number };

const calls: Call[] = [];
let nextMessageId = 100;
const telegramApi = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const method = req.url?.split("/").at(-1) ?? "";
    const messageId = method === "sendMessage" ? nextMessageId++ : undefined;
    calls.push({ method, body: JSON.parse(raw || "{}") as Record<string, unknown>, messageId });
    const result =
      method === "getMe"
        ? { username: "callsign_test_bot" }
        : messageId
          ? { message_id: messageId }
          : true;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, result }));
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => telegramApi.listen(0, "127.0.0.1", resolve));
  config.TELEGRAM_API_URL = `http://127.0.0.1:${(telegramApi.address() as AddressInfo).port}`;
});

afterAll(() => {
  config.TELEGRAM_BOT_TOKEN = undefined;
  telegramApi.close();
});

async function drainJobs() {
  while ((await processDueJobs()) > 0);
}

async function headers(owner: Owner) {
  const { sessionToken } = await createSession(db, owner.id);
  return {
    cookie: `callsign_session=${sessionToken}`,
    "content-type": "application/json",
    origin: "http://localhost:3001",
  };
}

function webhook(
  app: ReturnType<typeof createApp>,
  update: object,
  secret = telegramWebhookSecret(),
) {
  return app.request("/v1/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
  });
}

describe("answering from a phone", () => {
  it("answers in the signed-in app, with no answer link in the email", async () => {
    const { owner, agent } = await createAgentWithToken("alice_agent");
    const asked = await askOwner(agent, {
      question: "Share the Q3 budget with @bob_agent?",
      options: ["Yes", "Only the ads line", "No"],
    });
    expect(asked.options).toEqual(["Yes", "Only the ads line", "No"]);
    const [email] = await db.select().from(jobs).where(eq(jobs.kind, "email.question"));
    expect(JSON.stringify(email?.payload)).not.toContain("answer?token");

    const app = createApp();
    const response = await app.request(`/v1/questions/${asked.id}`, {
      method: "POST",
      headers: await headers(owner),
      body: JSON.stringify({ option: 1 }),
    });
    expect(((await response.json()) as { answer: string }).answer).toBe("Only the ads line");
    expect((await checkInbox(agent)).ownerAnswers).toMatchObject([
      { questionId: asked.id, answer: "Only the ads line" },
    ]);
  });

  it("rejects options that don't make a choice", async () => {
    const { agent } = await createAgentWithToken("alice_agent");
    await expect(askOwner(agent, { question: "Ok?", options: ["Yes"] })).rejects.toThrow(
      /at least two/,
    );
    await expect(
      askOwner(agent, { question: "Ok?", options: ["a", "b", "c", "d", "e"] }),
    ).rejects.toThrow(/at most 4/);
  });

  it("links a Telegram chat and answers with a tap or a reply", async () => {
    config.TELEGRAM_BOT_TOKEN = "123:test";
    calls.splice(0);
    const { owner, agent } = await createAgentWithToken("alice_agent");
    const app = createApp();
    const auth = await headers(owner);

    const me = (await (await app.request("/v1/me", { headers: auth })).json()) as {
      owner: { telegram: { linked: boolean } };
    };
    expect(me.owner.telegram).toEqual({ linked: false });
    const link = (await (
      await app.request("/v1/me/telegram", { method: "POST", headers: auth })
    ).json()) as { url: string };
    expect(link.url).toMatch(/^https:\/\/t\.me\/callsign_test_bot\?start=/);
    const code = new URL(link.url).searchParams.get("start");

    expect((await webhook(app, {}, "wrong")).status).toBe(404);
    const chat = { id: 555, type: "private" };
    await webhook(app, { message: { message_id: 1, chat, text: `/start ${code}` } });
    const [linked] = await db.select().from(owners).where(eq(owners.id, owner.id));
    expect(linked?.telegramChatId).toBe("555");
    expect(calls.at(-1)?.body.text).toContain("Connected");

    const asked = await askOwner(agent, {
      question: "Accept @carol_agent?",
      options: ["Yes", "No"],
    });
    await drainJobs();
    const sent = calls.findLast((call) => call.method === "sendMessage");
    expect(String(sent?.body.text)).not.toContain("carol");
    expect(sent?.body).toMatchObject({
      chat_id: "555",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Open in Callsign",
              url: `http://localhost:3001/dashboard/questions?question=${asked.id}`,
            },
          ],
        ],
      },
    });

    await webhook(app, { message: { message_id: 8, chat, text: "/stop" } });
    const [unlinked] = await db.select().from(owners).where(eq(owners.id, owner.id));
    expect(unlinked?.telegramChatId).toBeNull();
  });
});
