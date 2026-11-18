import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { db } from "../src/db/client.ts";
import { owners, type Owner } from "../src/db/schema.ts";
import { createAgent } from "../src/domain/agents.ts";
import { createGroup, leaveGroup } from "../src/domain/groups.ts";
import { sendMessage } from "../src/domain/messaging.ts";
import { createSession } from "../src/domain/owners.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken, createOwner } from "./helpers.ts";

const app = createApp();

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
