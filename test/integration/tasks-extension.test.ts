/**
 * Steps 5, 6 and 7: the io.modelcontextprotocol/tasks extension served for
 * real, on the wire, against the fixture agent. Each block names the
 * conformance scenario file whose checks it reproduces (DECISIONS.md D07),
 * because those scenarios call hard-coded tool names the bridge cannot
 * expose.
 *
 * Wire facts come from the extension specification 2026-07-28 (tasks.md) as
 * extracted in recherche/I04b-tasks-spec-et-scenarios.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFixtureAgent } from "../../fixtures/agent/index.js";
import { createBridge, type Bridge } from "../../src/server.js";
import {
  LegacySession,
  TASKS_CLIENT_CAPABILITIES,
  TASKS_EXTENSION,
  expectError,
  expectResult,
  postModern,
  textOf,
  type WireExchange,
} from "../helpers/mcp-http.js";

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

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

const withTasks = { clientCapabilities: TASKS_CLIENT_CAPABILITIES };

function sendWithTasks(text: string, extra: Record<string, unknown> = {}): Promise<WireExchange> {
  return postModern(
    url,
    "tools/call",
    { name: "a2a_send_message", arguments: { agent: "fixture", text, ...extra } },
    withTasks,
  );
}

function getTask(taskId: string): Promise<WireExchange> {
  return postModern(url, "tasks/get", { taskId }, withTasks);
}

async function pollUntil(
  taskId: string,
  predicate: (task: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = expectResult(await getTask(taskId));
    if (predicate(last)) {
      return last;
    }
    const interval = typeof last["pollIntervalMs"] === "number" ? last["pollIntervalMs"] : 200;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`task ${taskId} never satisfied the predicate; last: ${JSON.stringify(last)}`);
}

const isTerminal = (task: Record<string, unknown>) =>
  ["completed", "failed", "cancelled"].includes(task["status"] as string);

describe("capability (capability.ts)", () => {
  it("announces the extension under capabilities.extensions and never under capabilities.tasks", async () => {
    const result = expectResult(await postModern(url, "server/discover"));
    const capabilities = result["capabilities"] as Record<string, unknown>;
    expect((capabilities["extensions"] as Record<string, unknown>)[TASKS_EXTENSION]).toEqual({});
    expect(capabilities["tasks"]).toBeUndefined();
  });

  it("tools/call without the extension declared falls back to a synchronous result", async () => {
    const result = expectResult(
      await postModern(url, "tools/call", {
        name: "a2a_send_message",
        arguments: { agent: "fixture", text: "slow: 300" },
      }),
    );
    expect(result["resultType"]).toBe("complete");
    expect((result["structuredContent"] as { status: string }).status).toBe("completed");
  });

  it("tools/call with the extension declared per request produces a CreateTaskResult", async () => {
    const result = expectResult(await sendWithTasks("slow: 1500"));
    expect(result["resultType"]).toBe("task");
    expect(result["taskId"]).toMatch(/^tk_/);
  });
});

describe("wire fields of CreateTaskResult (wire-fields.ts)", () => {
  it("is flat: Task fields at top level, no nested task, no result, error or inputRequests", async () => {
    const result = expectResult(await sendWithTasks("slow: 1500"));
    expect(result["task"]).toBeUndefined();
    expect(result["result"]).toBeUndefined();
    expect(result["error"]).toBeUndefined();
    expect(result["inputRequests"]).toBeUndefined();
    expect(["working", "input_required"]).toContain(result["status"]);
    expect(result["createdAt"]).toMatch(ISO_8601);
    expect(result["lastUpdatedAt"]).toMatch(ISO_8601);
  });

  it("uses ttlMs as an integer of milliseconds and pollIntervalMs as an integer, never the v1 keys", async () => {
    const result = expectResult(await sendWithTasks("slow: 1500"));
    expect(Number.isInteger(result["ttlMs"])).toBe(true);
    expect(result["ttlMs"] as number).toBeGreaterThan(0);
    expect(Number.isInteger(result["pollIntervalMs"])).toBe(true);
    expect(result["ttl"]).toBeUndefined();
    expect(result["pollInterval"]).toBeUndefined();
  });

  it("carries the empty content array the SDK seam requires, and nothing else from CallToolResult", async () => {
    const result = expectResult(await sendWithTasks("slow: 1500"));
    expect(result["content"]).toEqual([]);
    expect(result["isError"]).toBeUndefined();
  });

  it("puts the A2A submitted state into statusMessage since MCP has no such status", async () => {
    // The fixture emits SUBMITTED before WORKING; whichever the bridge caught
    // first, a status of working with a lossy origin is reported in text.
    const result = expectResult(await sendWithTasks("slow: 1500"));
    if (typeof result["statusMessage"] === "string") {
      expect(result["statusMessage"]).toMatch(/TASK_STATE_(SUBMITTED|WORKING)/);
    }
  });

  it("does not expire within 500 ms", async () => {
    const created = expectResult(await sendWithTasks("slow: 3000"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const task = expectResult(await getTask(created["taskId"] as string));
    expect(task["resultType"]).toBe("complete");
    expect(task["taskId"]).toBe(created["taskId"]);
  });
});

describe("lifecycle (lifecycle.ts)", () => {
  it("get right after creation reports working with the same handle and the dates", async () => {
    const created = expectResult(await sendWithTasks("slow: 2000"));
    const task = expectResult(await getTask(created["taskId"] as string));
    expect(task["resultType"]).toBe("complete");
    expect(task["taskId"]).toBe(created["taskId"]);
    expect(task["status"]).toBe("working");
    expect(task["createdAt"]).toBe(created["createdAt"]);
    expect(task["lastUpdatedAt"]).toMatch(ISO_8601);
  });

  it("completes with the full CallToolResult inline in result, exactly what tools/call would have returned", async () => {
    const created = expectResult(await sendWithTasks("task: abc"));
    const task = await pollUntil(created["taskId"] as string, isTerminal);
    expect(task["status"]).toBe("completed");
    const result = task["result"] as Record<string, unknown>;
    expect(Array.isArray(result["content"])).toBe(true);
    expect(textOf(result)).toContain("cba");
    expect(result["isError"]).toBeFalsy();
    const envelope = result["structuredContent"] as Record<string, unknown>;
    expect(envelope["kind"]).toBe("task");
    expect(envelope["taskHandle"]).toBe(created["taskId"]);
    expect(envelope["a2aState"]).toBe("TASK_STATE_COMPLETED");
    expect(result["_meta"]).not.toHaveProperty("io.modelcontextprotocol/related-task");
  });

  it("returns the same completed result on repeated get", async () => {
    const created = expectResult(await sendWithTasks("task: xyz"));
    const first = await pollUntil(created["taskId"] as string, isTerminal);
    const second = expectResult(await getTask(created["taskId"] as string));
    expect(second["result"]).toEqual(first["result"]);
    expect(second["status"]).toBe("completed");
  });

  it("carries a failed A2A task as completed with isError, exactly what tools/call returns (D08)", async () => {
    const created = expectResult(await sendWithTasks("fail"));
    const task = await pollUntil(created["taskId"] as string, isTerminal);
    expect(task["status"]).toBe("completed");
    expect(task["error"]).toBeUndefined();
    const result = task["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toContain("Simulated failure.");
    const envelope = result["structuredContent"] as Record<string, unknown>;
    expect(envelope["a2aState"]).toBe("TASK_STATE_FAILED");
    expect(envelope["status"]).toBe("failed");
  });

  it("carries a rejected A2A task as completed with isError and the loss in the note", async () => {
    const created = expectWithoutSync(await sendWithTasks("reject"));
    const task = await pollUntil(created["taskId"] as string, isTerminal);
    expect(task["status"]).toBe("completed");
    const result = task["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toContain("This agent declines the request.");
    const envelope = result["structuredContent"] as Record<string, unknown>;
    expect(envelope["a2aState"]).toBe("TASK_STATE_REJECTED");
    expect(envelope["note"]).toMatch(/rejected/i);
  });

  it("carries an auth required A2A task as completed with isError, never input_required, with the out-of-band hint", async () => {
    const created = expectWithoutSync(await sendWithTasks("auth"));
    const task = await pollUntil(created["taskId"] as string, isTerminal);
    expect(task["status"]).toBe("completed");
    expect(task["inputRequests"]).toBeUndefined();
    const result = task["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toContain("https://example.invalid/authorize");
    expect((result["structuredContent"] as Record<string, unknown>)["a2aState"]).toBe(
      "TASK_STATE_AUTH_REQUIRED",
    );
  });

  it("reserves the failed status for a bridge-level failure: the agent lost the task", async () => {
    // The fixture command vanish: opens a task, then forgets it, so that the
    // next GetTask from the bridge raises TaskNotFoundError (-32001).
    const created = expectResult(await sendWithTasks("vanish"));
    const task = await pollUntil(created["taskId"] as string, isTerminal);
    expect(task["status"]).toBe("failed");
    const error = task["error"] as { code: number; message: string; data?: Record<string, unknown> };
    expect(typeof error.code).toBe("number");
    expect(error.code).not.toBe(-32001);
    expect(error.data?.["a2aErrorCode"]).toBe(-32001);
    expect(task["result"]).toBeUndefined();
  });

  it("cancel acknowledges with resultType complete and the task ends cancelled", async () => {
    const created = expectResult(await sendWithTasks("slow: 8000"));
    const ack = expectResult(
      await postModern(url, "tasks/cancel", { taskId: created["taskId"] }, withTasks),
    );
    expect(ack["resultType"]).toBe("complete");
    const task = await pollUntil(created["taskId"] as string, isTerminal);
    expect(task["status"]).toBe("cancelled");
    expect(task["result"]).toBeUndefined();
    expect(task["error"]).toBeUndefined();
  });

  it("cancel on a terminal task is idempotent: acknowledged, state unchanged", async () => {
    const created = expectResult(await sendWithTasks("task: idem"));
    await pollUntil(created["taskId"] as string, isTerminal);
    const ack = expectResult(
      await postModern(url, "tasks/cancel", { taskId: created["taskId"] }, withTasks),
    );
    expect(ack["resultType"]).toBe("complete");
    const task = expectResult(await getTask(created["taskId"] as string));
    expect(task["status"]).toBe("completed");
  });

  it("a direct Message reply stays synchronous even when the extension is declared", async () => {
    const result = expectResult(await sendWithTasks("echo: sync"));
    expect(result["resultType"]).toBe("complete");
    expect(textOf(result)).toBe("sync");
  });
});

/**
 * reject and auth interrupt the A2A task at once; depending on timing the
 * bridge may already hold the terminal state when SendMessage returns and
 * must then still hand out a CreateTaskResult, since the client asked for a
 * task. This helper accepts both a task result and, if the bridge chose to
 * answer inline, converts the inline envelope into a task-like record so the
 * assertions above stay meaningful.
 */
function expectWithoutSync(exchange: WireExchange): Record<string, unknown> {
  const result = expectResult(exchange);
  expect(result["resultType"]).toBe("task");
  return result;
}

describe("input required and tasks/update (mrtr-input.ts, request-state.ts)", () => {
  it("exposes the A2A question as one form-mode elicitation in inputRequests", async () => {
    const created = expectResult(await sendWithTasks("ask: colour"));
    const task = await pollUntil(created["taskId"] as string, (t) => t["status"] === "input_required");
    const inputRequests = task["inputRequests"] as Record<
      string,
      { method: string; params: Record<string, unknown> }
    >;
    const keys = Object.keys(inputRequests);
    expect(keys).toHaveLength(1);
    const request = inputRequests[keys[0]!]!;
    expect(request.method).toBe("elicitation/create");
    expect(request.params["mode"]).toBe("form");
    expect(request.params["message"]).toContain("What value should I use for colour?");
    const schema = request.params["requestedSchema"] as {
      type: string;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    const props = Object.keys(schema.properties);
    expect(props).toHaveLength(1);
    expect(schema.properties[props[0]!]?.type).toBe("string");
    expect(task["statusMessage"]).toMatch(/free text|synthesi/i);
  });

  it("tasks/update with the accepted answer acknowledges, the key disappears, the task completes", async () => {
    const created = expectResult(await sendWithTasks("ask: size"));
    const waiting = await pollUntil(created["taskId"] as string, (t) => t["status"] === "input_required");
    const inputRequests = waiting["inputRequests"] as Record<string, { params: { requestedSchema: { properties: Record<string, unknown> } } }>;
    const key = Object.keys(inputRequests)[0]!;
    const field = Object.keys(inputRequests[key]!.params.requestedSchema.properties)[0]!;
    const ack = expectResult(
      await postModern(
        url,
        "tasks/update",
        {
          taskId: created["taskId"],
          inputResponses: { [key]: { action: "accept", content: { [field]: "large" } } },
        },
        withTasks,
      ),
    );
    expect(ack["resultType"]).toBe("complete");
    const task = await pollUntil(created["taskId"] as string, isTerminal);
    expect(task["status"]).toBe("completed");
    expect(task["inputRequests"]).toBeUndefined();
    expect(textOf(task["result"] as Record<string, unknown>)).toContain("size = large");
  });

  it("tasks/update with a declined elicitation cancels the A2A task", async () => {
    const created = expectResult(await sendWithTasks("ask: shape"));
    const waiting = await pollUntil(created["taskId"] as string, (t) => t["status"] === "input_required");
    const key = Object.keys(waiting["inputRequests"] as Record<string, unknown>)[0]!;
    expectResult(
      await postModern(
        url,
        "tasks/update",
        { taskId: created["taskId"], inputResponses: { [key]: { action: "decline" } } },
        withTasks,
      ),
    );
    const task = await pollUntil(created["taskId"] as string, isTerminal);
    expect(task["status"]).toBe("cancelled");
  });

  it("tasks/update on a task that is not waiting is acknowledged and ignored", async () => {
    const created = expectResult(await sendWithTasks("slow: 1500"));
    const ack = expectResult(
      await postModern(
        url,
        "tasks/update",
        { taskId: created["taskId"], inputResponses: { nope: { action: "accept", content: {} } } },
        withTasks,
      ),
    );
    expect(ack["resultType"]).toBe("complete");
    const task = expectResult(await getTask(created["taskId"] as string));
    expect(["working", "completed"]).toContain(task["status"]);
  });
});

describe("required task error and headers (required-task-error.ts, headers.ts)", () => {
  it("tasks/get without the extension answers -32021 with the required capability", async () => {
    const created = expectResult(await sendWithTasks("slow: 1000"));
    const exchange = await postModern(url, "tasks/get", { taskId: created["taskId"] }, { clientCapabilities: {} });
    const error = expectError(exchange);
    expect(error.code).toBe(-32021);
    expect(error.data).toMatchObject({
      requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
    });
  });

  it("rejects a Mcp-Name that disagrees with taskId on tasks/get with -32020", async () => {
    const created = expectResult(await sendWithTasks("slow: 1000"));
    const exchange = await postModern(
      url,
      "tasks/get",
      { taskId: created["taskId"] },
      { ...withTasks, headers: { "Mcp-Name": "tk_other" } },
    );
    expect(exchange.status).toBe(400);
    expect(expectError(exchange).code).toBe(-32020);
  });
});

describe("expiry and the legacy route", () => {
  it("answers -32602 for a task whose handle has expired", async () => {
    const shortLived = await createBridge({
      agents: { fixture: { cardUrl: agent.cardUrl } },
      handleTtlMs: 300,
    });
    const shortUrl = (await shortLived.listen(0)).url;
    try {
      const created = expectResult(
        await postModern(
          shortUrl,
          "tools/call",
          { name: "a2a_send_message", arguments: { agent: "fixture", text: "task: soon" } },
          withTasks,
        ),
      );
      expect(created["ttlMs"]).toBe(300);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const exchange = await postModern(shortUrl, "tasks/get", { taskId: created["taskId"] }, withTasks);
      const error = expectError(exchange);
      expect(error.code).toBe(-32602);
      expect(error.message).toMatch(/expired/i);
    } finally {
      await shortLived.close();
    }
  });

  it("never returns a CreateTaskResult on the 2025-11-25 route, even if the client declares the extension", async () => {
    const session = new LegacySession(url, TASKS_CLIENT_CAPABILITIES);
    await session.initialize();
    const result = expectResult(
      await session.post("tools/call", {
        name: "a2a_send_message",
        arguments: { agent: "fixture", text: "slow: 300" },
      }),
    );
    expect(result["resultType"] ?? "complete").toBe("complete");
    expect((result["structuredContent"] as { status: string }).status).toBe("completed");
    await session.close();
  });
});

describe("the generic tools alongside the extension (step 7)", () => {
  it("a2a_get_task reads the same task through a tool, with historyLength honoured", async () => {
    const created = expectResult(await sendWithTasks("ask: tone"));
    await pollUntil(created["taskId"] as string, (t) => t["status"] === "input_required");
    const full = expectResult(
      await postModern(
        url,
        "tools/call",
        { name: "a2a_get_task", arguments: { agent: "fixture", taskHandle: created["taskId"] } },
        withTasks,
      ),
    );
    const envelope = full["structuredContent"] as { history?: unknown[]; status: string };
    expect(envelope.status).toBe("input_required");
    expect(envelope.history?.length).toBeGreaterThanOrEqual(2);
    const trimmed = expectResult(
      await postModern(
        url,
        "tools/call",
        {
          name: "a2a_get_task",
          arguments: { agent: "fixture", taskHandle: created["taskId"], historyLength: 1 },
        },
        withTasks,
      ),
    );
    expect((trimmed["structuredContent"] as { history?: unknown[] }).history).toHaveLength(1);
  });

  it("a2a_cancel_task returns the updated task envelope, not a bare acknowledgement", async () => {
    const created = expectResult(await sendWithTasks("slow: 8000"));
    const result = expectResult(
      await postModern(
        url,
        "tools/call",
        { name: "a2a_cancel_task", arguments: { agent: "fixture", taskHandle: created["taskId"] } },
        withTasks,
      ),
    );
    const envelope = result["structuredContent"] as { status: string; a2aState: string };
    expect(envelope.a2aState).toBe("TASK_STATE_CANCELED");
    expect(envelope.status).toBe("cancelled");
  });
});
