/**
 * The synchronous side: a client that declares elicitation but not the tasks
 * extension (Claude Code, measured with 2.1.263, declares exactly {roots,
 * elicitation}) gets the A2A INPUT_REQUIRED interruption as a multi round
 * trip request (MCP 2026-07-28, basic/patterns/mrtr): resultType
 * input_required, one form elicitation, an opaque requestState, and the
 * client replays tools/call with inputResponses and a fresh id.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFixtureAgent } from "../../fixtures/agent/index.js";
import { createBridge, type Bridge } from "../../src/server.js";
import { expectError, expectResult, postModern, textOf } from "../helpers/mcp-http.js";

const ELICITING_CLIENT = { clientCapabilities: { elicitation: {} } };

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

const args = (text: string) => ({ name: "a2a_send_message", arguments: { agent: "fixture", text } });

describe("INPUT_REQUIRED becomes an input_required result for an eliciting client", () => {
  it("returns resultType input_required with one form elicitation carrying the agent question", async () => {
    const result = expectResult(await postModern(url, "tools/call", args("ask: colour"), ELICITING_CLIENT));
    expect(result["resultType"]).toBe("input_required");
    expect(typeof result["requestState"]).toBe("string");
    expect((result["requestState"] as string).length).toBeGreaterThan(10);
    const inputRequests = result["inputRequests"] as Record<string, { method: string; params: Record<string, unknown> }>;
    const keys = Object.keys(inputRequests);
    expect(keys).toHaveLength(1);
    const request = inputRequests[keys[0]!]!;
    expect(request.method).toBe("elicitation/create");
    expect(request.params["mode"]).toBe("form");
    expect(request.params["message"]).toContain("What value should I use for colour?");
    expect(result["content"]).toBeUndefined();
  });

  it("the requestState does not leak the A2A task id or context id", async () => {
    const result = expectResult(await postModern(url, "tools/call", args("ask: colour"), ELICITING_CLIENT));
    const state = result["requestState"] as string;
    expect(state).not.toMatch(/task-|ctx-|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("replaying tools/call with the accepted answer and the requestState completes the same A2A task", async () => {
    const first = expectResult(await postModern(url, "tools/call", args("ask: size"), ELICITING_CLIENT));
    const inputRequests = first["inputRequests"] as Record<string, { params: { requestedSchema: { properties: Record<string, unknown> } } }>;
    const key = Object.keys(inputRequests)[0]!;
    const field = Object.keys(inputRequests[key]!.params.requestedSchema.properties)[0]!;
    const replay = expectResult(
      await postModern(
        url,
        "tools/call",
        {
          ...args("ask: size"),
          inputResponses: { [key]: { action: "accept", content: { [field]: "large" } } },
          requestState: first["requestState"],
        },
        ELICITING_CLIENT,
      ),
    );
    expect(replay["resultType"]).toBe("complete");
    expect(textOf(replay)).toContain("size = large");
    const envelope = replay["structuredContent"] as { status: string; taskHandle: string };
    expect(envelope.status).toBe("completed");
    expect(envelope.taskHandle).toMatch(/^tk_/);
  });

  it("a declined elicitation cancels the A2A task and reports it", async () => {
    const first = expectResult(await postModern(url, "tools/call", args("ask: shape"), ELICITING_CLIENT));
    const key = Object.keys(first["inputRequests"] as Record<string, unknown>)[0]!;
    const replay = expectResult(
      await postModern(
        url,
        "tools/call",
        {
          ...args("ask: shape"),
          inputResponses: { [key]: { action: "decline" } },
          requestState: first["requestState"],
        },
        ELICITING_CLIENT,
      ),
    );
    expect(replay["resultType"]).toBe("complete");
    expect((replay["structuredContent"] as { status: string }).status).toBe("cancelled");
  });

  it("rejects a tampered requestState with -32602 instead of acting on it", async () => {
    const first = expectResult(await postModern(url, "tools/call", args("ask: weight"), ELICITING_CLIENT));
    const key = Object.keys(first["inputRequests"] as Record<string, unknown>)[0]!;
    const state = first["requestState"] as string;
    const tampered = state.slice(0, -4) + (state.endsWith("AAAA") ? "BBBB" : "AAAA");
    const exchange = await postModern(
      url,
      "tools/call",
      {
        ...args("ask: weight"),
        inputResponses: { [key]: { action: "accept", content: { answer: "x" } } },
        requestState: tampered,
      },
      ELICITING_CLIENT,
    );
    expect(expectError(exchange).code).toBe(-32602);
  });
});

describe("clients without elicitation keep the envelope fallback", () => {
  it("returns the task envelope in input_required with the handle when nothing is declared", async () => {
    const result = expectResult(await postModern(url, "tools/call", args("ask: colour")));
    expect(result["resultType"]).toBe("complete");
    expect((result["structuredContent"] as { status: string }).status).toBe("input_required");
    expect(textOf(result)).toContain("What value should I use for colour?");
  });
});
