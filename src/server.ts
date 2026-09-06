/**
 * Assembly of the bridge: the MCP server the SDK serves, the A2A side it
 * fronts, and the HTTP endpoint that carries both eras.
 *
 * One endpoint answers two protocol revisions: a client
 * that probes with server/discover gets 2026-07-28, a client that opens with
 * initialize gets 2025-11-25, and the tools are declared once for both. The
 * SDK builds a fresh server instance per request, so everything that has to
 * survive across requests lives in the closures built here.
 */
import { createRequire } from "node:module";
import type { Server } from "node:http";

import { z } from "zod";
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  createMcpHandler,
  localhostAllowedHostnames,
} from "@modelcontextprotocol/server";

import { A2AClientPool } from "./a2a-client.js";
import { A2A_VERSION, AgentCardResolver, DEFAULT_CARD_TTL_MS } from "./agent-card.js";
import { DEFAULT_HANDLE_TTL_MS, DEFAULT_HOST, DEFAULT_PORT } from "./config.js";
import { BridgeHandles } from "./envelope.js";
import { addressOf, createHttpServer, createRouter } from "./http.js";
import { MrtrService, createBridgeRequestStateCodec } from "./mrtr.js";
import {
  MODERN_REVISION,
  TASKS_EXTENSION_ID,
  TASKS_METHODS,
  TasksService,
  type ClientCapabilitiesView,
} from "./tasks/handlers.js";
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
  /**
   * Extra hostnames accepted in the Host header, without port. The loopback
   * names are always accepted. Anything else is refused before the SDK sees
   * the request (DNS rebinding protection).
   */
  allowedHosts?: string[];
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
  const serverInfo = { name: manifest.name, version: manifest.version };
  const tasks = new TasksService({ handles, agents, ttlMs: handleTtlMs, serverInfo });
  // One codec for the whole process: the 2026-07-28 route serves every request
  // from a fresh server instance, so the key cannot live on the instance, and
  // the state must outlive it exactly as long as the handle it names.
  const requestState = createBridgeRequestStateCodec(handleTtlMs);
  const mrtr = new MrtrService({ handles, agents, requestState });

  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer(serverInfo, {
        instructions: buildInstructions(cards),
        cacheHints: { "tools/list": { ttlMs: TOOLS_LIST_TTL_MS, cacheScope: "private" } },
        // The seam runs this before the handler on every round that echoes a
        // requestState, and answers -32602 when the HMAC or the TTL fails, so
        // a tampered state never reaches a2a_send_message.
        requestState: { verify: requestState.verify },
      });
      mcp.server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });
      registerBridgeTools(mcp, { cards, agents, handles, tasks, mrtr });
      registerTasksHandlers(mcp, tasks);
      return mcp;
    },
    { legacy: "stateless" },
  );

  const router = createRouter({
    handler,
    tasks,
    serverInfo,
    allowedHosts: [...localhostAllowedHostnames(), ...(options.allowedHosts ?? [])],
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
 * Registers the tasks extension methods on the SDK router, era by era.
 *
 * A request carrying the 2026-07-28 per-request envelope is dispatched to
 * TasksService.handle, the same entry point the HTTP interceptor calls, so
 * both routes apply the same two gates: the client must have declared the
 * extension, and the taskId must resolve to a live handle. A request with no
 * such envelope is on the 2025-11-25 route, where the extension is not served
 * at all, and is refused with the capability it would have to declare.
 *
 * Today only the second branch is ever taken: the interceptor answers every
 * modern tasks/* ahead of the SDK, because the SDK rejects tasks/get and
 * tasks/cancel before handler lookup (typescript-sdk issue 2598). The first
 * branch is what lets that interceptor be deleted the day the issue is fixed,
 * without turning every modern tasks/* into a refusal.
 */
function registerTasksHandlers(mcp: McpServer, tasks: TasksService): void {
  const params = z.looseObject({ taskId: z.string().optional() });
  for (const method of TASKS_METHODS) {
    mcp.server.setRequestHandler(method, { params }, async (parsed, ctx) => {
      const envelope = modernEnvelope(ctx);
      if (envelope === undefined) {
        return tasks.refuseOnLegacyRoute();
      }
      return tasks.handle(method, parsed, readClientCapabilities(envelope));
    });
  }
}

/**
 * The per-request envelope of a 2026-07-28 request, or undefined when the
 * request carried none and is therefore served on the legacy route. The SDK
 * lifts the reserved io.modelcontextprotocol/* keys out of the params a
 * handler sees and hands them over as ctx.mcpReq.envelope.
 */
function modernEnvelope(ctx: {
  mcpReq: { envelope?: unknown };
}): Record<string, unknown> | undefined {
  const keys = asObject(ctx.mcpReq.envelope);
  return keys?.[PROTOCOL_VERSION_META_KEY] === MODERN_REVISION ? keys : undefined;
}

function readClientCapabilities(
  envelope: Record<string, unknown>,
): ClientCapabilitiesView | undefined {
  return asObject(envelope[CLIENT_CAPABILITIES_META_KEY]) as ClientCapabilitiesView | undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
    "Every tool takes the agent alias as its first argument when several agents " +
    "are configured; with a single agent the alias may be omitted and defaults to it. " +
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
