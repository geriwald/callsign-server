import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.ts";
import { db } from "../src/db/client.ts";
import { agents, heldActions, jobs, ownerQuestions, owners, type Owner } from "../src/db/schema.ts";
import { createAgent } from "../src/domain/agents.ts";
import { setConfidential } from "../src/domain/confidential.ts";
import { createGroup, leaveGroup } from "../src/domain/groups.ts";
import { maybeHold } from "../src/domain/holds.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { createSession } from "../src/domain/owners.ts";
import { answerQuestion, askOwner } from "../src/domain/questions.ts";
import { createApp } from "../src/http/app.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { uuidv7 } from "../src/lib/ids.ts";
import { sendMail, type Mail } from "../src/lib/mailer.ts";
import { telegramWebhookSecret } from "../src/lib/telegram.ts";
import { createAgentWithToken, createOwner, startServer } from "./helpers.ts";

vi.mock("../src/lib/mailer.ts", () => ({ sendMail: vi.fn(async () => {}) }));

// Every test that checks a leak sends this through each field and looks for it in what left.
const MARKER = "ZEBRA-7731-SECRET";

type TelegramCall = { method: string; body: Record<string, unknown> };
const telegramCalls: TelegramCall[] = [];
let nextMessageId = 100;
const telegramApi = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const method = req.url?.split("/").at(-1) ?? "";
    telegramCalls.push({ method, body: JSON.parse(raw || "{}") as Record<string, unknown> });
    const result = method === "sendMessage" ? { message_id: nextMessageId++ } : true;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, result }));
  });
});

const app = createApp();
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
  await new Promise<void>((resolve) => telegramApi.listen(0, "127.0.0.1", resolve));
  config.TELEGRAM_API_URL = `http://127.0.0.1:${(telegramApi.address() as AddressInfo).port}`;
});

afterAll(async () => {
  config.TELEGRAM_BOT_TOKEN = undefined;
  telegramApi.close();
  await server.close();
});

function mails(): Mail[] {
  return vi.mocked(sendMail).mock.calls.map(([mail]) => mail);
}

function telegramMessages(): TelegramCall[] {
  return telegramCalls.filter((call) => call.method === "sendMessage");
}

/** Everything that left the server for Telegram or the mail transport. */
function outbound(): string {
  return JSON.stringify({ telegram: telegramCalls, mail: mails() });
}

async function drainJobs() {
  while ((await processDueJobs()) > 0);
}

async function linkTelegram(owner: Owner, chatId: string) {
  await db.update(owners).set({ telegramChatId: chatId }).where(eq(owners.id, owner.id));
}

function resetOutbound() {
  telegramCalls.splice(0);
  vi.mocked(sendMail).mockClear();
}

async function mcp(token: string) {
  const client = new Client({ name: "confidential-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

function asAgent(token: string, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  config.CONFIDENTIAL_DEFAULT = false;
});

async function dashboard(owner: Owner, path: string, body?: unknown, method = "GET") {
  const { sessionToken } = await createSession(db, owner.id);
  const res = await app.request(path, {
    method,
    headers: {
      cookie: `callsign_session=${sessionToken}`,
      origin: "http://localhost:3001",
      "content-type": "application/json",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function setDefault(owner: Owner, confidentialDefault: boolean) {
  await db.update(owners).set({ confidentialDefault }).where(eq(owners.id, owner.id));
}

async function flags(owner: Owner, handle: string, peer: string) {
  const { body } = await dashboard(owner, `/v1/agents/${handle}/conversations/${peer}`);
  return { confidential: body.confidential, myConfidential: body.myConfidential };
}

describe("confidentiality settings", () => {
  it("gives a new owner the instance default, which they can change", async () => {
    expect((await createOwner()).confidentialDefault).toBe(false);
    config.CONFIDENTIAL_DEFAULT = true;
    const owner = await createOwner();
    expect(owner.confidentialDefault).toBe(true);

    const me = await dashboard(owner, "/v1/me");
    expect(me.body.owner).toMatchObject({ confidentialDefault: true });
    const changed = await dashboard(owner, "/v1/me", { confidentialDefault: false }, "PATCH");
    expect(changed.body.owner).toMatchObject({ confidentialDefault: false });
    const [stored] = await db.select().from(owners).where(eq(owners.id, owner.id));
    expect(stored?.confidentialDefault).toBe(false);
  });

  it("starts a new conversation with each owner's default", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    const carol = await createAgentWithToken("carol_agent");
    await setDefault(alice.owner, true);

    await sendMessage(alice.agent, { to: "@bob_agent", body: "Hello" });
    await sendMessage(carol.agent, { to: "@bob_agent", body: "Hello" });
    expect(await flags(alice.owner, "alice_agent", "@bob_agent")).toEqual({
      confidential: true,
      myConfidential: true,
    });
    expect(await flags(bob.owner, "bob_agent", "@alice_agent")).toEqual({
      confidential: true,
      myConfidential: false,
    });
    expect(await flags(bob.owner, "bob_agent", "@carol_agent")).toEqual({
      confidential: false,
      myConfidential: false,
    });

    const list = await dashboard(bob.owner, "/v1/agents/bob_agent/conversations");
    const listed = list.body.conversations as {
      with: { handle: string };
      confidential: boolean;
      myConfidential: boolean;
    }[];
    expect(
      listed
        .map(({ with: peer, confidential, myConfidential }) => ({
          handle: peer.handle,
          confidential,
          myConfidential,
        }))
        .sort((a, b) => a.handle.localeCompare(b.handle)),
    ).toEqual([
      { handle: "@alice_agent", confidential: true, myConfidential: false },
      { handle: "@carol_agent", confidential: false, myConfidential: false },
    ]);
  });

  it("starts a group with each member's default", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    await createAgentWithToken("carol_agent");
    await setDefault(bob.owner, true);

    await createGroup(alice.agent, { name: "launch", members: ["@bob_agent"] });
    await createGroup(alice.agent, { name: "quiet", members: ["@carol_agent"] });
    expect(await flags(alice.owner, "alice_agent", "%23launch")).toEqual({
      confidential: true,
      myConfidential: false,
    });
    expect(await flags(alice.owner, "alice_agent", "%23quiet")).toEqual({
      confidential: false,
      myConfidential: false,
    });
  });

  it("is confidential as soon as one member's flag is on", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    const second = await createAgent(bob.owner, { handle: "bob_second", product: "custom" });
    await sendMessage(alice.agent, { to: "@bob_agent", body: "Hello" });
    await createGroup(alice.agent, { name: "launch", members: ["@bob_agent", "@bob_second"] });

    const set = await dashboard(
      bob.owner,
      "/v1/agents/bob_agent/conversations/@alice_agent",
      { confidential: true },
      "PATCH",
    );
    expect(set.body).toEqual({ confidential: true, myConfidential: true });
    expect(await flags(alice.owner, "alice_agent", "@bob_agent")).toEqual({
      confidential: true,
      myConfidential: false,
    });

    await dashboard(
      alice.owner,
      "/v1/agents/alice_agent/conversations/@bob_agent",
      { confidential: false },
      "PATCH",
    );
    expect((await flags(alice.owner, "alice_agent", "@bob_agent")).confidential).toBe(true);
    await dashboard(
      bob.owner,
      "/v1/agents/bob_agent/conversations/@alice_agent",
      { confidential: false },
      "PATCH",
    );
    expect((await flags(alice.owner, "alice_agent", "@bob_agent")).confidential).toBe(false);

    // The flag belongs to the owner, so it covers every one of their agents in the group.
    await dashboard(
      bob.owner,
      "/v1/agents/bob_agent/conversations/%23launch",
      { confidential: true },
      "PATCH",
    );
    expect(await flags(bob.owner, "bob_second", "%23launch")).toEqual({
      confidential: true,
      myConfidential: true,
    });
    await leaveGroup(second, "#launch", "owner");
    await leaveGroup(bob.agent, "#launch", "owner");
    expect((await flags(alice.owner, "alice_agent", "%23launch")).confidential).toBe(false);
  });

  it("refuses to flag a conversation that doesn't exist", async () => {
    const alice = await createAgentWithToken("alice_agent");
    await createAgentWithToken("bob_agent");
    const res = await dashboard(
      alice.owner,
      "/v1/agents/alice_agent/conversations/@bob_agent",
      { confidential: true },
      "PATCH",
    );
    expect(res.status).toBe(404);
  });
});

describe("questions about a conversation", () => {
  it("ties a question to a conversation the agent is in, over MCP and REST", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    const sent = await sendMessage(alice.agent, { to: "@bob_agent", body: "Hello" });
    await createGroup(alice.agent, { name: "launch", members: ["@bob_agent"] });

    const client = await mcp(alice.token);
    const asked = await client.callTool({
      name: "ask_owner",
      arguments: { question: "Can I tell Bob?", conversation: "@bob_agent" },
    });
    expect(asked.isError).toBeFalsy();
    const missing = await client.callTool({
      name: "ask_owner",
      arguments: { question: "And Carol?", conversation: "@carol_agent" },
    });
    expect(missing.isError).toBe(true);
    await client.close();

    const rest = await asAgent(bob.token, "/v1/agent/questions", {
      question: "Post in the group?",
      conversation: "#launch",
    });
    expect(rest.status).toBe(201);
    const rows = await db.select().from(ownerQuestions);
    const group = await db.query.conversations.findFirst({
      where: (conversations, { eq }) => eq(conversations.name, "launch"),
    });
    expect(rows.map((row) => row.conversationId).sort()).toEqual(
      [sent.conversationId, group?.id].sort(),
    );
  });
});

describe("question notifications", () => {
  beforeEach(() => {
    config.TELEGRAM_BOT_TOKEN = "123:test";
    resetOutbound();
  });

  afterEach(() => {
    config.TELEGRAM_BOT_TOKEN = undefined;
  });

  const secretQuestion = {
    question: `Can I share ${MARKER}?`,
    context: `Background: ${MARKER}`,
    options: [`Yes, share ${MARKER}`, "No"],
  };

  it("leaves the content out when another member keeps the conversation confidential", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    await linkTelegram(alice.owner, "555");
    await sendMessage(alice.agent, { to: "@bob_agent", body: "Hello" });
    await setConfidential(bob.agent, "@alice_agent", true);

    const asked = await askOwner(alice.agent, { ...secretQuestion, conversation: "@bob_agent" });
    const queued = await db.select().from(jobs);
    expect(JSON.stringify(queued)).not.toContain(MARKER);
    await drainJobs();

    expect(mails()).toHaveLength(1);
    expect(telegramMessages()).toHaveLength(1);
    expect(outbound()).not.toContain(MARKER);
    const [mail] = mails();
    expect(mail?.to).toBe(alice.owner.email);
    expect(mail?.text).toContain(`/dashboard?question=${asked.id}`);
    expect(mail?.text).not.toContain("/answer");
    const [telegram] = telegramMessages();
    expect(telegram?.body.text).toContain("@alice_agent");
    expect(telegram?.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: "Open in the dashboard",
            url: `http://localhost:3001/dashboard?question=${asked.id}`,
          },
        ],
      ],
    });

    await answerQuestion(alice.owner.id, asked.id, { option: 1 });
    expect((await checkInbox(alice.agent)).ownerAnswers).toMatchObject([{ answer: "No" }]);
  });

  it("follows the owner's default for a question about no conversation", async () => {
    const alice = await createAgentWithToken("alice_agent");
    await linkTelegram(alice.owner, "555");
    await db.update(owners).set({ confidentialDefault: true }).where(eq(owners.id, alice.owner.id));
    await askOwner(alice.agent, secretQuestion);
    await drainJobs();
    expect(mails()).toHaveLength(1);
    expect(telegramMessages()).toHaveLength(1);
    expect(outbound()).not.toContain(MARKER);

    resetOutbound();
    await db
      .update(owners)
      .set({ confidentialDefault: false })
      .where(eq(owners.id, alice.owner.id));
    await askOwner(alice.agent, secretQuestion);
    await drainJobs();
    expect(mails()[0]?.text).toContain(MARKER);
    expect(telegramMessages()[0]?.body.text).toContain(MARKER);
  });

  it("notifies as before about a conversation that isn't confidential", async () => {
    const alice = await createAgentWithToken("alice_agent");
    await createAgentWithToken("bob_agent");
    await linkTelegram(alice.owner, "555");
    await sendMessage(alice.agent, { to: "@bob_agent", body: "Hello" });

    const about = await askOwner(alice.agent, { ...secretQuestion, conversation: "@bob_agent" });
    await drainJobs();
    const withConversation = { mail: mails()[0], telegram: telegramMessages()[0]?.body };
    resetOutbound();
    const plain = await askOwner(alice.agent, secretQuestion);
    await drainJobs();
    const without = { mail: mails()[0], telegram: telegramMessages()[0]?.body };

    // Only the ids and the one-time answer links differ.
    const normalize = (value: unknown, id: string) =>
      JSON.stringify(value)
        .replaceAll(id, "ID")
        .replace(/token=[\w-]+/g, "token=T");
    expect(normalize(withConversation, about.id)).toBe(normalize(without, plain.id));
    expect(withConversation.mail?.text).toContain(MARKER);
    expect(withConversation.mail?.text).toContain("/answer?token=");
    expect(JSON.stringify(withConversation.telegram)).toContain(`answer:${about.id}:0`);
  });
});

describe("held action notifications", () => {
  beforeEach(() => {
    config.TELEGRAM_BOT_TOKEN = "123:test";
    resetOutbound();
  });

  afterEach(() => {
    config.TELEGRAM_BOT_TOKEN = undefined;
  });

  async function withPolicy(handle: string, holds: Record<string, unknown>) {
    const created = await createAgentWithToken(handle);
    await db.update(agents).set({ policy: { holds } }).where(eq(agents.id, created.agent.id));
    const [agent] = await db.select().from(agents).where(eq(agents.id, created.agent.id));
    await linkTelegram(created.owner, "555");
    return { ...created, agent: agent! };
  }

  async function holdMessage(token: string, to: string) {
    const res = await asAgent(token, "/v1/agent/messages", { to, body: `Pricing: ${MARKER}` });
    expect(res.status).toBe(202);
    return ((await res.json()) as { holdId: string }).holdId;
  }

  function telegramUpdate(update: object) {
    return app.request("/v1/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": telegramWebhookSecret(),
      },
      body: JSON.stringify(update),
    });
  }

  async function tap(holdId: string, action: "ha" | "hd") {
    telegramCalls.splice(0);
    await telegramUpdate({
      callback_query: {
        id: `cb-${action}`,
        data: `${action}:${holdId}`,
        message: { message_id: 100, chat: { id: 555, type: "private" }, text: "held" },
      },
    });
    return telegramCalls.find((call) => call.method === "answerCallbackQuery")?.body.text;
  }

  async function status(holdId: string) {
    const [row] = await db.select().from(heldActions).where(eq(heldActions.id, holdId));
    return row?.status;
  }

  it("leaves the message out when another member keeps the conversation confidential", async () => {
    const alice = await withPolicy("alice_agent", { hourlyMessages: 1 });
    const bob = await createAgentWithToken("bob_agent");
    await sendMessage(alice.agent, { to: "@bob_agent", body: "Hello" });
    await createGroup(alice.agent, { name: "launch", members: ["@bob_agent"] });
    await setConfidential(bob.agent, "@alice_agent", true);
    await setConfidential(bob.agent, "#launch", true);

    const direct = await holdMessage(alice.token, "@bob_agent");
    const group = await holdMessage(alice.token, "#launch");
    await drainJobs();

    expect(mails()).toHaveLength(2);
    expect(telegramMessages()).toHaveLength(2);
    expect(outbound()).not.toContain(MARKER);
    const texts = mails().map((mail) => mail.text);
    expect(texts.join()).toContain("Message to @bob_agent.");
    expect(texts.join()).toContain("Message to #launch.");
    expect(texts.every((text) => text.includes("http://localhost:3001/dashboard/approvals"))).toBe(
      true,
    );
    expect(texts.join()).not.toContain("/approve?token=");
    const toBob = telegramMessages().find((call) => String(call.body.text).includes("@bob_agent"));
    expect(toBob?.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "Decline", callback_data: `hd:${direct}` }],
        [{ text: "Open in the dashboard", url: "http://localhost:3001/dashboard/approvals" }],
      ],
    });

    expect(await tap(direct, "ha")).toMatch(/dashboard/);
    expect(await status(direct)).toBe("pending");
    expect(await tap(group, "hd")).toBe("Declined.");
    expect(await status(group)).toBe("denied");
    expect(outbound()).not.toContain(MARKER);
  });

  it("follows the defaults for a first message, which would start a conversation", async () => {
    const alice = await withPolicy("alice_agent", { firstContact: true });
    const bob = await createAgentWithToken("bob_agent");
    await createAgentWithToken("carol_agent");
    await db.update(owners).set({ confidentialDefault: true }).where(eq(owners.id, bob.owner.id));

    const toBob = await holdMessage(alice.token, "@bob_agent");
    await drainJobs();
    expect(outbound()).not.toContain(MARKER);
    expect(await tap(toBob, "ha")).toMatch(/dashboard/);
    expect(await status(toBob)).toBe("pending");

    resetOutbound();
    await holdMessage(alice.token, "@carol_agent");
    await drainJobs();
    expect(mails()[0]?.text).toContain(MARKER);
    expect(telegramMessages()[0]?.body.text).toContain(MARKER);
  });

  it("leaves tool call arguments out when the owner's default is confidential", async () => {
    const alice = await withPolicy("alice_agent", {});
    await db.update(owners).set({ confidentialDefault: true }).where(eq(owners.id, alice.owner.id));
    const held = await maybeHold(
      { agent: alice.agent, tokenId: "", client: "test" },
      {
        kind: "tool.call",
        input: { tool: "send_invoice", arguments: { note: MARKER }, connectionId: uuidv7() },
        write: true,
      },
      { extraReasons: ["tool_write"], skipPolicy: true },
    );
    await drainJobs();
    expect(mails()).toHaveLength(1);
    expect(telegramMessages()).toHaveLength(1);
    expect(outbound()).not.toContain(MARKER);
    expect(telegramMessages()[0]?.body.text).toContain("send_invoice");
    expect(await tap(held!.holdId, "ha")).toMatch(/dashboard/);
    expect(await tap(held!.holdId, "hd")).toBe("Declined.");
    expect(await status(held!.holdId)).toBe("denied");
  });

  it("notifies as before in a conversation that isn't confidential", async () => {
    const alice = await withPolicy("alice_agent", { hourlyMessages: 1 });
    await createAgentWithToken("bob_agent");
    await sendMessage(alice.agent, { to: "@bob_agent", body: "Hello" });

    const holdId = await holdMessage(alice.token, "@bob_agent");
    await drainJobs();
    expect(mails()[0]?.text).toContain(`Message to @bob_agent: “Pricing: ${MARKER}”`);
    expect(mails()[0]?.text).toContain("/approve?token=");
    expect(telegramMessages()[0]?.body.text).toContain(MARKER);
    expect(telegramMessages()[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Approve", callback_data: `ha:${holdId}` },
          { text: "Decline", callback_data: `hd:${holdId}` },
        ],
      ],
    });
    expect(await tap(holdId, "ha")).toBe("Approved.");
    expect(await status(holdId)).toBe("released");
  });
});

describe("every other notification", () => {
  beforeEach(() => {
    config.TELEGRAM_BOT_TOKEN = "123:test";
    resetOutbound();
  });

  afterEach(() => {
    config.TELEGRAM_BOT_TOKEN = undefined;
  });

  it("carries no content from a confidential conversation either", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    await createAgentWithToken("carol_agent");
    for (const { owner, agent } of [alice, bob]) {
      await linkTelegram(owner, owner === alice.owner ? "555" : "556");
      await db
        .update(agents)
        .set({ notifyEmail: `notify-${agent.handle}@example.com`, policy: { holds: {} } })
        .where(eq(agents.id, agent.id));
    }
    await db.update(owners).set({ confidentialDefault: true }).where(eq(owners.id, alice.owner.id));

    // Alice's default makes both conversations confidential from the start.
    await sendMessage(alice.agent, { to: "@bob_agent", body: `Hello ${MARKER}` });
    await createGroup(alice.agent, {
      name: "launch",
      members: ["@bob_agent"],
      note: `Join us ${MARKER}`,
    });
    await sendMessage(bob.agent, { to: "@alice_agent", body: `Reply ${MARKER}` });
    const asked = await askOwner(bob.agent, {
      question: `Answer ${MARKER}?`,
      conversation: "@alice_agent",
    });
    await drainJobs();
    await answerQuestion(bob.owner.id, asked.id, `Yes ${MARKER}`);

    const ctx = { agent: alice.agent, tokenId: "", client: "test" };
    const extra = { extraReasons: ["groups" as const], skipPolicy: true };
    await maybeHold(
      ctx,
      {
        kind: "group.invite",
        input: { group: "#launch", handles: ["@carol_agent"], note: MARKER },
      },
      extra,
    );
    await maybeHold(
      ctx,
      { kind: "invite_person", input: { email: "maria@example.com", note: MARKER } },
      { extraReasons: ["invite_person"], skipPolicy: true },
    );
    await drainJobs();

    expect(mails().length).toBeGreaterThanOrEqual(5);
    expect(telegramMessages().length).toBeGreaterThanOrEqual(3);
    expect(mails().some((mail) => mail.to === "notify-bob_agent@example.com")).toBe(true);
    expect(outbound()).not.toContain(MARKER);
    expect(outbound()).not.toContain("maria@example.com");
  });
});

describe("agents in a confidential conversation", () => {
  const LINE = "don't repeat its content outside Callsign";

  it("are told not to repeat it, in the inbox and the conversation", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    const carol = await createAgentWithToken("carol_agent");
    await sendMessage(bob.agent, { to: "@alice_agent", body: "Hello" });
    await sendMessage(carol.agent, { to: "@alice_agent", body: "Hello" });
    await createGroup(bob.agent, { name: "launch", members: ["@alice_agent"] });
    await setConfidential(bob.agent, "@alice_agent", true);
    await setConfidential(bob.agent, "#launch", true);
    await sendMessage(bob.agent, { to: "#launch", body: "Plans" });

    const client = await mcp(alice.token);
    const inbox = await client.callTool({ name: "check_inbox", arguments: {} });
    const threads = (inbox.structuredContent as { threads: Record<string, unknown>[] }).threads;
    const confidential = (peer: string) =>
      threads.find((thread) => JSON.stringify(thread.with ?? thread.group).includes(peer))
        ?.confidential;
    expect(confidential("@bob_agent")).toBe(true);
    expect(confidential("#launch")).toBe(true);
    expect(confidential("@carol_agent")).toBeUndefined();
    const text = (inbox.content as { text: string }[])[0]?.text ?? "";
    expect(text.split(LINE)).toHaveLength(3);

    const read = async (peer: string) => {
      const result = await client.callTool({ name: "get_conversation", arguments: { with: peer } });
      return {
        text: (result.content as { text: string }[])[0]?.text ?? "",
        confidential: (result.structuredContent as { confidential?: boolean }).confidential,
      };
    };
    expect(await read("@bob_agent")).toMatchObject({ confidential: true });
    expect((await read("@bob_agent")).text).toContain(LINE);
    expect((await read("#launch")).text).toContain(LINE);
    expect(await read("@carol_agent")).toMatchObject({ confidential: undefined });
    expect((await read("@carol_agent")).text).not.toContain(LINE);
    await client.close();
  });
});
