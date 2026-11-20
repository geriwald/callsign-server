import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.ts";
import { db } from "../src/db/client.ts";
import { owners, pushSubscriptions, type Owner } from "../src/db/schema.ts";
import { setAnswerChannels } from "../src/domain/answer-channels.ts";
import { createSession } from "../src/domain/owners.ts";
import {
  confirmPushTest,
  listPushDevices,
  removePushDevice,
  sendPushTest,
  subscribePush,
} from "../src/domain/push.ts";
import { askOwner } from "../src/domain/questions.ts";
import { createApp } from "../src/http/app.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { sendPush, type PushPayload } from "../src/lib/push.ts";
import { createAgentWithToken } from "./helpers.ts";

vi.mock("../src/lib/push.ts", () => ({
  pushEnabled: () => true,
  sendPush: vi.fn(() => Promise.resolve("sent")),
}));

const sent = () =>
  vi.mocked(sendPush).mock.calls.map(([sub, payload]) => ({ endpoint: sub.endpoint, payload }));

beforeAll(() => {
  config.VAPID_PUBLIC_KEY = "test-public-key";
});

afterAll(() => {
  config.VAPID_PUBLIC_KEY = undefined;
});

beforeEach(() => {
  vi.mocked(sendPush).mockReset();
  vi.mocked(sendPush).mockResolvedValue("sent");
});

async function drainJobs() {
  while ((await processDueJobs()) > 0);
}

async function reload(owner: Owner): Promise<Owner> {
  const [row] = await db.select().from(owners).where(eq(owners.id, owner.id));
  return row as Owner;
}

function device(name: string) {
  return {
    endpoint: `https://push.example.com/${name}`,
    keys: { p256dh: "p256dh-key", auth: "auth-key" },
    label: name,
  };
}

async function testedDevice(owner: Owner, name = "iphone") {
  const added = await subscribePush(owner, device(name));
  await sendPushTest(owner, added.id, "question");
  const url = (sent().at(-1)?.payload as PushPayload).url;
  const token = new URL(url, "http://x").searchParams.get("push-test") ?? "";
  await confirmPushTest(owner, token);
  return added;
}

describe("web app push", () => {
  it("subscribes a device, tests it and removes it", async () => {
    const { owner } = await createAgentWithToken("pusher");
    const added = await subscribePush(owner, device("iphone"));
    expect(await listPushDevices(owner)).toMatchObject([
      { id: added.id, label: "iphone", tested: false },
    ]);

    await sendPushTest(owner, added.id, "notification");
    expect(sent()).toMatchObject([{ endpoint: "https://push.example.com/iphone" }]);

    await testedDevice(owner);
    expect(await listPushDevices(owner)).toMatchObject([{ tested: true }]);

    await removePushDevice(owner, added.id);
    expect(await listPushDevices(owner)).toEqual([]);
  });

  it("turns the web app on only after a device passed the question test", async () => {
    const { owner } = await createAgentWithToken("unlocked");
    await subscribePush(owner, device("android"));
    await expect(setAnswerChannels(owner, { push: true })).rejects.toThrow(/Test/);
    await testedDevice(owner, "android");
    const on = await setAnswerChannels(await reload(owner), { push: true, email: false });
    expect(on.answerPush).toBe(true);
  });

  it("sends questions to tested devices with who asked, never the question", async () => {
    const { owner, agent } = await createAgentWithToken("notified");
    await testedDevice(owner);
    await setAnswerChannels(await reload(owner), { push: true, email: false });
    vi.mocked(sendPush).mockClear();

    const asked = await askOwner(agent, { question: "Ship the release tonight?" });
    await drainJobs();
    expect(sent()).toMatchObject([
      {
        payload: {
          title: "@notified has a question",
          body: "Tap to answer.",
          url: `/dashboard/questions?question=${asked.id}`,
        },
      },
    ]);
    expect(JSON.stringify(sent())).not.toContain("Ship the release");
  });

  it("forgets a gone device and falls back to email when none is left", async () => {
    const { owner, agent } = await createAgentWithToken("orphan");
    await testedDevice(owner);
    await setAnswerChannels(await reload(owner), { push: true, email: false });

    vi.mocked(sendPush).mockResolvedValue("gone");
    await askOwner(agent, { question: "Still there?" });
    await drainJobs();
    expect(await listPushDevices(owner)).toEqual([]);
    const after = await reload(owner);
    expect(after.answerPush).toBe(false);
    expect(after.answerEmail).toBe(true);
  });

  it("exposes devices and tests through the account API", async () => {
    const { owner } = await createAgentWithToken("api_pusher");
    const app = createApp();
    const { sessionToken } = await createSession(db, owner.id);
    const auth = {
      cookie: `callsign_session=${sessionToken}`,
      "content-type": "application/json",
      origin: "http://localhost:3001",
    };
    const added = await app.request("/v1/me/push", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(device("pixel")),
    });
    expect(added.status).toBe(201);
    const { device: created } = (await added.json()) as { device: { id: string } };

    const listed = (await (await app.request("/v1/me/push", { headers: auth })).json()) as {
      publicKey: string;
      devices: unknown[];
    };
    expect(listed).toMatchObject({ publicKey: "test-public-key", devices: [{ label: "pixel" }] });

    const test = await app.request(`/v1/me/push/${created.id}/test`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "notification" }),
    });
    expect(await test.json()).toEqual({ sent: true });
    expect(
      await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.ownerId, owner.id)),
    ).toHaveLength(1);
  });
});

describe("push texts", () => {
  it("keeps test notifications short and signed by @hello", async () => {
    const { owner } = await createAgentWithToken("short_texts");
    const added = await subscribePush(owner, device("phone"));
    await sendPushTest(owner, added.id, "notification");
    await sendPushTest(owner, added.id, "question");
    expect(sent().map(({ payload }) => [payload.title, payload.body])).toEqual([
      ["@hello", "Test: notifications work."],
      ["@hello asks", "Test question: tap to confirm."],
    ]);
  });
});
