/**
 * A bridge configured with exactly one agent does not make the caller repeat
 * its alias: `agent` becomes optional on every tool and defaults to that
 * alias. With two or more agents `agent` stays required. This also removes a
 * false negative of the conformance scenario
 * sep-2243-server-accepts-whitespace-header-value, which calls the first
 * listed tool with empty arguments.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFixtureAgent } from "../../fixtures/agent/index.js";
import { createBridge, type Bridge } from "../../src/server.js";
import { expectError, expectResult, postModern, textOf } from "../helpers/mcp-http.js";

const UNREACHABLE_CARD = "http://127.0.0.1:9/.well-known/agent-card.json";

let agent: Awaited<ReturnType<typeof startFixtureAgent>>;
let single: Bridge;
let singleUrl: string;
let pair: Bridge;
let pairUrl: string;

beforeAll(async () => {
  agent = await startFixtureAgent({ port: 0 });
  single = await createBridge({ agents: { fixture: { cardUrl: agent.cardUrl } } });
  singleUrl = (await single.listen(0)).url;
  pair = await createBridge({
    agents: { fixture: { cardUrl: agent.cardUrl }, other: { cardUrl: UNREACHABLE_CARD } },
  });
  pairUrl = (await pair.listen(0)).url;
});

afterAll(async () => {
  await single.close();
  await pair.close();
  await agent.close();
});

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: {
    properties?: Record<string, { enum?: string[]; default?: string; description?: string }>;
    required?: string[];
  };
}

async function listTools(url: string): Promise<ListedTool[]> {
  return expectResult(await postModern(url, "tools/list"))["tools"] as ListedTool[];
}

describe("one configured agent", () => {
  it("lists agent as optional on every tool, with the alias as enum and default", async () => {
    for (const tool of await listTools(singleUrl)) {
      expect(tool.inputSchema.required ?? [], tool.name).not.toContain("agent");
      expect(tool.inputSchema.properties?.["agent"]?.enum, tool.name).toEqual(["fixture"]);
      expect(tool.inputSchema.properties?.["agent"]?.default, tool.name).toBe("fixture");
    }
  });

  it("a2a_discover with empty arguments reaches the only agent", async () => {
    const result = expectResult(
      await postModern(singleUrl, "tools/call", { name: "a2a_discover", arguments: {} }),
    );
    expect(result["isError"]).toBeFalsy();
    expect(textOf(result)).toContain("Fixture Agent");
  });

  it("a2a_send_message without agent talks to the only agent", async () => {
    const result = expectResult(
      await postModern(singleUrl, "tools/call", {
        name: "a2a_send_message",
        arguments: { text: "echo: solo" },
      }),
    );
    expect(textOf(result)).toBe("solo");
  });

  it("still accepts the alias explicitly, and still rejects an unknown one", async () => {
    const explicit = expectResult(
      await postModern(singleUrl, "tools/call", {
        name: "a2a_discover",
        arguments: { agent: "fixture" },
      }),
    );
    expect(explicit["isError"]).toBeFalsy();
    const wrong = expectResult(
      await postModern(singleUrl, "tools/call", { name: "a2a_discover", arguments: { agent: "nope" } }),
    );
    expect(wrong["isError"]).toBe(true);
    expect(textOf(wrong)).toContain("fixture");
  });

  it("still requires the other arguments: a2a_get_task without taskHandle is -32602", async () => {
    const exchange = await postModern(singleUrl, "tools/call", { name: "a2a_get_task", arguments: {} });
    expect(expectError(exchange).code).toBe(-32602);
  });

  it("says in the tool description that the agent argument may be omitted", async () => {
    const tools = await listTools(singleUrl);
    const discover = tools.find((tool) => tool.name === "a2a_discover");
    expect(discover?.inputSchema.properties?.["agent"]?.description).toMatch(/fixture/);
  });
});

describe("two configured agents", () => {
  it("keeps agent required on every tool", async () => {
    for (const tool of await listTools(pairUrl)) {
      expect(tool.inputSchema.required, tool.name).toContain("agent");
      expect(tool.inputSchema.properties?.["agent"]?.default, tool.name).toBeUndefined();
    }
  });

  it("rejects a call without agent with -32602", async () => {
    const exchange = await postModern(pairUrl, "tools/call", { name: "a2a_discover", arguments: {} });
    expect(expectError(exchange).code).toBe(-32602);
  });
});
