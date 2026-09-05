/**
 * Step 2: agent-card module and the a2a_discover tool, against the fixture
 * agent started in-process.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFixtureAgent } from "../../fixtures/agent/index.js";
import { createBridge, type Bridge } from "../../src/server.js";
import { expectResult, postModern, textOf } from "../helpers/mcp-http.js";

let agent: Awaited<ReturnType<typeof startFixtureAgent>>;
let bridge: Bridge;
let url: string;

beforeAll(async () => {
  agent = await startFixtureAgent({ port: 0 });
  bridge = await createBridge({ agents: { fixture: { cardUrl: agent.cardUrl } } });
  url = (await bridge.listen(0)).url;
});

afterAll(async () => {
  await bridge.close();
  await agent.close();
});

async function discover(): Promise<Record<string, unknown>> {
  return expectResult(
    await postModern(url, "tools/call", { name: "a2a_discover", arguments: { agent: "fixture" } }),
  );
}

describe("a2a_discover", () => {
  it("returns the validated card identity, capabilities and skills as structuredContent", async () => {
    const result = await discover();
    expect(result["isError"]).toBeFalsy();
    expect(result["resultType"]).toBe("complete");
    const card = result["structuredContent"] as Record<string, unknown>;
    expect(card["name"]).toBe("Fixture Agent");
    expect(card["capabilities"]).toMatchObject({ streaming: true, pushNotifications: false });
    const skills = card["skills"] as Array<{ id: string; name: string; description: string }>;
    expect(skills.map((skill) => skill.id).sort()).toEqual(
      ["ask", "echo", "long-task", "media", "outcomes"].sort(),
    );
  });

  it("keeps the raw card shape rather than inventing an MCP model for it", async () => {
    const card = (await discover())["structuredContent"] as Record<string, unknown>;
    // v1.0 card: interfaces are declared, no v0.3 url/preferredTransport pair.
    expect(Array.isArray(card["supportedInterfaces"])).toBe(true);
    expect(card["protocolVersion"] ?? "1.0").toMatch(/^1\.0/);
  });

  it("summarises the agent in text for clients that ignore structuredContent", async () => {
    const text = textOf(await discover());
    expect(text).toContain("Fixture Agent");
    expect(text).toContain("echo");
    expect(text).toContain("long-task");
    expect(text).toMatch(/streaming/i);
  });

  it("reports the card URL and the A2A version the bridge speaks", async () => {
    const result = await discover();
    const card = result["structuredContent"] as Record<string, unknown>;
    const bridgeMeta = result["_meta"] as Record<string, unknown> | undefined;
    const info = (bridgeMeta?.["io.github.amirk-s/a2a"] ?? card["_bridge"]) as
      | Record<string, unknown>
      | undefined;
    expect(info).toBeDefined();
    expect(info?.["cardUrl"]).toBe(agent.cardUrl);
    expect(info?.["a2aVersion"]).toBe("1.0");
  });

  it("serves a second call from the card cache without refetching", async () => {
    await discover();
    const before = agent.cardFetchCount();
    await discover();
    expect(agent.cardFetchCount()).toBe(before);
  });

  it("names the agent in server/discover instructions once known", async () => {
    await discover();
    const result = expectResult(await postModern(url, "server/discover"));
    expect(result["instructions"]).toContain("fixture");
  });
});
