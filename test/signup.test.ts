import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { db } from "../src/db/client.ts";
import {
  agentRegistrations,
  invitations,
  jobs,
  loginTokens,
  owners,
  type Agent,
} from "../src/db/schema.ts";
import { createAgent } from "../src/domain/agents.ts";
import { emailContact } from "../src/domain/email-bridge.ts";
import { ensureHelloAgent } from "../src/domain/hello.ts";
import { listContacts } from "../src/domain/contacts.ts";
import { invitePerson } from "../src/domain/invitations.ts";
import { checkInbox } from "../src/domain/messaging.ts";
import { createSession } from "../src/domain/owners.ts";
import { approveRegistration } from "../src/domain/registrations.ts";
import { createApp } from "../src/http/app.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { telegramWebhookSecret } from "../src/lib/telegram.ts";
import { createAgentWithToken, createOwner } from "./helpers.ts";

const app = createApp();
const ADMIN = "admin@example.com";

function json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost:3001", ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

function jobsFor(kind: string, email: string) {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind), sql`${jobs.payload}->>'email' = ${email}`));
}

async function signIn(email: string) {
  const requested = await json("POST", "/v1/auth/login", { email });
  const [job] = await jobsFor("email.login", email);
  const token = job ? new URL(String(job.payload.url)).searchParams.get("token") : null;
  return { requested, token };
}

async function verify(token: string) {
  const verified = await json("POST", "/v1/auth/verify", { token });
  return { verified, cookie: verified.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

function register(handle: string, ownerEmail: string) {
  return json("POST", "/v1/register", {
    handle,
    ownerEmail,
    product: "custom",
    description: "An assistant for follow-ups",
  });
}

async function ownerExists(email: string) {
  const [owner] = await db.select().from(owners).where(eq(owners.email, email));
  return owner !== undefined;
}

// Answers differ only by the random token and timestamps, never by who the email belongs to.
function shape(body: unknown) {
  return JSON.stringify(body)
    .replace(/csk_[A-Za-z0-9_-]+/g, "<token>")
    .replace(/\w+_agent/g, "<handle>")
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<date>")
    .replace(/\w\*\*\*@[\w.]+/g, "<masked>");
}

beforeEach(() => {
  config.SIGNUP_MODE = "invite";
  config.ADMIN_EMAILS.splice(0, Infinity, ADMIN);
});

afterEach(() => {
  config.SIGNUP_MODE = "open";
  config.ADMIN_EMAILS.splice(0);
});

describe("invite-only sign-up", () => {
  it("answers a stranger's sign-in request like a member's and sends nothing", async () => {
    await createOwner("member@example.com");
    const member = await signIn("member@example.com");
    const stranger = await signIn("stranger@example.com");

    expect(stranger.requested.status).toBe(member.requested.status);
    expect(await stranger.requested.json()).toEqual(await member.requested.json());
    expect(member.token).toBeTruthy();
    expect(stranger.token).toBeNull();
    const tokens = await db.select().from(loginTokens);
    expect(tokens.map((row) => row.email)).toEqual(["member@example.com"]);
    expect(await ownerExists("stranger@example.com")).toBe(false);
  });

  it("refuses a sign-in link sent before the server became invite-only", async () => {
    config.SIGNUP_MODE = "open";
    const { token } = await signIn("stranger@example.com");
    config.SIGNUP_MODE = "invite";

    const { verified } = await verify(token ?? "");
    expect(verified.status).toBe(403);
    expect(await ownerExists("stranger@example.com")).toBe(false);
  });

  it("lets an admin sign up and create agents", async () => {
    const { token } = await signIn(ADMIN);
    const { verified, cookie } = await verify(token ?? "");
    expect(await verified.json()).toMatchObject({ created: true });

    const created = await json(
      "POST",
      "/v1/agents",
      { handle: "admin_agent", product: "custom" },
      { cookie },
    );
    expect(created.status).toBe(201);
  });

  it("takes a stranger's agent registration like a member's but never emails or approves it", async () => {
    await createOwner("member@example.com");
    const forMember = await register("member_agent", "member@example.com");
    const forStranger = await register("stranger_agent", "stranger@example.com");

    expect(forStranger.status).toBe(forMember.status);
    expect(shape(await forStranger.json())).toBe(shape(await forMember.json()));
    expect(await jobsFor("email.approval", "member@example.com")).toHaveLength(1);
    expect(await jobsFor("email.approval", "stranger@example.com")).toHaveLength(0);

    const { token } = (await (await register("other_agent", "stranger2@example.com")).json()) as {
      token: string;
    };
    const resent = await json("POST", "/v1/register/resend", undefined, {
      authorization: `Bearer ${token}`,
    });
    expect(resent.status).toBe(200);
    expect(await jobsFor("email.approval", "stranger2@example.com")).toHaveLength(0);

    const [registration] = await db
      .select()
      .from(agentRegistrations)
      .where(eq(agentRegistrations.ownerEmail, "stranger@example.com"));
    if (!registration) throw new Error("no registration");
    await expect(approveRegistration(registration, { startSession: false })).rejects.toThrow(
      /invitation/,
    );
    expect(await ownerExists("stranger@example.com")).toBe(false);
  });

  it("lets someone an admin invited sign up", async () => {
    const admin = await createOwner(ADMIN);
    const agent = await createAgent(admin, { handle: "admin_agent", product: "custom" });
    await invitePerson(agent, { email: "guest@example.com" });
    expect(await jobsFor("email.invitation", "guest@example.com")).toHaveLength(1);

    const { token } = await signIn("guest@example.com");
    const { verified } = await verify(token ?? "");
    expect(await verified.json()).toMatchObject({ created: true });
  });

  it("keeps creating the system owners", async () => {
    const hello = await ensureHelloAgent();
    expect(hello.handle).toBe("hello");
    const contact = await emailContact("ana@northwind.test");
    expect(contact.handle).toBe("ana@northwind.test");
  });

  it("tells the dashboard which mode the server runs in", async () => {
    expect(await (await app.request("/v1/signup")).json()).toEqual({ mode: "invite" });
    config.SIGNUP_MODE = "open";
    expect(await (await app.request("/v1/signup")).json()).toEqual({ mode: "open" });
  });

  it("changes nothing in open mode", async () => {
    config.SIGNUP_MODE = "open";
    const { token } = await signIn("stranger@example.com");
    expect(token).toBeTruthy();
    await register("stranger_agent", "stranger@example.com");
    expect(await jobsFor("email.approval", "stranger@example.com")).toHaveLength(1);
    const { agent } = await createAgentWithToken("member_agent");
    await invitePerson(agent, { email: "guest@example.com" });
    expect(await jobsFor("email.invitation", "guest@example.com")).toHaveLength(1);
  });
});

async function adminAgent() {
  const owner = await createOwner(ADMIN);
  const agent = await createAgent(owner, { handle: "admin_agent", product: "custom" });
  const { sessionToken } = await createSession(db, owner.id);
  return { agent, cookie: `callsign_session=${sessionToken}` };
}

type PendingInvitation = { id: string; from: string; fromName: string; to: string };

async function pendingInvitations(cookie: string) {
  const response = await json("GET", "/v1/admin/invitations", undefined, { cookie });
  return { response, body: (await response.json()) as { invitations: PendingInvitation[] } };
}

function decide(cookie: string, id: string, decision: "approve" | "decline") {
  return json("POST", `/v1/admin/invitations/${id}`, { decision }, { cookie });
}

async function noticeTexts(agent: Agent) {
  return (await checkInbox(agent)).notices.map((notice) => `${notice.kind}: ${notice.text}`);
}

describe("invitations on an invite-only server", () => {
  it("holds a member's invitation for an admin and sends it once approved", async () => {
    const { agent: member, token, owner } = await createAgentWithToken("member_agent");
    const sent = await json(
      "POST",
      "/v1/agent/invitations",
      { email: "Guest@Example.com", note: "Join us here" },
      { authorization: `Bearer ${token}` },
    );
    expect(sent.status).toBe(202);
    const body = (await sent.json()) as { status: string; to: string; message: string };
    expect(body).toMatchObject({ status: "pending_admin_approval", to: "g***@example.com" });
    expect(body.message).toMatch(/admin/);
    expect(await jobsFor("email.invitation", "guest@example.com")).toHaveLength(0);
    expect((await signIn("guest@example.com")).token).toBeNull();

    const { cookie } = await adminAgent();
    const memberCookie = `callsign_session=${(await createSession(db, owner.id)).sessionToken}`;
    expect((await pendingInvitations(memberCookie)).response.status).toBe(404);
    const { body: listed } = await pendingInvitations(cookie);
    expect(listed.invitations).toMatchObject([
      { from: "@member_agent", fromName: "member_agent", to: "guest@example.com" },
    ]);

    const approved = await decide(cookie, listed.invitations[0]?.id ?? "", "approve");
    expect(approved.status).toBe(200);
    const [email] = await jobsFor("email.invitation", "guest@example.com");
    expect(email?.payload).toMatchObject({ from: "@member_agent", note: "Join us here" });
    expect((await pendingInvitations(cookie)).body.invitations).toEqual([]);
    expect(await noticeTexts(member)).toEqual([
      expect.stringMatching(/^invitation\.approved: .*g\*\*\*@example\.com/),
    ]);

    const invite = new URL(String(email?.payload.url)).searchParams.get("invite");
    expect((await app.request(`/v1/invitations/${invite}`)).status).toBe(200);
    const { token: login } = await signIn("guest@example.com");
    await verify(login ?? "");
    const [guest] = await db.select().from(owners).where(eq(owners.email, "guest@example.com"));
    if (!guest) throw new Error("no guest");
    expect((await listContacts(guest.id)).map((c) => c.agent.handle)).toEqual(["@member_agent"]);
  });

  it("declines without any email and tells the inviting agent", async () => {
    const { agent: member } = await createAgentWithToken("member_agent");
    await invitePerson(member, { email: "guest@example.com" });
    const { cookie } = await adminAgent();
    const [pending] = (await pendingInvitations(cookie)).body.invitations;

    const declined = await decide(cookie, pending?.id ?? "", "decline");
    expect(declined.status).toBe(200);
    expect(await jobsFor("email.invitation", "guest@example.com")).toHaveLength(0);
    expect(await noticeTexts(member)).toEqual([
      expect.stringMatching(/^invitation\.declined: .*g\*\*\*@example\.com/),
    ]);
    expect((await signIn("guest@example.com")).token).toBeNull();
    expect((await decide(cookie, pending?.id ?? "", "approve")).status).toBe(404);
    const [row] = await db.select().from(invitations);
    expect(row?.email).toBeNull();
  });

  it("can't approve or use an invitation once it expired", async () => {
    const { agent: member } = await createAgentWithToken("member_agent");
    await invitePerson(member, { email: "guest@example.com" });
    const { agent: admin, cookie } = await adminAgent();
    await invitePerson(admin, { email: "other@example.com" });
    const [pending] = (await pendingInvitations(cookie)).body.invitations;
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) });

    expect((await pendingInvitations(cookie)).body.invitations).toEqual([]);
    expect((await decide(cookie, pending?.id ?? "", "approve")).status).toBe(404);
    expect(await jobsFor("email.invitation", "guest@example.com")).toHaveLength(0);
    expect((await signIn("other@example.com")).token).toBeNull();
  });

  it("connects people who already have an account without asking an admin", async () => {
    const { agent: member } = await createAgentWithToken("member_agent");
    await createOwner("guest@example.com");
    const sent = await invitePerson(member, { email: "guest@example.com" });
    expect(sent).toMatchObject({ sentTo: "g***@example.com" });
    expect(await jobsFor("email.invitation", "guest@example.com")).toHaveLength(1);
  });

  it("connects a waiting inviter only once an admin approves", async () => {
    const { agent: member } = await createAgentWithToken("member_agent");
    await invitePerson(member, { email: "guest@example.com" });
    const { agent: admin, cookie } = await adminAgent();
    await invitePerson(admin, { email: "guest@example.com" });
    const { token } = await signIn("guest@example.com");
    await verify(token ?? "");
    const [guest] = await db.select().from(owners).where(eq(owners.email, "guest@example.com"));
    if (!guest) throw new Error("no guest");
    expect((await listContacts(guest.id)).map((c) => c.agent.handle)).toEqual(["@admin_agent"]);

    const [pending] = (await pendingInvitations(cookie)).body.invitations;
    await decide(cookie, pending?.id ?? "", "approve");
    expect((await listContacts(guest.id)).map((c) => c.agent.handle).sort()).toEqual([
      "@admin_agent",
      "@member_agent",
    ]);
    const emails = await jobsFor("email.invitation", "guest@example.com");
    expect(emails.map((job) => job.payload.existing)).toEqual([false, true]);
  });
});

describe("approving invitations from Telegram", () => {
  type Call = { method: string; body: Record<string, unknown> };
  const calls: Call[] = [];
  const telegramApi = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      calls.push({
        method: req.url?.split("/").at(-1) ?? "",
        body: JSON.parse(raw || "{}") as Record<string, unknown>,
      });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
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

  beforeEach(() => {
    config.TELEGRAM_BOT_TOKEN = "123:test";
    config.ADMIN_EMAILS.push("second-admin@example.com", "offline-admin@example.com");
    calls.splice(0);
  });

  async function linkTelegram(email: string, chatId: string) {
    await createOwner(email);
    await db.update(owners).set({ telegramChatId: chatId }).where(eq(owners.email, email));
  }

  async function inviteFromMember() {
    await linkTelegram(ADMIN, "555");
    await linkTelegram("second-admin@example.com", "556");
    await createOwner("offline-admin@example.com");
    const { agent, owner } = await createAgentWithToken("member_agent");
    await db.update(owners).set({ telegramChatId: "777" }).where(eq(owners.id, owner.id));
    await invitePerson(agent, { email: "guest@example.com", note: "Our secret launch plan" });
    while ((await processDueJobs()) > 0);
    const [invitation] = await db.select().from(invitations);
    return { agent, id: invitation?.id ?? "" };
  }

  function tap(chatId: number, data: string) {
    return app.request("/v1/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": telegramWebhookSecret(),
      },
      body: JSON.stringify({
        callback_query: {
          id: "cb1",
          data,
          message: { message_id: 1, chat: { id: chatId, type: "private" }, text: "Invitation" },
        },
      }),
    });
  }

  it("asks every admin who linked Telegram, without the address or the note", async () => {
    const { id } = await inviteFromMember();
    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent.map((call) => call.body.chat_id).sort()).toEqual(["555", "556"]);
    for (const { body } of sent) {
      expect(body.text).toContain("@member_agent");
      expect(body.text).toContain("g***@example.com");
      expect(body.text).not.toContain("guest@example.com");
      expect(body.text).not.toContain("secret");
      expect(body.reply_markup).toEqual({
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `ia:${id}` },
            { text: "Decline", callback_data: `id:${id}` },
          ],
        ],
      });
    }
  });

  it("sends the invitation when an admin taps Approve", async () => {
    const { agent, id } = await inviteFromMember();
    await tap(556, `ia:${id}`);
    expect(await jobsFor("email.invitation", "guest@example.com")).toHaveLength(1);
    expect(calls.some((call) => call.method === "editMessageText")).toBe(true);
    expect(await noticeTexts(agent)).toEqual([expect.stringMatching(/^invitation\.approved/)]);

    await tap(555, `id:${id}`);
    const answered = calls.findLast((call) => call.method === "answerCallbackQuery");
    expect(answered?.body.text).toMatch(/No pending invitation/);
  });

  it("sends nothing when an admin taps Decline", async () => {
    const { agent, id } = await inviteFromMember();
    await tap(555, `id:${id}`);
    expect(await jobsFor("email.invitation", "guest@example.com")).toHaveLength(0);
    expect(await noticeTexts(agent)).toEqual([expect.stringMatching(/^invitation\.declined/)]);
  });

  it("ignores the buttons in a chat that isn't an admin's", async () => {
    const { id } = await inviteFromMember();
    await tap(777, `ia:${id}`);
    expect(await jobsFor("email.invitation", "guest@example.com")).toHaveLength(0);
    const [invitation] = await db
      .select()
      .from(invitations)
      .where(inArray(invitations.status, ["pending"]));
    expect(invitation?.id).toBe(id);
  });
});
