/**
 * Assembly of the bridge: the MCP server the SDK serves, the A2A side it
 * fronts, and the HTTP endpoint that carries both eras.
 *
 * One endpoint answers two protocol revisions (DECISIONS.md D01): a client
 * that probes with server/discover gets 2026-07-28, a client that opens with
 * initialize gets 2025-11-25, and the tools are declared once for both. The
 * SDK builds a fresh server instance per request, so everything that has to
 * survive across requests lives in the closures built here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { Server } from "node:http";

import { z } from "zod";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";

import { A2AClientPool } from "./a2a-client.js";
import { A2A_VERSION, AgentCardResolver, DEFAULT_CARD_TTL_MS } from "./agent-card.js";
import { DEFAULT_HANDLE_TTL_MS, DEFAULT_HOST, DEFAULT_PORT } from "./config.js";
import { BridgeHandles } from "./envelope.js";
import {
  LegacyCapabilityStore,
  addressOf,
  createHttpServer,
  createRouter,
  type RequestScope,
} from "./http.js";
import { TASKS_EXTENSION_ID, TASKS_METHODS, TasksService } from "./tasks/handlers.js";
import { registerBridgeTools } from "./tools.js";

/** Path the MCP endpoint is mounted at. */
export const MCP_PATH = "/mcp";

/** Cache hint published for tools/list: the tool set only changes on restart. */
const TOOLS_LIST_TTL_MS = 60_000;

const require = createRequire(import.meta.url);
const manifest = require("../package.json") as { name: string; version: string };

export interface BridgeOptions {
  /** The A2A agents to expose, by alias. */
  agents: Record<string, { cardUrl: string }>;
  /** Lifetime of a task or context handle. Defaults to fifteen minutes. */
  handleTtlMs?: number;
  /** Lifetime of a cached agent card. Defaults to one minute. */
  cardTtlMs?: number;
}

export interface BridgeAddress {
  /** Full URL of the MCP endpoint, ending in /mcp. */
  url: string;
  port: number;
}

export interface Bridge {
  /** Starts the HTTP endpoint. Port 0 binds a free port. */
  listen(port?: number, host?: string): Promise<BridgeAddress>;
  /** Stops the endpoint and releases the SDK handler. */
  close(): Promise<void>;
  /** Serves one request without a socket, for tests and embedding. */
  fetch(request: Request): Promise<Response>;
}

/** Builds a bridge over the configured A2A agents. */
export async function createBridge(options: BridgeOptions): Promise<Bridge> {
  const aliases = Object.keys(options.agents);
  if (aliases.length === 0) {
    throw new Error("A bridge needs at least one A2A agent. None was configured.");
  }

  const handleTtlMs = options.handleTtlMs ?? DEFAULT_HANDLE_TTL_MS;
  const cards = new AgentCardResolver({
    agents: options.agents,
    ttlMs: options.cardTtlMs ?? DEFAULT_CARD_TTL_MS,
  });
  const agents = new A2AClientPool(cards);
  const handles = new BridgeHandles({ ttlMs: handleTtlMs });
  const tasks = new TasksService({ handles, agents, ttlMs: handleTtlMs });
  const serverInfo = { name: manifest.name, version: manifest.version };
  const scope = new AsyncLocalStorage<RequestScope>();

  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer(serverInfo, {
        instructions: buildInstructions(cards),
        cacheHints: { "tools/list": { ttlMs: TOOLS_LIST_TTL_MS, cacheScope: "private" } },
      });
      mcp.server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });
      registerBridgeTools(mcp, { cards, agents, handles });
      registerTasksHandlers(mcp, tasks, scope);
      return mcp;
    },
    { legacy: "stateless" },
  );

  const router = createRouter({
    handler,
    tasks,
    serverInfo,
    sessions: new LegacyCapabilityStore({ ttlMs: handleTtlMs }),
    scope,
  });

  let server: Server | undefined;

  return {
    async listen(port = DEFAULT_PORT, host = DEFAULT_HOST): Promise<BridgeAddress> {
      if (server !== undefined) {
        throw new Error("The bridge is already listening.");
      }
      const started = createHttpServer(router, MCP_PATH);
      await new Promise<void>((resolve, reject) => {
        started.once("error", reject);
        started.listen(port, host, () => {
          started.removeListener("error", reject);
          resolve();
        });
      });
      server = started;
      const bound = addressOf(started);
      return { url: `http://${formatHost(host, bound.host)}:${bound.port}${MCP_PATH}`, port: bound.port };
    },

    async close(): Promise<void> {
      const running = server;
      server = undefined;
      if (running !== undefined) {
        await new Promise<void>((resolve, reject) => {
          running.closeAllConnections();
          running.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
      await handler.close();
    },

    fetch(request: Request): Promise<Response> {
      return router.fetch(request);
    },
  };
}

/**
 * Registers the tasks extension methods on the SDK router.
 *
 * They are reached on the 2025 era route only: on the 2026-07-28 route the
 * SDK rejects tasks/get and tasks/cancel before handler lookup, and the HTTP
 * interceptor answers all three ahead of the SDK (DECISIONS.md D06).
 */
function registerTasksHandlers(
  mcp: McpServer,
  tasks: TasksService,
  scope: AsyncLocalStorage<RequestScope>,
): void {
  const params = z.looseObject({ taskId: z.string().optional() });
  for (const method of TASKS_METHODS) {
    mcp.server.setRequestHandler(method, { params }, async (received) =>
      tasks.handle(method, received, scope.getStore()?.legacyCapabilities),
    );
  }
}

/**
 * The instructions block, rebuilt on every request so an agent name learned
 * since the last one shows up without a restart.
 */
export function buildInstructions(cards: AgentCardResolver): string {
  const described = cards.aliases.map((alias) => {
    const known = cards.peek(alias);
    return known === undefined ? alias : `${alias} (${known.card.name})`;
  });
  return (
    `This server exposes A2A ${A2A_VERSION} agents as MCP tools. ` +
    `The configured agents are: ${described.join(", ")}. ` +
    "Every tool takes the agent alias as its first argument. " +
    "Call a2a_discover on an alias to read that agent card, its skills and its " +
    "capabilities, then a2a_send_message to talk to it. An agent that opens a task " +
    "returns a task handle, which a2a_get_task and a2a_cancel_task take."
  );
}

function formatHost(requested: string, bound: string): string {
  const host = requested === "" ? bound : requested;
  if (host === "0.0.0.0" || host === "::" || host === "") {
    return "127.0.0.1";
  }
  return host.includes(":") ? `[${host}]` : host;
}
