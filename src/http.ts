/**
 * The HTTP face of the bridge: one node:http server in front of the SDK
 * handler.
 *
 * Two things happen here and nowhere else. The request body is buffered once
 * and replayed into as many web Requests as needed, because the SDK consumes a
 * web Request and never touches the Node stream. And a modern request naming a
 * tasks method is answered by the interceptor rather than by the SDK
 * (typescript-sdk issue 2598).
 *
 * Nothing else is remembered between requests: the bridge holds no session, it
 * never reads and never mints an Mcp-Session-Id, and the legacy route serves
 * the tasks methods with a refusal that needs no handshake.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  hostHeaderValidationResponse,
  isLegacyRequest,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import type { TasksService } from "./tasks/handlers.js";
import { interceptTasksRequest } from "./tasks/intercept.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface RouterOptions {
  handler: McpHttpHandler;
  /** Hostnames accepted in the Host header, without port (DNS rebinding protection). */
  allowedHosts: string[];
  tasks: TasksService;
  serverInfo: { name: string; version: string };
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
      }
      return options.handler.fetch(rebuild());
    },
  };
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
