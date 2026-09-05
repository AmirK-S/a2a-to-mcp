/**
 * Step 4: a2a_send_message when the agent answers synchronously, either with
 * a direct Message or with a Task that is already terminal when SendMessage
 * returns. No tasks extension declared by the client here: everything is a
 * plain CallToolResult with resultType complete.
 *
 * Result contract (documented in README):
 *   content            blocks translated from the Message parts or from the
 *                      artifacts and status message of the Task
 *   structuredContent  { kind: "message" | "task", contextHandle, taskHandle?,
 *                        a2aState?, status?, note?, artifacts?, data? }
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

interface Envelope {
  kind: "message" | "task";
  contextHandle: string;
  taskHandle?: string;
  a2aState?: string;
  status?: string;
  note?: string;
  artifacts?: Array<{ artifactId: string; name: string }>;
  data?: unknown;
}

async function send(text: string, extra: Record<string, unknown> = {}) {
  const result = expectResult(
    await postModern(url, "tools/call", {
      name: "a2a_send_message",
      arguments: { agent: "fixture", text, ...extra },
    }),
  );
  return { result, envelope: result["structuredContent"] as Envelope };
}

describe("a direct Message reply", () => {
  it("comes back as text content with kind message and a context handle", async () => {
    const { result, envelope } = await send("echo: bonjour");
    expect(result["isError"]).toBeFalsy();
    expect(result["resultType"]).toBe("complete");
    expect(textOf(result)).toBe("bonjour");
    expect(envelope.kind).toBe("message");
    expect(envelope.contextHandle).toMatch(/^cx_/);
    expect(envelope.taskHandle).toBeUndefined();
  });

  it("reuses the context when the handle is passed back", async () => {
    const first = await send("echo: one");
    const second = await send("echo: two", { contextHandle: first.envelope.contextHandle });
    expect(second.envelope.contextHandle).toBe(first.envelope.contextHandle);
  });

  it("returns isError for an unknown context handle instead of silently starting a new context", async () => {
    const { result } = await send("echo: x", { contextHandle: "cx_unknown" });
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toContain("cx_unknown");
  });
});

describe("a Task that is terminal when SendMessage returns", () => {
  it("completed: artifacts become content blocks, the envelope carries the handle and the exact state", async () => {
    const { result, envelope } = await send("task: abc");
    expect(result["isError"]).toBeFalsy();
    expect(textOf(result)).toContain("cba");
    expect(envelope.kind).toBe("task");
    expect(envelope.taskHandle).toMatch(/^tk_/);
    expect(envelope.contextHandle).toMatch(/^cx_/);
    expect(envelope.a2aState).toBe("TASK_STATE_COMPLETED");
    expect(envelope.status).toBe("completed");
    expect(envelope.note).toBeUndefined();
    expect(envelope.artifacts?.[0]?.name).toBe("result");
    const blocks = result["content"] as Array<{ _meta?: Record<string, { artifactId?: string }> }>;
    expect(blocks.some((block) => block._meta?.["io.github.amirk-s/a2a"]?.artifactId)).toBe(true);
  });

  it("rejected: maps to failed, isError, and the loss is written in the note", async () => {
    const { result, envelope } = await send("reject");
    expect(result["isError"]).toBe(true);
    expect(envelope.a2aState).toBe("TASK_STATE_REJECTED");
    expect(envelope.status).toBe("failed");
    expect(envelope.note).toMatch(/rejected/i);
    expect(textOf(result)).toContain("This agent declines the request.");
  });

  it("failed: maps to failed with the agent message", async () => {
    const { result, envelope } = await send("fail");
    expect(result["isError"]).toBe(true);
    expect(envelope.status).toBe("failed");
    expect(textOf(result)).toContain("Simulated failure.");
  });

  it("auth required: maps to failed, never to input_required, and keeps the out-of-band hint", async () => {
    const { result, envelope } = await send("auth");
    expect(result["isError"]).toBe(true);
    expect(envelope.a2aState).toBe("TASK_STATE_AUTH_REQUIRED");
    expect(envelope.status).toBe("failed");
    expect(envelope.note).toMatch(/auth/i);
    expect(textOf(result)).toContain("https://example.invalid/authorize");
  });

  it("data part: the single data part becomes envelope.data and a JSON text block", async () => {
    const { result, envelope } = await send("data: hello");
    expect(envelope.data).toEqual({ answer: 42, echo: "hello" });
    expect(JSON.parse(textOf(result))).toEqual({ answer: 42, echo: "hello" });
  });

  it("url part: becomes a resource_link block", async () => {
    const { result } = await send("file");
    const blocks = result["content"] as Array<{ type: string; uri?: string; name?: string }>;
    const link = blocks.find((block) => block.type === "resource_link");
    expect(link?.uri).toBe("https://example.invalid/files/report.pdf");
    expect(link?.name).toBe("report.pdf");
  });

  it("raw image part: becomes an image block in base64 with the filename in _meta", async () => {
    const { result } = await send("image");
    const blocks = result["content"] as Array<{
      type: string;
      mimeType?: string;
      data?: string;
      _meta?: Record<string, { filename?: string }>;
    }>;
    const image = blocks.find((block) => block.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(Buffer.from(image?.data ?? "", "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(image?._meta?.["io.github.amirk-s/a2a"]?.filename).toBe("pixel.png");
  });
});

describe("a Task interrupted in INPUT_REQUIRED without the tasks extension", () => {
  it("is returned as a task envelope in input_required with the agent question, not as an MCP task", async () => {
    const { result, envelope } = await send("ask: colour");
    expect(result["resultType"]).toBe("complete");
    expect(envelope.kind).toBe("task");
    expect(envelope.a2aState).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(envelope.status).toBe("input_required");
    expect(textOf(result)).toContain("What value should I use for colour?");
  });

  it("continues the same A2A task when the task handle is passed back with the answer", async () => {
    const first = await send("ask: colour");
    const second = await send("blue", { taskHandle: first.envelope.taskHandle });
    expect(second.envelope.taskHandle).toBe(first.envelope.taskHandle);
    expect(second.envelope.status).toBe("completed");
    expect(textOf(second.result)).toContain("colour = blue");
  });
});

describe("argument validation", () => {
  it("requires text", async () => {
    const exchange = await postModern(url, "tools/call", {
      name: "a2a_send_message",
      arguments: { agent: "fixture" },
    });
    expect(exchange.body.error?.code).toBe(-32602);
  });

  it("returns isError for an unknown task handle", async () => {
    const { result } = await send("blue", { taskHandle: "tk_unknown" });
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toContain("tk_unknown");
  });
});
