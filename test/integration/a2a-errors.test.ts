/**
 * The nine typed A2A errors (specification section 5.4, codes -32001 to
 * -32009) crossing the bridge. The A2A code is never re-emitted as a JSON-RPC
 * code: JSON-RPC reserves -32000 to -32099 for server-defined errors and MCP
 * already uses -32020, -32021 and -32022 in that band, so a replayed A2A code
 * would claim an MCP meaning it does not have. Every error becomes a tool
 * execution result with isError, the text, and the A2A code in
 * structuredContent.a2aErrorCode.
 *
 * The fixture command "error: <code>" makes the agent raise that error on
 * SendMessage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFixtureAgent } from "../../fixtures/agent/index.js";
import { createBridge, type Bridge } from "../../src/server.js";
import {
  TASKS_CLIENT_CAPABILITIES,
  expectError,
  expectResult,
  postModern,
  textOf,
} from "../helpers/mcp-http.js";

const A2A_ERRORS: Array<[number, string]> = [
  [-32001, "TaskNotFoundError"],
  [-32002, "TaskNotCancelableError"],
  [-32003, "PushNotificationNotSupportedError"],
  [-32004, "UnsupportedOperationError"],
  [-32005, "ContentTypeNotSupportedError"],
  [-32006, "InvalidAgentResponseError"],
  [-32007, "ExtendedAgentCardNotConfiguredError"],
  [-32008, "ExtensionSupportRequiredError"],
  [-32009, "VersionNotSupportedError"],
];

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

describe("the nine A2A errors on a2a_send_message", () => {
  it.each(A2A_ERRORS)("%s becomes an isError result carrying a2aErrorCode, never a JSON-RPC error", async (code, name) => {
    const exchange = await postModern(url, "tools/call", {
      name: "a2a_send_message",
      arguments: { agent: "fixture", text: `error: ${code}` },
    });
    expect(exchange.status).toBe(200);
    expect(exchange.body.error).toBeUndefined();
    const result = expectResult(exchange);
    expect(result["isError"]).toBe(true);
    expect(result["resultType"]).toBe("complete");
    const structured = result["structuredContent"] as Record<string, unknown>;
    expect(structured["a2aErrorCode"]).toBe(code);
    expect(typeof structured["error"]).toBe("string");
    const text = textOf(result);
    expect(text).toContain(String(code));
    expect(text).toContain(name.replace(/Error$/, ""));
  });

  it("does not mint a task or context handle when the agent errors", async () => {
    const result = expectResult(
      await postModern(url, "tools/call", {
        name: "a2a_send_message",
        arguments: { agent: "fixture", text: "error: -32004" },
      }),
    );
    const structured = result["structuredContent"] as Record<string, unknown>;
    expect(structured["taskHandle"]).toBeUndefined();
    expect(structured["contextHandle"]).toBeUndefined();
  });
});

describe("A2A errors on the task tools", () => {
  it("a2a_get_task on a task the agent forgot reports TaskNotFound as an isError result with the code", async () => {
    const created = expectResult(
      await postModern(url, "tools/call", {
        name: "a2a_send_message",
        arguments: { agent: "fixture", text: "vanish" },
      }, { clientCapabilities: TASKS_CLIENT_CAPABILITIES }),
    );
    const taskHandle = created["taskId"] ?? (created["structuredContent"] as { taskHandle?: string })?.taskHandle;
    expect(taskHandle).toMatch(/^tk_/);
    const result = expectResult(
      await postModern(url, "tools/call", {
        name: "a2a_get_task",
        arguments: { agent: "fixture", taskHandle },
      }),
    );
    expect(result["isError"]).toBe(true);
    expect((result["structuredContent"] as Record<string, unknown>)["a2aErrorCode"]).toBe(-32001);
  });

  it("a2a_cancel_task on a completed task reports TaskNotCancelable with the code", async () => {
    const created = expectResult(
      await postModern(url, "tools/call", {
        name: "a2a_send_message",
        arguments: { agent: "fixture", text: "task: done" },
      }),
    );
    const taskHandle = (created["structuredContent"] as { taskHandle: string }).taskHandle;
    const result = expectResult(
      await postModern(url, "tools/call", {
        name: "a2a_cancel_task",
        arguments: { agent: "fixture", taskHandle },
      }),
    );
    expect(result["isError"]).toBe(true);
    expect((result["structuredContent"] as Record<string, unknown>)["a2aErrorCode"]).toBe(-32002);
  });
});

describe("errors on the extension route stay JSON-RPC errors of the bridge, not of A2A", () => {
  it("tasks/get on a vanished task answers failed through the extension, and the A2A code is in data only", async () => {
    const created = expectResult(
      await postModern(url, "tools/call", {
        name: "a2a_send_message",
        arguments: { agent: "fixture", text: "vanish" },
      }, { clientCapabilities: TASKS_CLIENT_CAPABILITIES }),
    );
    expect(created["resultType"]).toBe("task");
    const taskId = created["taskId"] as string;
    let task: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      task = expectResult(
        await postModern(url, "tasks/get", { taskId }, { clientCapabilities: TASKS_CLIENT_CAPABILITIES }),
      );
      if (task["status"] === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(task["status"]).toBe("failed");
    const error = task["error"] as { code: number; data?: { a2aErrorCode?: number } };
    expect(error.code).not.toBe(-32001);
    expect(error.data?.a2aErrorCode).toBe(-32001);
  });

  it("an unknown handle on tasks/get is -32602, the only JSON-RPC error a caller can provoke", async () => {
    const exchange = await postModern(url, "tasks/get", { taskId: "tk_nope" }, { clientCapabilities: TASKS_CLIENT_CAPABILITIES });
    expect(expectError(exchange).code).toBe(-32602);
  });
});
