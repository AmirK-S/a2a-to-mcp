/**
 * The MCP face of the bridge, step 1 of the plan: Streamable HTTP,
 * server/discover, tools/list with cache fields, resultType everywhere,
 * mandatory headers, both eras on one endpoint (DECISIONS.md D01), and the
 * tasks/* interception in front of the SDK on the modern route (D06).
 *
 * No A2A agent is needed here: the aliases point at an unreachable card so
 * that failure paths are exercised without a network.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBridge, type Bridge } from "../../src/server.js";
import {
  LEGACY_VERSION,
  LegacySession,
  MODERN_VERSION,
  TASKS_CLIENT_CAPABILITIES,
  TASKS_EXTENSION,
  expectError,
  expectResult,
  postModern,
  textOf,
} from "../helpers/mcp-http.js";

const UNREACHABLE_CARD = "http://127.0.0.1:9/.well-known/agent-card.json";
const TOOL_NAMES = ["a2a_discover", "a2a_send_message", "a2a_get_task", "a2a_cancel_task"];

let bridge: Bridge;
let url: string;

beforeAll(async () => {
  bridge = await createBridge({
    agents: {
      fixture: { cardUrl: UNREACHABLE_CARD },
      other: { cardUrl: UNREACHABLE_CARD },
    },
    handleTtlMs: 60_000,
  });
  url = (await bridge.listen(0)).url;
});

afterAll(async () => {
  await bridge.close();
});

describe("server/discover on the 2026-07-28 route", () => {
  it("announces the modern revision only, the tools capability and the tasks extension", async () => {
    const result = expectResult(await postModern(url, "server/discover"));
    expect(result["supportedVersions"]).toEqual([MODERN_VERSION]);
    expect(result["capabilities"]).toMatchObject({ tools: {} });
    const extensions = (result["capabilities"] as { extensions?: Record<string, unknown> })
      .extensions;
    expect(extensions?.[TASKS_EXTENSION]).toBeDefined();
  });

  it("carries resultType complete and the cache fields", async () => {
    const result = expectResult(await postModern(url, "server/discover"));
    expect(result["resultType"]).toBe("complete");
    expect(typeof result["ttlMs"]).toBe("number");
    expect(typeof result["cacheScope"]).toBe("string");
  });

  it("gives instructions that name the configured aliases and both protocol versions", async () => {
    const result = expectResult(await postModern(url, "server/discover"));
    const instructions = result["instructions"];
    expect(typeof instructions).toBe("string");
    expect(instructions).toContain("fixture");
    expect(instructions).toContain("other");
    expect(instructions).toMatch(/A2A/);
    expect(instructions).toContain("1.0");
    expect(instructions).not.toMatch(/[\u2013\u2014]/);
  });

  it("stamps serverInfo with the package name", async () => {
    const result = expectResult(await postModern(url, "server/discover"));
    const meta = result["_meta"] as Record<string, { name?: string; version?: string }>;
    expect(meta["io.modelcontextprotocol/serverInfo"]?.name).toBe("a2a-to-mcp");
    expect(meta["io.modelcontextprotocol/serverInfo"]?.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("tools/list on the 2026-07-28 route", () => {
  it("lists exactly the four generic tools with MCP-valid names", async () => {
    const result = expectResult(await postModern(url, "tools/list"));
    const tools = result["tools"] as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
  });

  it("gives every tool an object inputSchema whose agent argument is an enum of the aliases", async () => {
    const result = expectResult(await postModern(url, "tools/list"));
    const tools = result["tools"] as Array<{
      name: string;
      description?: string;
      inputSchema: { type: string; properties?: Record<string, { enum?: string[] }>; required?: string[] };
    }>;
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties?.["agent"]?.enum?.sort()).toEqual(["fixture", "other"]);
      expect(tool.inputSchema.required).toContain("agent");
      expect(tool.description).toBeTruthy();
      expect(tool.description).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("states the handle retention policy in the description of the tool that mints handles", async () => {
    const result = expectResult(await postModern(url, "tools/list"));
    const tools = result["tools"] as Array<{ name: string; description?: string }>;
    const send = tools.find((tool) => tool.name === "a2a_send_message");
    expect(send?.description).toMatch(/handle/i);
    expect(send?.description).toMatch(/\d+ (minutes|seconds)/);
    expect(send?.description).toMatch(/expired/i);
  });

  it("carries resultType complete, ttlMs and cacheScope", async () => {
    const result = expectResult(await postModern(url, "tools/list"));
    expect(result["resultType"]).toBe("complete");
    expect(typeof result["ttlMs"]).toBe("number");
    expect(["public", "private"]).toContain(result["cacheScope"]);
  });
});

describe("mandatory headers and envelope on the 2026-07-28 route", () => {
  it("rejects a disagreement between Mcp-Method and the body with -32020 and HTTP 400", async () => {
    const exchange = await postModern(url, "tools/list", {}, { headers: { "Mcp-Method": "server/discover" } });
    expect(exchange.status).toBe(400);
    expect(expectError(exchange).code).toBe(-32020);
  });

  it("rejects a missing Mcp-Method header", async () => {
    const exchange = await postModern(url, "tools/list", {}, { headers: { "Mcp-Method": undefined } });
    expect(exchange.status).toBeGreaterThanOrEqual(400);
    expect(expectError(exchange).code).toBe(-32020);
  });

  it("rejects a modern request without the per-request envelope with -32602", async () => {
    const exchange = await postModern(url, "tools/list", {}, { omitEnvelope: true });
    expect(expectError(exchange).code).toBe(-32602);
  });

  it("rejects a Mcp-Name header that disagrees with the tool name in the body", async () => {
    const exchange = await postModern(
      url,
      "tools/call",
      { name: "a2a_discover", arguments: { agent: "fixture" } },
      { headers: { "Mcp-Name": "a2a_get_task" } },
    );
    expect(exchange.status).toBe(400);
    expect(expectError(exchange).code).toBe(-32020);
  });

  it("answers an unknown method with -32601", async () => {
    expect(expectError(await postModern(url, "acme/unknown")).code).toBe(-32601);
  });
});

describe("the 2025-11-25 route on the same endpoint (D01)", () => {
  it("negotiates the legacy revision through initialize", async () => {
    const session = new LegacySession(url);
    const result = expectResult(await session.initialize());
    expect(result["protocolVersion"]).toBe(LEGACY_VERSION);
    expect((result["serverInfo"] as { name: string }).name).toBe("a2a-to-mcp");
    await session.close();
  });

  it("lists the same four tools on the legacy session", async () => {
    const session = new LegacySession(url);
    await session.initialize();
    const result = expectResult(await session.post("tools/list"));
    const tools = result["tools"] as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    await session.close();
  });
});

describe("tool execution errors are results, not protocol errors", () => {
  it("returns isError with the known aliases when the agent alias is unknown", async () => {
    const result = expectResult(
      await postModern(url, "tools/call", { name: "a2a_discover", arguments: { agent: "nope" } }),
    );
    expect(result["isError"]).toBe(true);
    expect(result["resultType"]).toBe("complete");
    const text = textOf(result);
    expect(text).toContain("nope");
    expect(text).toContain("fixture");
    expect(text).toContain("other");
  });

  it("returns isError naming the card URL when the agent card cannot be fetched", async () => {
    const result = expectResult(
      await postModern(url, "tools/call", { name: "a2a_discover", arguments: { agent: "fixture" } }),
    );
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toContain(UNREACHABLE_CARD);
  });

  it("rejects a call without the required agent argument with -32602", async () => {
    const exchange = await postModern(url, "tools/call", { name: "a2a_discover", arguments: {} });
    expect(expectError(exchange).code).toBe(-32602);
  });

  it("answers an unknown handle on a2a_get_task with isError and an explicit message", async () => {
    const result = expectResult(
      await postModern(url, "tools/call", {
        name: "a2a_get_task",
        arguments: { agent: "fixture", taskHandle: "tk_doesnotexist" },
      }),
    );
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toMatch(/unknown/i);
    expect(textOf(result)).toContain("tk_doesnotexist");
  });
});

describe("tasks/* reach the bridge on both routes (D06)", () => {
  it.each(["tasks/get", "tasks/cancel"])(
    "%s on the modern route is served by the bridge, never -32601 from the SDK guard",
    async (method) => {
      const exchange = await postModern(
        url,
        method,
        { taskId: "tk_doesnotexist" },
        { clientCapabilities: TASKS_CLIENT_CAPABILITIES },
      );
      const error = expectError(exchange);
      expect(error.code).not.toBe(-32601);
      expect(error.message).toMatch(/task/i);
      expect(error.message).toContain("tk_doesnotexist");
    },
  );

  it("tasks/update on the modern route is served by the bridge", async () => {
    const exchange = await postModern(
      url,
      "tasks/update",
      { taskId: "tk_doesnotexist", inputResponses: {} },
      { clientCapabilities: TASKS_CLIENT_CAPABILITIES },
    );
    const error = expectError(exchange);
    expect(error.code).not.toBe(-32601);
    expect(error.message).toContain("tk_doesnotexist");
  });

  it("still validates the Mcp-Method header against the body on intercepted methods", async () => {
    const exchange = await postModern(
      url,
      "tools/list",
      {},
      { headers: { "Mcp-Method": "tasks/get" }, clientCapabilities: TASKS_CLIENT_CAPABILITIES },
    );
    expect(exchange.status).toBe(400);
    expect(expectError(exchange).code).toBe(-32020);
  });

  it("still requires the per-request envelope on intercepted methods", async () => {
    const exchange = await postModern(url, "tasks/get", { taskId: "tk_x" }, { omitEnvelope: true });
    expect(expectError(exchange).code).toBe(-32602);
  });

  it.each(["tasks/get", "tasks/cancel", "tasks/update"])(
    "%s without the extension declared answers -32021 with the required capability in data",
    async (method) => {
      const params: Record<string, unknown> =
        method === "tasks/update" ? { taskId: "tk_x", inputResponses: {} } : { taskId: "tk_x" };
      const exchange = await postModern(url, method, params, { clientCapabilities: {} });
      const error = expectError(exchange);
      expect(error.code).toBe(-32021);
      expect(error.message).toContain(TASKS_EXTENSION);
      expect(error.data).toMatchObject({
        requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
      });
    },
  );

  it("answers -32602 for an unknown or expired task handle, as the extension requires", async () => {
    const exchange = await postModern(
      url,
      "tasks/get",
      { taskId: "tk_doesnotexist" },
      { clientCapabilities: TASKS_CLIENT_CAPABILITIES },
    );
    expect(expectError(exchange).code).toBe(-32602);
  });

  it("requires Mcp-Name to carry the taskId on tasks/* and rejects a disagreement with -32020", async () => {
    const mismatch = await postModern(
      url,
      "tasks/get",
      { taskId: "tk_doesnotexist" },
      { clientCapabilities: TASKS_CLIENT_CAPABILITIES, headers: { "Mcp-Name": "tk_other" } },
    );
    expect(mismatch.status).toBe(400);
    expect(expectError(mismatch).code).toBe(-32020);
    const missing = await postModern(
      url,
      "tasks/get",
      { taskId: "tk_doesnotexist" },
      { clientCapabilities: TASKS_CLIENT_CAPABILITIES, headers: { "Mcp-Name": undefined } },
    );
    expect(missing.status).toBe(400);
    expect(expectError(missing).code).toBe(-32020);
  });

  it("legacy route without the extension declared answers -32021 too", async () => {
    const session = new LegacySession(url, {});
    await session.initialize();
    const error = expectError(await session.post("tasks/get", { taskId: "tk_x" }));
    expect(error.code).toBe(-32021);
    await session.close();
  });

  it("tasks/get on the legacy route answers -32021 whatever the client declared: the extension is 2026-07-28 only (D08)", async () => {
    const session = new LegacySession(url, TASKS_CLIENT_CAPABILITIES);
    await session.initialize();
    const error = expectError(await session.post("tasks/get", { taskId: "tk_doesnotexist" }));
    expect(error.code).toBe(-32021);
    expect(error.message).toContain(MODERN_VERSION);
    await session.close();
  });

  it("never sets Mcp-Session-Id on the legacy initialize response: the bridge holds no session", async () => {
    const session = new LegacySession(url);
    const exchange = await session.initialize();
    expect(exchange.headers.get("mcp-session-id")).toBeNull();
    await session.close();
  });
});
