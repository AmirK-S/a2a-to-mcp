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
} from "@modelcontextprotocol/server";

import type { A2AClientPool } from "../a2a-client.js";
import { A2ABridgeError } from "../a2a-client.js";
import { taskEnvelope, type BridgeHandles } from "../envelope.js";
import { HandleExpiredError, UnknownHandleError } from "../handles.js";
import { toMcpStatus } from "../lifecycle.js";
import { TaskState } from "@a2a-js/sdk";
import type { TaskRecord } from "./store.js";

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
}

export class TasksService {
  readonly #handles: BridgeHandles;
  readonly #agents: A2AClientPool;
  readonly #ttlMs: number;

  constructor(options: TasksServiceOptions) {
    this.#handles = options.handles;
    this.#agents = options.agents;
    this.#ttlMs = options.ttlMs;
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
        return this.#get(taskId, record);
      case "tasks/update":
        return this.#update(taskId, record);
      case "tasks/cancel":
        return this.#cancel(taskId, record);
      default:
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown method ${method}.`);
    }
  }

  /** tasks/get: the live upstream state, in the DetailedTask shape. */
  async #get(taskId: string, record: TaskRecord): Promise<Record<string, unknown>> {
    const task = await this.#upstream(() =>
      this.#agents.getTask(record.alias, record.a2aTaskId),
    );
    const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
    const mapping = toMcpStatus(state);
    const envelope = taskEnvelope(this.#handles, record.alias, task);
    const updated = this.#handles.tasks.markUpdated(taskId);

    const base: Record<string, unknown> = {
      resultType: "complete",
      taskId,
      status: mapping.status,
      createdAt: updated.createdAt,
      lastUpdatedAt: updated.lastUpdatedAt,
      ttlMs: this.#ttlMs,
    };
    const statusMessage = textOfStatus(envelope.content);
    if (statusMessage !== "") {
      base["statusMessage"] = statusMessage;
    }
    if (mapping.status === "completed") {
      // The extension asks for exactly what the underlying request would have
      // returned, so the CallToolResult of a2a_send_message goes back verbatim.
      base["result"] = { ...envelope };
    }
    if (mapping.status === "failed") {
      base["error"] = {
        code: ProtocolErrorCode.InternalError,
        message: statusMessage === "" ? `The A2A agent reported ${mapping.status}.` : statusMessage,
      };
    }
    // input_required still owes an inputRequests field: the MRTR round trip
    // lands with the elicitation work, not here.
    return base;
  }

  /**
   * tasks/update: the empty acknowledgement the extension mandates. The
   * bridge has no outstanding input request yet, and the extension says a
   * server SHOULD ignore responses whose key is not outstanding.
   */
  async #update(taskId: string, _record: TaskRecord): Promise<Record<string, unknown>> {
    this.#handles.tasks.markUpdated(taskId);
    return Promise.resolve({ resultType: "complete" });
  }

  /** tasks/cancel: cooperative upstream cancellation, then an empty ack. */
  async #cancel(taskId: string, record: TaskRecord): Promise<Record<string, unknown>> {
    await this.#upstream(() => this.#agents.cancelTask(record.alias, record.a2aTaskId));
    this.#handles.tasks.markUpdated(taskId);
    return { resultType: "complete" };
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

  async #upstream<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof A2ABridgeError) {
        throw new ProtocolError(ProtocolErrorCode.InternalError, error.message, {
          ...(error.a2aErrorCode === undefined ? {} : { a2aErrorCode: error.a2aErrorCode }),
        });
      }
      throw error;
    }
  }
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

/** The text of the content blocks, joined, for the statusMessage field. */
function textOfStatus(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}
