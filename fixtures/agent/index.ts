/**
 * Deterministic A2A v1.0.1 fixture agent.
 *
 * No language model, no network calls, no randomness beyond message and
 * artifact identifiers: the behavior is dictated entirely by the prefix of
 * the text carried by the first `Part` of the user message. It exists to
 * exercise the `a2a-to-mcp` bridge on the lifecycles no official sample
 * agent covers: INPUT_REQUIRED round trips, REJECTED / FAILED /
 * AUTH_REQUIRED outcomes, cancellation of a running task, and artifacts
 * holding data, url and raw parts.
 *
 * See `card.ts` for the advertised skills and `commands.ts` for the
 * command grammar.
 */
import type { Server } from "node:http";

import { AGENT_CARD_PATH, type ListTasksRequest, type ListTasksResponse, type Task } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type ServerCallContext,
  type TaskStore,
} from "@a2a-js/sdk/server";

import { JSONRPC_PATH, buildAgentCard } from "./card.js";
import { FixtureAgentExecutor } from "./executor.js";
import { baseUrlOf, createFixtureHttpServer } from "./http.js";

export { JSONRPC_PATH, buildAgentCard } from "./card.js";
export { FixtureAgentExecutor, PIXEL_PNG_BASE64 } from "./executor.js";
export {
  COMMAND_NAMES,
  MAX_SLOW_MS,
  UNKNOWN_COMMAND_REPLY,
  parseCommand,
} from "./commands.js";

/**
 * An `InMemoryTaskStore` that can be told to forget a task for good.
 *
 * `TaskStore` has no delete operation, so a forgotten id is answered as
 * absent instead: `load` returns `undefined`, `save` drops the write and
 * `list` hides the task. That is what the `vanish` command needs to make
 * the agent lose a task it has already announced.
 */
class VanishingTaskStore implements TaskStore {
  readonly #inner = new InMemoryTaskStore();
  readonly #vanished = new Set<string>();

  /** Makes a task unreachable from now on. */
  vanish(taskId: string): void {
    this.#vanished.add(taskId);
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    if (this.#vanished.has(taskId)) {
      return undefined;
    }
    return this.#inner.load(taskId, context);
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    if (this.#vanished.has(task.id)) {
      return;
    }
    await this.#inner.save(task, context);
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const listed = await this.#inner.list(params, context);
    return { ...listed, tasks: listed.tasks.filter((task) => !this.#vanished.has(task.id)) };
  }
}

export interface FixtureAgentOptions {
  /** TCP port to bind. `0`, the default, picks a free port. */
  port?: number;
}

export interface FixtureAgentHandle {
  /** Base URL of the agent, for example `http://127.0.0.1:41241`. */
  url: string;
  /** Absolute URL of the agent card. */
  cardUrl: string;
  /** Port actually bound. */
  port: number;
  /**
   * Number of successful GETs of the agent card since startup. A bridge
   * that caches the card should leave this at 1 across repeated calls.
   */
  cardFetchCount(): number;
  /** Stops the server and resolves once every connection is closed. */
  close(): Promise<void>;
}

/** Starts the fixture agent and resolves once it is accepting requests. */
export async function startFixtureAgent(
  options: FixtureAgentOptions = {},
): Promise<FixtureAgentHandle> {
  let cardFetches = 0;

  // The card advertises the interface URL, which is only known once the
  // port is bound, so the card object is built first and its interface
  // URLs are rewritten after `listen`. `DefaultRequestHandler` holds the
  // card by reference and reads it on every request.
  const agentCard = buildAgentCard("http://127.0.0.1:0");
  const taskStore = new VanishingTaskStore();
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    new FixtureAgentExecutor({ vanishTask: (taskId) => taskStore.vanish(taskId) }),
  );

  const server = createFixtureHttpServer({
    requestHandler,
    jsonRpcPath: JSONRPC_PATH,
    onCardFetched: () => {
      cardFetches += 1;
    },
  });

  await listen(server, options.port ?? 0);
  const { url, port } = baseUrlOf(server);
  agentCard.supportedInterfaces = agentCard.supportedInterfaces.map((entry) => ({
    ...entry,
    url: `${url}${JSONRPC_PATH}`,
  }));

  return {
    url,
    cardUrl: `${url}/${AGENT_CARD_PATH}`,
    port,
    cardFetchCount: () => cardFetches,
    close: () => close(server),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
