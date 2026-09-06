/**
 * Integration tests for the deterministic A2A v1.0.1 fixture agent.
 *
 * The agent under test is started on an ephemeral port in `beforeAll` and
 * driven through the official `@a2a-js/sdk/client`, with the JSON-RPC
 * interface selected explicitly (the SDK otherwise picks the first
 * interface listed in the card).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import {
  Client,
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";

import { startFixtureAgent } from "../../fixtures/agent/index.js";

type FixtureAgent = Awaited<ReturnType<typeof startFixtureAgent>>;

let agent: FixtureAgent;
let client: Client;

/** Builds a minimal v1.0 user message carrying a single text part. */
function userMessage(
  text: string,
  overrides: { taskId?: string; contextId?: string } = {},
): Message {
  return {
    messageId: randomUUID(),
    contextId: overrides.contextId ?? "",
    taskId: overrides.taskId ?? "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function sendRequest(
  text: string,
  overrides: { taskId?: string; contextId?: string } = {},
): SendMessageRequest {
  return {
    tenant: "",
    message: userMessage(text, overrides),
    configuration: undefined,
    metadata: undefined,
  };
}

function isTask(result: Message | Task): result is Task {
  return "status" in result;
}

function expectTask(result: Message | Task): Task {
  if (!isTask(result)) {
    throw new Error("expected a Task, received a Message");
  }
  return result;
}

function expectMessage(result: Message | Task): Message {
  if (isTask(result)) {
    throw new Error("expected a Message, received a Task");
  }
  return result;
}

/** Concatenates every text part of a message or artifact. */
function textOf(parts: Part[]): string {
  return parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("");
}

async function collectStream(
  stream: AsyncGenerator<StreamResponse, void, undefined>,
): Promise<StreamResponse[]> {
  const events: StreamResponse[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

beforeAll(async () => {
  agent = await startFixtureAgent({ port: 0 });
  client = await new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory()],
      preferredTransports: ["JSONRPC"],
    }),
  ).createFromUrl(agent.url);
});

afterAll(async () => {
  await agent.close();
});

describe("agent card", () => {
  it("is a v1.0 card served at /.well-known/agent-card.json", async () => {
    const response = await fetch(agent.cardUrl);
    expect(response.status).toBe(200);
    const card = (await response.json()) as AgentCard;

    expect(card.name).toBe("Fixture Agent");
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.capabilities?.pushNotifications).toBe(false);
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);

    // v1.0 marker: `supportedInterfaces`, not the v0.3 `url` +
    // `preferredTransport` pair.
    expect(Array.isArray(card.supportedInterfaces)).toBe(true);
    expect(card.supportedInterfaces).toHaveLength(1);
    const jsonRpc = card.supportedInterfaces[0];
    expect(jsonRpc?.protocolBinding).toBe("JSONRPC");
    expect(jsonRpc?.protocolVersion).toBe("1.0");
    expect(jsonRpc?.url).toBe(`${agent.url}/a2a`);
    expect(card).not.toHaveProperty("preferredTransport");

    expect(card.skills.map((skill) => skill.id)).toEqual([
      "echo",
      "long-task",
      "ask",
      "outcomes",
      "media",
    ]);
    for (const skill of card.skills) {
      expect(skill.examples.length).toBeGreaterThan(0);
    }
  });

  it("counts card fetches so a bridge can prove its card cache works", async () => {
    // A dedicated instance: the shared agent's card was already fetched
    // by the client factory in `beforeAll`.
    const counted = await startFixtureAgent({ port: 0 });
    try {
      expect(counted.cardFetchCount()).toBe(0);

      const response = await fetch(counted.cardUrl);
      expect(response.status).toBe(200);
      await response.json();

      expect(counted.cardFetchCount()).toBe(1);
    } finally {
      await counted.close();
    }
  });

  it("serializes parts in the v1.0 flat shape, without any `kind` field", async () => {
    const response = await fetch(`${agent.url}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "A2A-Version": "1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            messageId: randomUUID(),
            role: "ROLE_USER",
            parts: [{ text: "echo: flat wire" }],
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();

    // The v1.0 oneof is flattened on the wire: `{"text": "..."}`.
    expect(raw).toContain('"text"');
    expect(raw).not.toContain('"kind"');
    expect(raw).toContain("flat wire");

    const body = JSON.parse(raw) as {
      result?: { message?: { parts?: Array<Record<string, unknown>> } };
    };
    const part = body.result?.message?.parts?.[0];
    expect(part).toBeDefined();
    expect(part).toHaveProperty("text", "flat wire");
    expect(part).not.toHaveProperty("kind");
  });
});

describe("message-only replies", () => {
  it("echo: answers with a direct Message and no Task", async () => {
    const result = await client.sendMessage(sendRequest("echo: hello there"));
    const message = expectMessage(result);
    expect(message.role).toBe(Role.ROLE_AGENT);
    expect(textOf(message.parts)).toBe("hello there");
  });

  it("matches the command prefix case-insensitively", async () => {
    const result = await client.sendMessage(sendRequest("ECHO: Shouting"));
    expect(textOf(expectMessage(result).parts)).toBe("Shouting");
  });

  it("answers unknown input with the help Message", async () => {
    const result = await client.sendMessage(sendRequest("what is the weather"));
    expect(textOf(expectMessage(result).parts)).toBe(
      "Unknown command. Try echo:, task:, ask:, slow:, reject, fail, auth, data, file, image.",
    );
  });
});

describe("task: lifecycle", () => {
  it("returns a completed Task carrying the reversed text and a two-message history", async () => {
    const result = await client.sendMessage(sendRequest("task: abcdef"));
    const task = expectTask(result);

    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts[0]?.name).toBe("result");
    expect(textOf(task.artifacts[0]?.parts ?? [])).toBe("fedcba");
    expect(task.history).toHaveLength(2);
    expect(task.history[0]?.role).toBe(Role.ROLE_USER);
    expect(task.history[1]?.role).toBe(Role.ROLE_AGENT);
  });

  it("streams SUBMITTED, WORKING, artifact then COMPLETED", async () => {
    const events = await collectStream(
      client.sendMessageStream(sendRequest("task: stream")),
    );

    const kinds = events.map((event) => event.payload?.$case);
    expect(kinds).toEqual([
      "task",
      "statusUpdate",
      "artifactUpdate",
      "statusUpdate",
    ]);

    const first = events[0]?.payload;
    expect(first?.$case).toBe("task");
    if (first?.$case === "task") {
      expect(first.value.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    }

    const working = events[1]?.payload;
    if (working?.$case === "statusUpdate") {
      expect(working.value.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    }

    const artifact = events[2]?.payload;
    if (artifact?.$case === "artifactUpdate") {
      expect(artifact.value.artifact?.name).toBe("result");
      expect(textOf(artifact.value.artifact?.parts ?? [])).toBe("maerts");
      expect(artifact.value.lastChunk).toBe(true);
    }

    const done = events[3]?.payload;
    if (done?.$case === "statusUpdate") {
      expect(done.value.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    }
  });
});

describe("ask: input-required cycle", () => {
  it("pauses on INPUT_REQUIRED then completes on the follow-up with the same taskId", async () => {
    const first = expectTask(await client.sendMessage(sendRequest("ask: color")));
    expect(first.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(first.status?.message?.role).toBe(Role.ROLE_AGENT);
    expect(textOf(first.status?.message?.parts ?? [])).toBe(
      "What value should I use for color?",
    );

    const second = expectTask(
      await client.sendMessage(
        sendRequest("blue", { taskId: first.id, contextId: first.contextId }),
      ),
    );

    expect(second.id).toBe(first.id);
    expect(second.contextId).toBe(first.contextId);
    expect(second.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(second.artifacts).toHaveLength(1);
    expect(textOf(second.artifacts[0]?.parts ?? [])).toBe("color = blue");
  });

  it("creates a new task when the follow-up carries no taskId", async () => {
    const first = expectTask(await client.sendMessage(sendRequest("ask: size")));
    const second = expectTask(await client.sendMessage(sendRequest("ask: size")));

    expect(first.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(second.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(second.id).not.toBe(first.id);
  });
});

describe("slow: and cancellation", () => {
  it("completes a short wait", async () => {
    const task = expectTask(await client.sendMessage(sendRequest("slow: 50")));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("reaches CANCELED when CancelTask lands during the wait", async () => {
    const stream = client.sendMessageStream(sendRequest("slow: 5000"));
    const states: TaskState[] = [];
    let taskId = "";
    let cancelling: Promise<Task> | undefined;

    for await (const event of stream) {
      const payload = event.payload;
      if (payload?.$case === "task") {
        taskId = payload.value.id;
        if (payload.value.status?.state !== undefined) {
          states.push(payload.value.status.state);
        }
      } else if (payload?.$case === "statusUpdate") {
        const state = payload.value.status?.state;
        if (state !== undefined) {
          states.push(state);
        }
        if (state === TaskState.TASK_STATE_WORKING && cancelling === undefined) {
          cancelling = client.cancelTask({
            tenant: "",
            id: taskId,
            metadata: undefined,
          });
        }
      }
    }

    expect(cancelling).toBeDefined();
    const canceled = await cancelling!;
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(states).toContain(TaskState.TASK_STATE_CANCELED);
    expect(states).not.toContain(TaskState.TASK_STATE_COMPLETED);
  });
});

describe("terminal and interrupted outcomes", () => {
  it("reject yields REJECTED with an explanatory message", async () => {
    const task = expectTask(await client.sendMessage(sendRequest("reject")));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(textOf(task.status?.message?.parts ?? [])).toBe(
      "This agent declines the request.",
    );
  });

  it("fail yields FAILED with an explanatory message", async () => {
    const task = expectTask(await client.sendMessage(sendRequest("fail")));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(textOf(task.status?.message?.parts ?? [])).toBe("Simulated failure.");
  });

  it("auth yields AUTH_REQUIRED with the out-of-band authorization URL", async () => {
    const task = expectTask(await client.sendMessage(sendRequest("auth")));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_AUTH_REQUIRED);
    expect(textOf(task.status?.message?.parts ?? [])).toBe(
      "Authorization needed: complete it out of band at https://example.invalid/authorize",
    );
  });

  it("vanish opens a task, stops without a terminal state, and loses it: GetTask raises -32001", async () => {
    // sendMessage would block, since the task never reaches a terminal or
    // interrupted state; the stream closes on its own when the agent stops.
    const stream = client.sendMessageStream(sendRequest("vanish"));
    const states: TaskState[] = [];
    let taskId = "";

    for await (const event of stream) {
      const payload = event.payload;
      if (payload?.$case === "task") {
        taskId = payload.value.id;
        if (payload.value.status?.state !== undefined) {
          states.push(payload.value.status.state);
        }
      } else if (payload?.$case === "statusUpdate") {
        taskId = payload.value.taskId;
        const state = payload.value.status?.state;
        if (state !== undefined) {
          states.push(state);
        }
      }
    }

    expect(taskId).not.toBe("");
    expect(states).toContain(TaskState.TASK_STATE_WORKING);
    for (const terminal of [
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_REJECTED,
    ]) {
      expect(states).not.toContain(terminal);
    }

    try {
      await client.getTask({ tenant: "", id: taskId, historyLength: undefined });
      throw new Error("expected getTask to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskNotFoundError);
      expect((error as { envelopeCode?: number }).envelopeCode).toBe(-32001);
    }
  });
});

describe("non-text parts", () => {
  it("data yields a DataPart artifact", async () => {
    const task = expectTask(await client.sendMessage(sendRequest("data ping")));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const part = task.artifacts[0]?.parts[0];
    expect(part?.content?.$case).toBe("data");
    if (part?.content?.$case === "data") {
      expect(part.content.value).toEqual({ answer: 42, echo: "ping" });
    }
  });

  it("file yields a url part with a filename and a media type", async () => {
    const task = expectTask(await client.sendMessage(sendRequest("file")));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const part = task.artifacts[0]?.parts[0];
    expect(part?.content?.$case).toBe("url");
    if (part?.content?.$case === "url") {
      expect(part.content.value).toBe(
        "https://example.invalid/files/report.pdf",
      );
    }
    expect(part?.filename).toBe("report.pdf");
    expect(part?.mediaType).toBe("application/pdf");
  });

  it("image yields a raw part holding a valid 1x1 PNG", async () => {
    const task = expectTask(await client.sendMessage(sendRequest("image")));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const part = task.artifacts[0]?.parts[0];
    expect(part?.content?.$case).toBe("raw");
    if (part?.content?.$case === "raw") {
      const bytes = Buffer.from(part.content.value);
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
      expect(bytes.readUInt32BE(16)).toBe(1);
      expect(bytes.readUInt32BE(20)).toBe(1);
    }
    expect(part?.filename).toBe("pixel.png");
    expect(part?.mediaType).toBe("image/png");
  });
});

describe("task retrieval", () => {
  it("truncates history when GetTask carries historyLength", async () => {
    const created = expectTask(
      await client.sendMessage(sendRequest("task: history")),
    );
    expect(created.history).toHaveLength(2);

    const full = await client.getTask({
      tenant: "",
      id: created.id,
      historyLength: undefined,
    });
    expect(full.history).toHaveLength(2);

    const truncated = await client.getTask({
      tenant: "",
      id: created.id,
      historyLength: 1,
    });
    expect(truncated.history).toHaveLength(1);
    expect(truncated.history[0]?.role).toBe(Role.ROLE_AGENT);

    const none = await client.getTask({
      tenant: "",
      id: created.id,
      historyLength: 0,
    });
    expect(none.history).toHaveLength(0);
  });

  it("lists tasks", async () => {
    const created = expectTask(await client.sendMessage(sendRequest("task: listed")));
    const listed = await client.listTasks({
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageSize: 100,
      pageToken: "",
      historyLength: undefined,
      statusTimestampAfter: undefined,
      includeArtifacts: true,
    });

    expect(listed.tasks.length).toBeGreaterThan(0);
    expect(listed.tasks.map((task) => task.id)).toContain(created.id);
  });

  it("raises TaskNotFoundError (-32001) for an unknown task id", async () => {
    const unknownId = randomUUID();
    await expect(
      client.getTask({ tenant: "", id: unknownId, historyLength: undefined }),
    ).rejects.toThrow(TaskNotFoundError);

    try {
      await client.getTask({
        tenant: "",
        id: unknownId,
        historyLength: undefined,
      });
      throw new Error("expected getTask to reject");
    } catch (error) {
      expect((error as Error).name).toBe("TaskNotFoundError");
      expect((error as { envelopeCode?: number }).envelopeCode).toBe(-32001);
    }
  });
});

describe("conversation context", () => {
  it("reuses the contextId supplied by the caller across tasks", async () => {
    const contextId = randomUUID();
    const first = expectTask(
      await client.sendMessage(sendRequest("task: one", { contextId })),
    );
    const second = expectTask(
      await client.sendMessage(sendRequest("task: two", { contextId })),
    );

    expect(first.contextId).toBe(contextId);
    expect(second.contextId).toBe(contextId);
    expect(first.id).not.toBe(second.id);

    const listed = await client.listTasks({
      tenant: "",
      contextId,
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageSize: 100,
      pageToken: "",
      historyLength: undefined,
      statusTimestampAfter: undefined,
      includeArtifacts: false,
    });
    expect(listed.tasks.map((task) => task.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("allocates a fresh contextId when the caller supplies none", async () => {
    const first = expectTask(await client.sendMessage(sendRequest("task: alpha")));
    const second = expectTask(await client.sendMessage(sendRequest("task: beta")));
    expect(first.contextId).not.toBe("");
    expect(second.contextId).not.toBe("");
    expect(first.contextId).not.toBe(second.contextId);
  });
});
