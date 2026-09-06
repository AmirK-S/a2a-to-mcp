/**
 * The HTTP face of the bridge: one node:http server in front of the SDK
 * handler.
 *
 * Three things happen here and nowhere else. The request body is buffered once
 * and replayed into as many web Requests as needed, because the SDK consumes a
 * web Request and never touches the Node stream. A modern request naming a
 * tasks method is answered by the interceptor rather than by the SDK
 * (DECISIONS.md D06). And the capabilities a legacy client declared at
 * initialize are remembered across its requests, because createMcpHandler
 * serves 2025 era traffic from a fresh instance per request, which by
 * construction has never seen an initialize.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

import {
  hostHeaderValidationResponse,
  isLegacyRequest,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import type { ClientCapabilitiesView, TasksService } from "./tasks/handlers.js";
import { interceptTasksRequest } from "./tasks/intercept.js";

/** Header a legacy client echoes back so the bridge finds its declaration. */
const SESSION_HEADER = "Mcp-Session-Id";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** What the bridge knows about the client while one request is being served. */
export interface RequestScope {
  /** Capabilities declared at initialize, on the 2025 era route only. */
  legacyCapabilities: ClientCapabilitiesView | undefined;
}

/**
 * The capabilities legacy clients declared, keyed by a session identifier the
 * bridge mints on their initialize response.
 *
 * This is the one piece of session state the bridge holds, and it holds
 * nothing else: no task, no context, no conversation. It exists because the
 * tasks extension requires the server to refuse a client that did not declare
 * it, and a stateless legacy instance cannot recall an earlier handshake.
 */
export class LegacyCapabilityStore {
  readonly #entries = new Map<string, { capabilities: ClientCapabilitiesView; expiresAt: number }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs: number; now?: () => number }) {
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  /** Remembers one declaration and returns the session identifier for it. */
  remember(capabilities: ClientCapabilitiesView): string {
    this.#sweep();
    const id = randomBytes(16).toString("base64url");
    this.#entries.set(id, { capabilities, expiresAt: this.#now() + this.#ttlMs });
    return id;
  }

  /** The declaration behind a session identifier, if it is still live. */
  get(id: string | null | undefined): ClientCapabilitiesView | undefined {
    if (!id) {
      return undefined;
    }
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(id);
      return undefined;
    }
    return entry.capabilities;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(id);
      }
    }
  }
}

export interface RouterOptions {
  handler: McpHttpHandler;
  /** Hostnames accepted in the Host header, without port (DNS rebinding protection). */
  allowedHosts: string[];
  tasks: TasksService;
  serverInfo: { name: string; version: string };
  sessions: LegacyCapabilityStore;
  scope: AsyncLocalStorage<RequestScope>;
}

export interface BridgeRouter {
  fetch(request: Request): Promise<Response>;
}

/** Builds the fetch-shaped entry point of the bridge. */
export function createRouter(options: RouterOptions): BridgeRouter {
  return {
    async fetch(request: Request): Promise<Response> {
      const rejected = hostHeaderValidationResponse(request, options.allowedHosts);
      if (rejected !== undefined) {
        return rejected;
      }
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? Buffer.alloc(0)
          : Buffer.from(await request.arrayBuffer());
      const rebuild = (): Request => rebuildRequest(request, body);

      const legacy = await isLegacyRequest(rebuild());
      if (!legacy) {
        const intercepted = await interceptTasksRequest({
          headerMethod: request.headers.get("mcp-method") ?? undefined,
          headerName: request.headers.get("mcp-name") ?? undefined,
          body,
          serverInfo: options.serverInfo,
          tasks: options.tasks,
        });
        if (intercepted !== undefined) {
          return intercepted;
        }
        return options.scope.run({ legacyCapabilities: undefined }, () =>
          options.handler.fetch(rebuild()),
        );
      }

      const declared = readInitializeCapabilities(body);
      const scope: RequestScope = {
        legacyCapabilities:
          declared ?? options.sessions.get(request.headers.get("mcp-session-id")),
      };
      const response = await options.scope.run(scope, () => options.handler.fetch(rebuild()));
      if (declared === undefined) {
        return response;
      }
      // The bridge answers initialize with a session identifier of its own so
      // the declaration above can be found again on the next request.
      const headers = new Headers(response.headers);
      headers.set(SESSION_HEADER, options.sessions.remember(declared));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

/** The capabilities of a legacy initialize body, or undefined for any other request. */
function readInitializeCapabilities(body: Buffer): ClientCapabilitiesView | undefined {
  if (body.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const message = parsed as Record<string, unknown>;
  if (message["method"] !== "initialize") {
    return undefined;
  }
  const params = message["params"];
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {};
  }
  const capabilities = (params as Record<string, unknown>)["capabilities"];
  if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
    return {};
  }
  return capabilities as ClientCapabilitiesView;
}

function rebuildRequest(original: Request, body: Buffer): Request {
  const init: RequestInit & { duplex?: string } = {
    method: original.method,
    headers: original.headers,
  };
  if (body.length > 0) {
    init.body = body;
    init.duplex = "half";
  }
  return new Request(original.url, init);
}

/** Builds the unstarted node:http server that serves the router. */
export function createHttpServer(router: BridgeRouter, path: string): Server {
  return createServer((req, res) => {
    void serve(req, res, router, path).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    });
  });
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  router: BridgeRouter,
  path: string,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (requestUrl.pathname !== path) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `No MCP endpoint at ${requestUrl.pathname}. Use ${path}.` }));
    return;
  }

  const body = await readBody(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    for (const single of Array.isArray(value) ? value : [value]) {
      headers.append(name, single);
    }
  }

  const init: RequestInit & { duplex?: string } = { method: req.method ?? "GET", headers };
  if (body.length > 0 && req.method !== "GET" && req.method !== "HEAD") {
    init.body = body;
    init.duplex = "half";
  }
  const response = await router.fetch(new Request(requestUrl.toString(), init));

  const outgoing: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    outgoing[name] = value;
  });
  res.writeHead(response.status, outgoing);
  if (response.body === null) {
    res.end();
    return;
  }
  // The legacy leg answers in SSE, so the body is streamed rather than
  // buffered: a keep-alive stream must not be held until it closes.
  const reader = response.body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    res.write(Buffer.from(chunk.value));
  }
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Resolves the base URL of a listening server. */
export function addressOf(server: Server): { host: string; port: number } {
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    throw new Error("The bridge is not listening.");
  }
  return { host: address.address, port: address.port };
}
