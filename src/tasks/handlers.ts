/**
 * The three methods of the io.modelcontextprotocol/tasks extension, written
 * once and served by both routes: the HTTP interceptor calls them on the
 * 2026-07-28 route, where the SDK refuses tasks/get and tasks/cancel before
 * handler lookup (DECISIONS.md D06), and the SDK calls them through
 * setRequestHandler on the 2025-11-25 route.
 *
 * Every gate the extension mandates lives here rather than in either caller,
 * so the two routes cannot drift: the client must have declared the extension
 * (-32021), the taskId must resolve to a live handle (-32602), and only then
 * does the bridge touch the upstream agent.
 */
import {
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  SERVER_INFO_META_KEY,
} from "@modelcontextprotocol/server";
import { TaskState, taskStateToJSON, type Message, type StreamResponse, type Task } from "@a2a-js/sdk";

import type { A2AClientPool, SendMessageInput } from "../a2a-client.js";
import { A2ABridgeError } from "../a2a-client.js";
import { isTask, taskEnvelope, type BridgeHandles } from "../envelope.js";
import { HandleExpiredError, UnknownHandleError } from "../handles.js";
import { isTerminalA2AState, toMcpStatus, toTaskExtensionStatus } from "../lifecycle.js";
import { applyStreamEvent, stateOf, taskFromStatusUpdate } from "./stream.js";
import type { BridgeTaskError, TaskRecord } from "./store.js";

/** Identifier of the tasks extension, as clients declare it. */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

/** The only MCP revision on which the bridge serves the extension (D08). */
export const MODERN_REVISION = "2026-07-28";

/** The three methods the extension defines on the 2026-07-28 revision. */
export const TASKS_METHODS = ["tasks/get", "tasks/update", "tasks/cancel"] as const;

export type TasksMethod = (typeof TASKS_METHODS)[number];

/** True for the three method names of the extension. */
export function isTasksMethod(method: string): method is TasksMethod {
  return (TASKS_METHODS as readonly string[]).includes(method);
}

/** The client capabilities view a route hands to the handlers. */
export interface ClientCapabilitiesView {
  extensions?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

export interface TasksServiceOptions {
  handles: BridgeHandles;
  agents: A2AClientPool;
  /** Handle lifetime, reported to the client as the task ttlMs. */
  ttlMs: number;
  /** Server identity, stamped on an inlined tool result as tools/call does. */
  serverInfo: { name: string; version: string };
}

/** Cadence the bridge advertises to a polling client, in milliseconds. */
export const POLL_INTERVAL_MS = 500;

/** What a2a_send_message got back when the client asked for a task. */
export type CreateTaskOutcome =
  /** A CreateTaskResult, flat, ready to travel as the tools/call result. */
  | { kind: "task"; result: Record<string, unknown> }
  /** The agent answered outright: the call stays an ordinary tool call. */
  | { kind: "synchronous"; result: Message | Task };

export class TasksService {
  readonly #handles: BridgeHandles;
  readonly #agents: A2AClientPool;
  readonly #ttlMs: number;
  readonly #serverInfo: { name: string; version: string };

  constructor(options: TasksServiceOptions) {
    this.#handles = options.handles;
    this.#agents = options.agents;
    this.#ttlMs = options.ttlMs;
    this.#serverInfo = options.serverInfo;
  }

  /**
   * Refuses a client that did not declare the extension, with the -32021 the
   * extension mandates and the capability it would have to declare.
   */
  assertExtensionDeclared(capabilities: ClientCapabilitiesView | undefined): void {
    if (capabilities?.extensions?.[TASKS_EXTENSION_ID] !== undefined) {
      return;
    }
    throw new MissingRequiredClientCapabilityError(
      { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
      `This server serves ${TASKS_METHODS.join(", ")} only to clients that declare the ` +
        `${TASKS_EXTENSION_ID} extension in their client capabilities.`,
    );
  }

  /**
   * Refuses the three methods on the 2025-11-25 route, whatever the client
   * declared at initialize (DECISIONS.md D08). The legacy leg is served
   * statelessly, one fresh instance per request, so no handshake is
   * recoverable there; the extension lives on the modern revision only, and
   * the answer says so rather than pretending the declaration was missing.
   */
  refuseOnLegacyRoute(): never {
    throw new MissingRequiredClientCapabilityError(
      { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
      `This server serves the ${TASKS_EXTENSION_ID} extension on the MCP ` +
        `${MODERN_REVISION} revision only, reached through server/discover. ` +
        `${TASKS_METHODS.join(", ")} are not available on the 2025-11-25 route, ` +
        "whatever capabilities the client declared at initialize.",
    );
  }

  /**
   * Opens an MCP task over one A2A message, for a client that declared the
   * extension on the modern route.
   *
   * A streaming agent is read only as far as its first lifecycle event: that
   * is enough to answer, and the rest of the stream keeps feeding the record
   * in the background. An agent that does not stream is asked to return as
   * soon as the task exists, and every later state comes from GetTask.
   */
  async createTask(alias: string, input: SendMessageInput): Promise<CreateTaskOutcome> {
    if (!(await this.#agents.supportsStreaming(alias))) {
      const answered = await this.#agents.sendMessage(alias, input, { returnImmediately: true });
      if (!isTask(answered)) {
        return { kind: "synchronous", result: answered };
      }
      return { kind: "task", result: this.#createTaskResult(this.#register(alias, answered)) };
    }

    const stream = await this.#agents.sendMessageStream(alias, input);
    const events = stream[Symbol.asyncIterator]();
    let seed: Task | undefined;
    while (seed === undefined) {
      const next = await events.next();
      if (next.done === true) {
        throw new A2ABridgeError(
          `A2A SendStreamingMessage on agent ${JSON.stringify(alias)} closed the stream ` +
            "without sending a task or a message.",
        );
      }
      const payload = next.value.payload;
      if (payload === undefined) {
        continue;
      }
      if (payload.$case === "message") {
        // The agent answered outright; nothing is durable, so no task is
        // created and the call goes back as an ordinary tool result.
        void events.return?.(undefined);
        return { kind: "synchronous", result: payload.value };
      }
      if (payload.$case === "task") {
        seed = payload.value;
      } else if (payload.$case === "statusUpdate") {
        seed = taskFromStatusUpdate(payload.value);
      }
    }

    const record = this.#register(alias, seed);
    record.streaming = true;
    // Not awaited on purpose: the client is answered now, and the stream
    // keeps writing into the record until it closes.
    void this.#consume(record, events);
    return { kind: "task", result: this.#createTaskResult(record) };
  }

  /** Dispatches one extension method, after the capability gate. */
  async handle(
    method: TasksMethod,
    params: unknown,
    capabilities: ClientCapabilitiesView | undefined,
  ): Promise<Record<string, unknown>> {
    this.assertExtensionDeclared(capabilities);
    const taskId = readTaskId(params);
    const record = this.#resolve(taskId);

    switch (method) {
      case "tasks/get":
        return this.#get(record);
      case "tasks/update":
        return this.#update(record);
      case "tasks/cancel":
        return this.#cancel(record);
      default:
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown method ${method}.`);
    }
  }

  /** tasks/get: the current state of the task, in the DetailedTask shape. */
  async #get(record: TaskRecord): Promise<Record<string, unknown>> {
    await this.#refresh(record);
    const updated = this.#handles.tasks.markUpdated(record.handle);
    const state = stateOf(record.snapshot);

    const base: Record<string, unknown> = {
      resultType: "complete",
      taskId: record.handle,
      status: record.bridgeError === undefined ? toTaskExtensionStatus(state) : "failed",
      createdAt: updated.createdAt,
      lastUpdatedAt: updated.lastUpdatedAt,
      ttlMs: this.#ttlMs,
      pollIntervalMs: POLL_INTERVAL_MS,
    };

    if (record.bridgeError !== undefined) {
      base["statusMessage"] = record.bridgeError.message;
      base["error"] = {
        code: record.bridgeError.code,
        message: record.bridgeError.message,
        data: record.bridgeError.data,
      };
      return base;
    }

    const statusMessage = statusMessageOf(record.snapshot);
    if (statusMessage !== "") {
      base["statusMessage"] = statusMessage;
    }

    switch (base["status"]) {
      case "input_required":
        // A2A asks in free text and MCP wants a schema, so the form is
        // synthesized here and the loss is stated in the statusMessage.
        base["statusMessage"] = toMcpStatus(TaskState.TASK_STATE_INPUT_REQUIRED).note;
        base["inputRequests"] = inputRequestsFor(statusMessage);
        return base;
      case "completed":
        // The extension asks for exactly what the underlying request would
        // have returned, so the CallToolResult of a2a_send_message goes back
        // verbatim, built once and then frozen.
        base["result"] = this.#frozenResult(record);
        return base;
      default:
        // working and cancelled carry nothing beyond the base fields.
        return base;
    }
  }

  /**
   * tasks/update: the empty acknowledgement the extension mandates. The
   * bridge has no outstanding input request yet, and the extension says a
   * server SHOULD ignore responses whose key is not outstanding.
   */
  async #update(record: TaskRecord): Promise<Record<string, unknown>> {
    this.#handles.tasks.markUpdated(record.handle);
    return Promise.resolve({ resultType: "complete" });
  }

  /** tasks/cancel: cooperative upstream cancellation, then an empty ack. */
  async #cancel(record: TaskRecord): Promise<Record<string, unknown>> {
    if (record.terminal || record.bridgeError !== undefined) {
      // Cancellation is idempotent: a task that has settled is acknowledged
      // and left exactly as it is.
      this.#handles.tasks.markUpdated(record.handle);
      return { resultType: "complete" };
    }
    const canceled = await this.#upstream(record, () =>
      this.#agents.cancelTask(record.alias, record.a2aTaskId),
    );
    this.#adopt(record, canceled);
    this.#handles.tasks.markUpdated(record.handle);
    return { resultType: "complete" };
  }

  /** Files an A2A task under a tk_ handle, minting its cx_ handle too. */
  #register(alias: string, task: Task): TaskRecord {
    this.#handles.mintContext(alias, task.contextId);
    const handle = this.#handles.tasks.mintFor(alias, task, isTerminalA2AState(stateOf(task)));
    return this.#handles.tasks.resolve(handle);
  }

  /** Reads the rest of a stream into the record, long after the answer. */
  async #consume(
    record: TaskRecord,
    events: AsyncIterator<StreamResponse, void, undefined>,
  ): Promise<void> {
    try {
      for (;;) {
        const next = await events.next();
        if (next.done === true) {
          break;
        }
        this.#adopt(record, applyStreamEvent(record.snapshot, next.value));
      }
    } catch (error) {
      record.bridgeError = bridgeErrorOf(record.alias, error);
    } finally {
      // Whatever happened, no stream feeds this record any more: a task that
      // is still running is refreshed by GetTask from the next poll on.
      record.streaming = false;
    }
  }

  /** Takes a fresher A2A task into the record, unless it has settled. */
  #adopt(record: TaskRecord, task: Task): void {
    if (record.terminal) {
      return;
    }
    record.snapshot = task;
    record.terminal = isTerminalA2AState(stateOf(task));
    record.lastUpdatedAt = this.#handles.tasks.stamp();
  }

  /**
   * Brings a record up to date before answering. A terminal record is frozen,
   * a record a stream is still feeding is already current, and a record the
   * bridge has already failed on is not asked again.
   */
  async #refresh(record: TaskRecord): Promise<void> {
    if (record.terminal || record.streaming || record.bridgeError !== undefined) {
      return;
    }
    try {
      // historyLength is left unset: the extension reports a lifecycle, and
      // the conversation is what a2a_get_task is for.
      this.#adopt(record, await this.#agents.getTask(record.alias, record.a2aTaskId));
    } catch (error) {
      record.bridgeError = bridgeErrorOf(record.alias, error);
    }
  }

  /** The terminal CallToolResult, built once and handed back unchanged. */
  #frozenResult(record: TaskRecord): Record<string, unknown> {
    const held = record.frozenResult;
    if (held !== undefined) {
      return held;
    }
    const built: Record<string, unknown> = {
      ...(taskEnvelope(this.#handles, record.alias, record.snapshot) as unknown as Record<
        string,
        unknown
      >),
      // The same identity the 2026-07-28 encode seam stamps on a tools/call
      // result, and no related-task key: the result is inlined here, not
      // pointed at.
      _meta: { [SERVER_INFO_META_KEY]: this.#serverInfo },
    };
    record.frozenResult = built;
    return built;
  }

  /** The CreateTaskResult of a freshly opened task, flat as the schema asks. */
  #createTaskResult(record: TaskRecord): Record<string, unknown> {
    const statusMessage = statusMessageOf(record.snapshot);
    return {
      resultType: "task",
      taskId: record.handle,
      status: toTaskExtensionStatus(stateOf(record.snapshot)),
      ...(statusMessage === "" ? {} : { statusMessage }),
      createdAt: record.createdAt,
      lastUpdatedAt: record.lastUpdatedAt,
      ttlMs: this.#ttlMs,
      pollIntervalMs: POLL_INTERVAL_MS,
      // Required by the tools/call seam of the SDK, empty because the result
      // of the task is not known yet.
      content: [],
    };
  }

  #resolve(taskId: string): TaskRecord {
    try {
      return this.#handles.tasks.resolve(taskId);
    } catch (error) {
      if (error instanceof UnknownHandleError) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown task ${JSON.stringify(taskId)}: no task with that id was created by this bridge.`,
        );
      }
      if (error instanceof HandleExpiredError) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Task ${JSON.stringify(taskId)} has expired and was purged. Start it again.`,
        );
      }
      throw error;
    }
  }

  /** Runs one upstream call, recording an A2A failure on the record too. */
  async #upstream<T>(record: TaskRecord, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const failure = bridgeErrorOf(record.alias, error);
      record.bridgeError = failure;
      throw new ProtocolError(failure.code, failure.message, failure.data);
    }
  }
}

/** Describes a bridge-level failure the way tasks/get reports it (D08). */
function bridgeErrorOf(alias: string, error: unknown): BridgeTaskError {
  const a2aErrorCode = error instanceof A2ABridgeError ? error.a2aErrorCode : undefined;
  return {
    code: ProtocolErrorCode.InternalError,
    message: error instanceof Error ? error.message : String(error),
    data: { ...(a2aErrorCode === undefined ? {} : { a2aErrorCode }), alias },
  };
}

/**
 * The statusMessage of a task: what the agent wrote, or the exact A2A state
 * when the mapping onto an MCP status dropped something and the agent said
 * nothing.
 */
export function statusMessageOf(task: Task): string {
  const message = task.status?.message;
  const text =
    message === undefined
      ? ""
      : message.parts
          .filter((part) => part.content?.$case === "text")
          .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
          .join("\n");
  if (text !== "") {
    return text;
  }
  const state = stateOf(task);
  return toMcpStatus(state).lossy ? `A2A state ${taskStateToJSON(state)}` : "";
}

/**
 * The one form-mode elicitation an A2A INPUT_REQUIRED becomes. A2A carries
 * the question as free text with no schema, so the schema is a single
 * required string and the agent wording travels as the message.
 */
export function inputRequestsFor(question: string): Record<string, unknown> {
  return {
    answer: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: question,
        requestedSchema: {
          type: "object",
          properties: {
            answer: { type: "string", description: "Your answer to the agent" },
          },
          required: ["answer"],
        },
      },
    },
  };
}

/** Reads params.taskId, refusing anything else with -32602. */
export function readTaskId(params: unknown): string {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "Invalid params: the tasks methods expect an object with a taskId.",
    );
  }
  const taskId = (params as Record<string, unknown>)["taskId"];
  if (typeof taskId !== "string" || taskId === "") {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "Invalid params: taskId must be a non-empty string naming a task of this server.",
    );
  }
  return taskId;
}
