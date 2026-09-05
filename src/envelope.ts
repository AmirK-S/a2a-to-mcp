/**
 * The result envelope of a2a_send_message, a2a_get_task and a2a_cancel_task.
 *
 * A2A answers SendMessage with either a Message or a Task, and the union is
 * not discriminated on the wire, so it is told apart structurally. Both arms
 * collapse into one shape: content blocks for a client that only reads text,
 * and a structuredContent envelope for a client that reads the lifecycle.
 *
 * The envelope reports the A2A state twice on purpose: a2aState carries the
 * exact ProtoJSON name (TASK_STATE_AUTH_REQUIRED), status carries the MCP task
 * status it maps onto, and note says what the mapping dropped. A client that
 * only knows MCP reads status; a client that knows A2A never loses the state
 * the agent actually reported.
 */
import { TaskState, taskStateToJSON, type Message, type Part, type Task } from "@a2a-js/sdk";
import type { ContentBlock } from "@modelcontextprotocol/server";

import { HandleTable } from "./handles.js";
import { toMcpStatus, type McpTaskStatus } from "./lifecycle.js";
import { artifactToContent, messageToContent, structuredContentFromParts } from "./parts.js";
import { TaskStore } from "./tasks/store.js";

/** Prefix of every A2A context handle minted by the bridge. */
export const CONTEXT_HANDLE_PREFIX = "cx";

/** The A2A states the bridge reports as a failed tool call. */
const ERROR_STATES: readonly TaskState[] = [
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
  TaskState.TASK_STATE_UNSPECIFIED,
];

/** What the bridge remembers behind a cx_ handle. */
export interface ContextRecord {
  alias: string;
  contextId: string;
}

/** One artifact, named but not inlined, so a client can ask for it by id. */
export interface ArtifactRef {
  artifactId: string;
  name: string;
}

/** The structuredContent of every tool result that carries A2A output. */
export interface BridgeEnvelope {
  kind: "message" | "task";
  contextHandle: string;
  taskHandle?: string;
  /** Exact A2A state, ProtoJSON spelling, for example TASK_STATE_COMPLETED. */
  a2aState?: string;
  /** The MCP task status the A2A state maps onto. */
  status?: McpTaskStatus;
  /** What the mapping dropped, present only when it dropped something. */
  note?: string;
  artifacts?: ArtifactRef[];
  /** The single data part of the artifacts, when there is exactly one. */
  data?: Record<string, unknown>;
}

/** The shape the tools return to the MCP seam. */
export interface EnvelopeResult {
  content: ContentBlock[];
  structuredContent: BridgeEnvelope;
  isError?: boolean;
}

/** The two handle tables of the bridge, minted and resolved in one place. */
export class BridgeHandles {
  readonly tasks: TaskStore;
  readonly #contexts: HandleTable<ContextRecord>;

  constructor(options: { ttlMs: number; now?: () => number }) {
    const clock = options.now === undefined ? {} : { now: options.now };
    this.tasks = new TaskStore({ ttlMs: options.ttlMs, ...clock });
    this.#contexts = new HandleTable<ContextRecord>({
      ttlMs: options.ttlMs,
      prefix: CONTEXT_HANDLE_PREFIX,
      ...clock,
    });
  }

  /** Mints the handle of an A2A context, idempotently on alias and context id. */
  mintContext(alias: string, contextId: string): string {
    return this.#contexts.mintFor(`${alias}:${contextId}`, { alias, contextId });
  }

  /** Resolves a context handle. Throws UnknownHandleError or HandleExpiredError. */
  resolveContext(handle: string): ContextRecord {
    return this.#contexts.resolve(handle);
  }

  /** One sentence about retention, meant for a tool description. */
  describeRetention(): string {
    return this.tasks.describeRetention();
  }

  /** Drops every expired handle of both tables. */
  sweep(): number {
    return this.tasks.sweep() + this.#contexts.sweep();
  }
}

/** True when an A2A SendMessage result is a Task rather than a Message. */
export function isTask(result: Message | Task): result is Task {
  return "status" in result && !("messageId" in result);
}

/** Builds the tool result for a direct Message reply. */
export function messageEnvelope(
  handles: BridgeHandles,
  alias: string,
  message: Message,
): EnvelopeResult {
  return {
    content: messageToContent(message),
    structuredContent: {
      kind: "message",
      contextHandle: handles.mintContext(alias, message.contextId),
    },
  };
}

/** Builds the tool result for a Task, whatever state it is in. */
export function taskEnvelope(handles: BridgeHandles, alias: string, task: Task): EnvelopeResult {
  const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
  const mapping = toMcpStatus(state);
  const artifacts = task.artifacts ?? [];
  const parts: Part[] = artifacts.flatMap((artifact) => artifact.parts);

  const content: ContentBlock[] = artifacts.flatMap((artifact) => artifactToContent(artifact));
  const statusMessage = task.status?.message;
  if (statusMessage !== undefined) {
    content.push(...messageToContent(statusMessage));
  }

  const refs: ArtifactRef[] = artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    name: artifact.name,
  }));
  const data = structuredContentFromParts(parts);

  const envelope: BridgeEnvelope = {
    kind: "task",
    contextHandle: handles.mintContext(alias, task.contextId),
    taskHandle: handles.tasks.mintFor(alias, task.id, task.contextId),
    a2aState: taskStateToJSON(state),
    status: mapping.status,
    ...(mapping.lossy && mapping.note !== undefined ? { note: mapping.note } : {}),
    ...(refs.length > 0 ? { artifacts: refs } : {}),
    ...(data === undefined ? {} : { data }),
  };

  return {
    content,
    structuredContent: envelope,
    ...(ERROR_STATES.includes(state) ? { isError: true } : {}),
  };
}

/** Builds the tool result for whichever arm SendMessage returned. */
export function resultEnvelope(
  handles: BridgeHandles,
  alias: string,
  result: Message | Task,
): EnvelopeResult {
  return isTask(result)
    ? taskEnvelope(handles, alias, result)
    : messageEnvelope(handles, alias, result);
}
