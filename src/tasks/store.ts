/**
 * The store behind the io.modelcontextprotocol/tasks extension.
 *
 * An MCP task id is a bridge handle: the opaque tk_ token minted when
 * a2a_send_message produced an A2A task. The store maps it back to the agent
 * alias and to the A2A identifiers, and to nothing else: the authoritative
 * state always comes from a fresh GetTask upstream, so the bridge never has to
 * keep an A2A lifecycle in sync with an MCP one.
 *
 * Minting is idempotent on alias plus A2A task id, so a client that sends
 * three messages to the same task sees one handle, not three.
 */
import { HandleExpiredError, HandleTable, UnknownHandleError } from "../handles.js";

/** Prefix of every MCP task handle minted by the bridge. */
export const TASK_HANDLE_PREFIX = "tk";

/** What the bridge remembers about one MCP task. */
export interface TaskRecord {
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
   */
  mintFor(alias: string, a2aTaskId: string, contextId: string): string {
    const key = `${alias}:${a2aTaskId}`;
    const stamp = this.#stamp();
    const known = this.#byKey.get(key);
    if (known !== undefined) {
      const record = this.#peek(known);
      if (record !== undefined) {
        // The stored object is handed back by reference, so the record is
        // updated in place and the creation date survives.
        record.contextId = contextId;
        record.lastUpdatedAt = stamp;
        this.#table.touch(known);
        return known;
      }
      this.#byKey.delete(key);
    }
    const handle = this.#table.mint({
      alias,
      a2aTaskId,
      contextId,
      createdAt: stamp,
      lastUpdatedAt: stamp,
    });
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
