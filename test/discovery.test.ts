import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";

const app = createApp();

describe("discovery", () => {
  it("serves an MCP server card with caching headers", async () => {
    const response = await app.request("/mcp/server-card", {
      headers: { accept: "application/mcp-server-card+json" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const card = (await response.json()) as { name: string; remotes: { url: string }[] };
    expect(card.name).toBe("im.callsign/callsign");
    expect(card.remotes.map((r) => r.url)).toEqual([
      "http://localhost:8080/mcp",
      "http://localhost:8080/mcp/{token}",
    ]);

    const etag = response.headers.get("etag") ?? "";
    const cached = await app.request("/mcp/server-card", { headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);
  });

  it("publishes an OpenAPI document covering the agent API", async () => {
    const response = await app.request("/openapi.json");
    const document = (await response.json()) as { openapi: string; paths: object };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toContain("/v1/agent/messages");
  });

  it("points agents to documentation from the root", async () => {
    const response = await app.request("/");
    expect(await response.json()).toMatchObject({
      mcp: "http://localhost:8080/mcp",
      openapi: "http://localhost:8080/openapi.json",
    });
  });

  it("serves the agent skill", async () => {
    const response = await app.request("/skill.md");
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toMatch(/^---\nname: callsign\n/);
  });

  it("tells agents the handle naming convention of this instance", async () => {
    const skill = await (await app.request("/skill.md")).text();
    expect(skill).toContain("## Handles on callsign-s2");
    expect(skill).toContain("`@pilou`");
    expect(skill).toContain("`@geraud_canari`");
  });

  it("points the agent skill at this instance, not callsign.im", async () => {
    const skill = await (await app.request("/skill.md")).text();
    expect(skill).toContain("callsign http://localhost:8080/mcp`");
    expect(skill).toContain("POST http://localhost:8080/v1/register");
    expect(skill).toContain("http://localhost:3000/llms.txt");
    expect(skill).not.toContain("callsign.im");
  });

  it("serves a favicon, so clients that show the API's icon find one", async () => {
    const response = await app.request("/favicon.ico");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("serves security.txt with this site's security address", async () => {
    const response = await app.request("/.well-known/security.txt");
    expect(await response.text()).toContain("Contact: mailto:security@localhost");
  });

  describe("on an instance that names its own contacts and docs", () => {
    afterEach(() => {
      delete config.SECURITY_EMAIL;
      delete config.DOCS_URL;
    });

    it("uses SECURITY_EMAIL in security.txt", async () => {
      config.SECURITY_EMAIL = "security@example.org";
      const response = await app.request("/.well-known/security.txt");
      expect(await response.text()).toContain("Contact: mailto:security@example.org");
    });

    it("points every documentation link at DOCS_URL", async () => {
      config.DOCS_URL = "https://docs.example.org/agents";
      const root = (await (await app.request("/")).json()) as { documentation: string };
      expect(root.documentation).toBe("https://docs.example.org/agents");
      const oauth = (await (
        await app.request("/.well-known/oauth-authorization-server")
      ).json()) as { service_documentation: string };
      expect(oauth.service_documentation).toBe("https://docs.example.org/agents");
      const resource = (await (
        await app.request("/.well-known/oauth-protected-resource/mcp")
      ).json()) as { resource_documentation: string };
      expect(resource.resource_documentation).toBe("https://docs.example.org/agents");
      const skill = await (await app.request("/skill.md")).text();
      expect(skill).toContain("(see https://docs.example.org/agents)");
    });
  });

  it("names this site, not callsign.im, in the API description", async () => {
    const openapi = await (await app.request("/openapi.json")).text();
    expect(openapi).not.toContain("callsign.im");
    expect(openapi).toContain("localhost/card/handle");
  });
});
