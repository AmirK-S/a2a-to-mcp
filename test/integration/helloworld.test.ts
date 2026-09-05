/**
 * The bridge against the official A2A example agent, not against the local
 * fixture: `samples/python/agents/helloworld` of a2aproject/a2a-samples,
 * pinned to commit 6603ba3f, running on a2a-sdk 1.1.0.
 *
 * The fixture agent is written to the bridge's own reading of the A2A v1.0.1
 * wire; this file is the counter-check, where the wire is produced by the
 * reference Python SDK. It only asserts what the official sample actually
 * does: one task per message, SUBMITTED, WORKING, one text/plain artifact,
 * COMPLETED, with no pause in WORKING and no input required.
 *
 * The agent is not started by the test: start it out of band, so that the
 * dependency on uv and on a network clone stays outside the test runner.
 *
 *   scripts/helloworld/run.sh
 *   HELLOWORLD_URL=http://127.0.0.1:9999 npx vitest run test/integration/helloworld.test.ts
 *   scripts/helloworld/stop.sh
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config.js";
import { createBridge, type Bridge } from "../../src/server.js";
import {
  TASKS_CLIENT_CAPABILITIES,
  expectResult,
  postModern,
  textOf,
  type WireExchange,
} from "../helpers/mcp-http.js";

const HELLOWORLD_URL = process.env["HELLOWORLD_URL"];

const HOW_TO_RUN =
  "helloworld integration tests skipped: HELLOWORLD_URL is not set. " +
  "Start the official sample with scripts/helloworld/run.sh, then run " +
  "HELLOWORLD_URL=http://127.0.0.1:9999 npm run test:helloworld " +
  "(and scripts/helloworld/stop.sh afterwards).";

if (HELLOWORLD_URL === undefined || HELLOWORLD_URL === "") {
  // Written straight to stderr: the runner reports a skipped file without a
  // reason, and the reason is the only thing worth reading here.
  process.stderr.write(`${HOW_TO_RUN}\n`);
}

/** Text the sample's executor puts in its artifact, from agent_executor.py. */
const ARTIFACT_PREFIX = "Hello, World! I have received your request";

let bridge: Bridge;
let url: string;

interface Envelope {
  kind: "message" | "task";
  contextHandle: string;
  taskHandle?: string;
  a2aState?: string;
  status?: string;
  note?: string;
  artifacts?: Array<{ artifactId: string; name: string }>;
  history?: unknown[];
}

function send(text: string, options: Record<string, unknown> = {}): Promise<WireExchange> {
  return postModern(
    url,
    "tools/call",
    { name: "a2a_send_message", arguments: { agent: "hello", text } },
    options,
  );
}

function getTask(taskId: string): Promise<WireExchange> {
  return postModern(url, "tasks/get", { taskId }, { clientCapabilities: TASKS_CLIENT_CAPABILITIES });
}

/** Same shape as the fixture suite: read back until the predicate holds. */
async function pollUntil(
  taskId: string,
  predicate: (task: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
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

describe.skipIf(HELLOWORLD_URL === undefined || HELLOWORLD_URL === "")(
  "the official helloworld sample (a2a-samples 6603ba3f, a2a-sdk 1.1.0)",
  () => {
    beforeAll(async () => {
      // createBridge takes cardUrl; parseConfig is what turns the agent base
      // URL into the well-known card path, so the base URL is declared here
      // the way a user declares it in a configuration file.
      const config = parseConfig({ agents: { hello: { url: HELLOWORLD_URL } } });
      bridge = await createBridge({ agents: config.agents });
      url = (await bridge.listen(0)).url;
    });

    afterAll(async () => {
      await bridge?.close();
    });

    describe("a2a_discover", () => {
      it("returns the card the sample publishes, unaltered", async () => {
        const result = expectResult(
          await postModern(url, "tools/call", {
            name: "a2a_discover",
            arguments: { agent: "hello" },
          }),
        );
        expect(result["isError"]).toBeFalsy();
        const card = result["structuredContent"] as Record<string, unknown>;
        expect(card["name"]).toBe("Hello World Agent");
        expect(card["description"]).toBe("Just a hello world agent");
        expect(card["version"]).toBe("0.0.1");
        expect(card["capabilities"]).toMatchObject({ streaming: true });

        const skills = card["skills"] as Array<{ id: string; name: string }>;
        expect(skills.length).toBeGreaterThanOrEqual(1);
        expect(skills.map((skill) => skill.id)).toContain("echo_bot");

        // v1.0 card: interfaces are declared, JSONRPC at protocol version 1.0.
        const interfaces = card["supportedInterfaces"] as Array<{
          protocolBinding: string;
          protocolVersion: string;
        }>;
        expect(interfaces.some((entry) => entry.protocolBinding === "JSONRPC")).toBe(true);
        expect(interfaces[0]?.protocolVersion).toBe("1.0");
      });

      it("summarises the sample in text for clients that ignore structuredContent", async () => {
        const result = expectResult(
          await postModern(url, "tools/call", {
            name: "a2a_discover",
            arguments: { agent: "hello" },
          }),
        );
        const text = textOf(result);
        expect(text).toContain("Hello World Agent");
        expect(text).toContain("echo_bot");
      });
    });

    describe("a2a_send_message without the tasks extension", () => {
      it("comes back synchronously completed, with the artifact text as content", async () => {
        const result = expectResult(await send("bonjour pont"));
        expect(result["isError"]).toBeFalsy();
        expect(result["resultType"]).toBe("complete");

        // The sample echoes the request inside its single text/plain artifact.
        expect(textOf(result)).toContain(ARTIFACT_PREFIX);
        expect(textOf(result)).toContain("bonjour pont");

        const envelope = result["structuredContent"] as Envelope;
        expect(envelope.kind).toBe("task");
        expect(envelope.a2aState).toBe("TASK_STATE_COMPLETED");
        expect(envelope.status).toBe("completed");
        expect(envelope.note).toBeUndefined();
        expect(envelope.taskHandle).toMatch(/^tk_/);
        expect(envelope.contextHandle).toMatch(/^cx_/);
        expect(envelope.artifacts?.length).toBeGreaterThanOrEqual(1);
      });

      it("opens a fresh context for each call and reuses one that is handed back", async () => {
        const first = expectResult(await send("one"));
        const firstEnvelope = first["structuredContent"] as Envelope;
        const second = expectResult(
          await postModern(url, "tools/call", {
            name: "a2a_send_message",
            arguments: {
              agent: "hello",
              text: "two",
              contextHandle: firstEnvelope.contextHandle,
            },
          }),
        );
        expect((second["structuredContent"] as Envelope).contextHandle).toBe(
          firstEnvelope.contextHandle,
        );
      });
    });

    describe("a2a_send_message with the tasks extension declared", () => {
      it("either hands out a task to poll or answers inline, and completes with the artifact either way", async () => {
        const result = expectResult(
          await send("tache pontee", { clientCapabilities: TASKS_CLIENT_CAPABILITIES }),
        );

        // The sample emits SUBMITTED, WORKING, the artifact and COMPLETED in
        // one pass, with no pause: depending on which event the bridge holds
        // when SendMessage returns, both arms are legitimate here.
        if (result["resultType"] === "task") {
          const taskId = result["taskId"] as string;
          expect(taskId).toMatch(/^tk_/);
          const task = await pollUntil(taskId, (candidate) =>
            ["completed", "failed", "cancelled"].includes(candidate["status"] as string),
          );
          expect(task["status"]).toBe("completed");
          const inner = task["result"] as Record<string, unknown>;
          expect(inner["isError"]).toBeFalsy();
          expect(textOf(inner)).toContain(ARTIFACT_PREFIX);
          expect(textOf(inner)).toContain("tache pontee");
          const envelope = inner["structuredContent"] as Envelope;
          expect(envelope.a2aState).toBe("TASK_STATE_COMPLETED");
          expect(envelope.taskHandle).toBe(taskId);
        } else {
          expect(result["resultType"]).toBe("complete");
          expect(textOf(result)).toContain(ARTIFACT_PREFIX);
          expect(textOf(result)).toContain("tache pontee");
          const envelope = result["structuredContent"] as Envelope;
          expect(envelope.a2aState).toBe("TASK_STATE_COMPLETED");
          expect(envelope.status).toBe("completed");
        }
      });
    });

    describe("a2a_get_task", () => {
      it("reads the finished task back through the handle, trimming the history to one message", async () => {
        const sent = expectResult(await send("relis moi"));
        const handle = (sent["structuredContent"] as Envelope).taskHandle;
        expect(handle).toBeDefined();

        const result = expectResult(
          await postModern(url, "tools/call", {
            name: "a2a_get_task",
            arguments: { agent: "hello", taskHandle: handle, historyLength: 1 },
          }),
        );
        expect(result["isError"]).toBeFalsy();
        const envelope = result["structuredContent"] as Envelope;
        expect(envelope.kind).toBe("task");
        expect(envelope.taskHandle).toBe(handle);
        expect(envelope.a2aState).toBe("TASK_STATE_COMPLETED");
        // historyLength is passed through to GetTask: the sample keeps two
        // messages in the task, and asking for one must not return two.
        expect(envelope.history).toBeDefined();
        expect(envelope.history?.length ?? 0).toBeLessThanOrEqual(1);
      });

      it("reports an unknown handle as a tool error rather than a JSON-RPC error", async () => {
        const result = expectResult(
          await postModern(url, "tools/call", {
            name: "a2a_get_task",
            arguments: { agent: "hello", taskHandle: "tk_unknown" },
          }),
        );
        expect(result["isError"]).toBe(true);
        expect(textOf(result)).toContain("tk_unknown");
      });
    });
  },
);
