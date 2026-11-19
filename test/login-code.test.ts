import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { jobs } from "../src/db/schema.ts";
import { createApp } from "../src/http/app.ts";

const app = createApp();

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3001" },
    body: JSON.stringify(body),
  });
}

async function loginCode(email: string): Promise<string> {
  expect((await post("/v1/auth/login", { email })).status).toBe(202);
  const [job] = await db.select().from(jobs).where(eq(jobs.kind, "email.login"));
  const code = String(job?.payload.code ?? "");
  expect(code).toMatch(/^\d{6}$/);
  return code;
}

describe("sign-in by code", () => {
  it("signs in once with the code from the sign-in email", async () => {
    const code = await loginCode("phone@example.com");
    const wrong = await post("/v1/auth/verify-code", {
      email: "phone@example.com",
      code: code === "000000" ? "111111" : "000000",
    });
    expect(wrong.status).toBe(401);

    const ok = await post("/v1/auth/verify-code", { email: "Phone@Example.com", code });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("callsign_session=");

    const reuse = await post("/v1/auth/verify-code", { email: "phone@example.com", code });
    expect(reuse.status).toBe(401);
  });

  it("stops guessing after a few wrong codes", async () => {
    const code = await loginCode("guess@example.com");
    for (let i = 0; i < 5; i++) {
      await post("/v1/auth/verify-code", { email: "guess@example.com", code: "999999" });
    }
    const blocked = await post("/v1/auth/verify-code", { email: "guess@example.com", code });
    expect(blocked.status).toBe(429);
  });
});
