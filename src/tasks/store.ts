/**
 * The store behind the io.modelcontextprotocol/tasks extension.
 *
 * An MCP task id is a bridge handle: the opaque tk_ token minted when
 * a2a_send_message produced an A2A task. The store maps it back to the agent
 * alias, to the A2A identifiers, and to the last A2A Task the bridge saw.
 *
 * That snapshot is what a stream writes into: an agent that streams feeds the
 * record event by event, and the bridge only falls back on a fresh GetTask
 * when no stream is alive and the task is not terminal yet. A terminal record
 * is frozen, so two tasks/get on a finished task answer identically.
 *
 * Minting is idempotent on alias plus A2A task id, so a client that sends
 * three messages to the same task sees one handle, not three.
 */
import type { Task } from "@a2a-js/sdk";

import { HandleExpiredError, HandleTable, UnknownHandleError } from "../handles.js";

/** Prefix of every MCP task handle minted by the bridge. */
export const TASK_HANDLE_PREFIX = "tk";

/** A failure of the bridge itself, reported as an MCP failed task. */
export interface BridgeTaskError {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

/** What the bridge remembers about one MCP task. */
export interface TaskRecord {
  /** The tk_ handle this record is filed under. */
  handle: string;
  /** Alias of the A2A agent running the task. */
  alias: string;
  /** Identifier of the task on the A2A side. */
  a2aTaskId: string;
  /** A2A context the task belongs to. */
  contextId: string;
  /** When the handle was minted, ISO 8601. */
  createdAt: string;
  /** When the bridge last refreshed the record, ISO 8601. */
  lastUpdatedAt: string;
  /** The last A2A Task the bridge saw, artifacts accumulated. */
  snapshot: Task;
  /** True once the snapshot reached one of the four terminal A2A states. */
  terminal: boolean;
  /** True while a SendStreamingMessage stream is still feeding the snapshot. */
  streaming: boolean;
  /** Set when the bridge itself could not carry the task any further. */
  bridgeError?: BridgeTaskError;
  /** The terminal tool result, built once and handed back unchanged. */
  frozenResult?: Record<string, unknown>;
}

export interface TaskStoreOptions {
  /** Handle lifetime in milliseconds. */
  ttlMs: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export class TaskStore {
  readonly #table: HandleTable<TaskRecord>;
  /** Idempotency index: `alias:a2aTaskId` to the handle minted for it. */
  readonly #byKey = new Map<string, string>();
  readonly #now: () => number;

  constructor(options: TaskStoreOptions) {
    this.#now = options.now ?? Date.now;
    this.#table = new HandleTable<TaskRecord>({
      ttlMs: options.ttlMs,
      prefix: TASK_HANDLE_PREFIX,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /**
   * Mints the handle of an A2A task, or refreshes the one already minted for
   * it. The idempotency key is the alias and the A2A task id together, because
   * two agents may well use the same task id.
   *
   * A record that already reached a terminal state keeps the snapshot it
   * settled on: the extension requires tasks/get to answer identically once
   * the task is finished.
   */
  mintFor(alias: string, task: Task, terminal = false): string {
    const key = `${alias}:${task.id}`;
    const stamp = this.#stamp();
    const known = this.#byKey.get(key);
    if (known !== undefined) {
      const record = this.#peek(known);
      if (record !== undefined) {
        // The stored object is handed back by reference, so the record is
        // updated in place and the creation date survives.
        record.contextId = task.contextId;
        record.lastUpdatedAt = stamp;
        if (!record.terminal) {
          record.snapshot = task;
          record.terminal = terminal;
        }
        this.#table.touch(known);
        return known;
      }
      this.#byKey.delete(key);
    }
    const handle = this.#table.mint({
      handle: "",
      alias,
      a2aTaskId: task.id,
      contextId: task.contextId,
      createdAt: stamp,
      lastUpdatedAt: stamp,
      snapshot: task,
      terminal,
      streaming: false,
    });
    this.#table.resolve(handle).handle = handle;
    this.#byKey.set(key, handle);
    return handle;
  }

  /** Resolves a handle. Throws UnknownHandleError or HandleExpiredError. */
  resolve(handle: string): TaskRecord {
    return this.#table.resolve(handle);
  }

  /** Restarts the lifetime of a handle. */
  touch(handle: string): void {
    this.#table.touch(handle);
  }

  /** The current time in the ISO 8601 spelling the records use. */
  stamp(): string {
    return this.#stamp();
  }

  /** Stamps a task as just refreshed and restarts its lifetime. */
  markUpdated(handle: string): TaskRecord {
    const record = this.#table.resolve(handle);
    record.lastUpdatedAt = this.#stamp();
    this.#table.touch(handle);
    return record;
  }

  /** Forgets a handle. True when it was there. */
  delete(handle: string): boolean {
    const record = this.#peek(handle);
    if (record !== undefined) {
      this.#byKey.delete(`${record.alias}:${record.a2aTaskId}`);
    }
    return this.#table.delete(handle);
  }

  /** Number of handles held, expired ones included until the next sweep. */
  get size(): number {
    return this.#table.size;
  }

  /** Drops every expired handle and returns how many were dropped. */
  sweep(): number {
    const dropped = this.#table.sweep();
    for (const [key, handle] of this.#byKey) {
      if (this.#peek(handle) === undefined) {
        this.#byKey.delete(key);
      }
    }
    return dropped;
  }

  /** One sentence about retention, meant for a tool description. */
  describeRetention(): string {
    return this.#table.describeRetention();
  }

  #peek(handle: string): TaskRecord | undefined {
    try {
      return this.#table.resolve(handle);
    } catch {
      return undefined;
    }
  }

  #stamp(): string {
    return new Date(this.#now()).toISOString();
  }
}

export { HandleExpiredError, UnknownHandleError };
