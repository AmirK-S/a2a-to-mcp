/**
 * Minimal HTTP adapter for the fixture agent, built on `node:http`.
 *
 * The SDK ships an Express adapter under `@a2a-js/sdk/server/express`, but
 * Express is only an optional peer dependency
 * (`node_modules/@a2a-js/sdk/package.json`, `peerDependenciesMeta.express`)
 * and is not installed here. Everything the adapter needs below Express is
 * public: `JsonRpcTransportHandler` does the dispatch and the ProtoJSON
 * serialization, `defaultServerCallContextBuilder` builds the call context,
 * and `SSE_HEADERS` / `formatSSEEvent` frame the stream. Only the routing,
 * the body read and the SSE write are ours.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AGENT_CARD_PATH,
  Extensions,
  HTTP_EXTENSION_HEADER,
  SSE_HEADERS,
  formatSSEErrorEvent,
  formatSSEEvent,
  type AgentCard,
} from "@a2a-js/sdk";
import {
  A2ARequestHandler,
  JsonRpcTransportHandler,
  UnauthenticatedUser,
  defaultServerCallContextBuilder,
  validateVersion,
} from "@a2a-js/sdk/server";

const CARD_PATH = `/${AGENT_CARD_PATH}`;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

type JsonRpcResponseBody = { jsonrpc: string; id: string | number | null };

export interface FixtureHttpServerOptions {
  requestHandler: A2ARequestHandler;
  /** Path where the JSON-RPC interface is mounted, for example `/a2a`. */
  jsonRpcPath: string;
  /** Called on every successful GET of the agent card. */
  onCardFetched: () => void;
}

/**
 * Builds an unstarted `http.Server` serving the agent card and the
 * JSON-RPC interface. Callers own `listen` and `close`.
 */
export function createFixtureHttpServer(options: FixtureHttpServerOptions): Server {
  const transportHandler = new JsonRpcTransportHandler(options.requestHandler);

  return createServer((req, res) => {
    void route(req, res, options, transportHandler).catch((error: unknown) => {
      writeJson(res, 500, {
        jsonrpc: "2.0",
        id: null,
        error: JsonRpcTransportHandler.mapToJSONRPCError(error),
      });
    });
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: FixtureHttpServerOptions,
  transportHandler: JsonRpcTransportHandler,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (req.method === "GET" && path === CARD_PATH) {
    const card = await options.requestHandler.getAgentCard();
    options.onCardFetched();
    // Serialized with `JSON.stringify`, exactly like the SDK's Express
    // card handler: `AgentCard` carries no oneof and no enum, so the
    // in-memory shape is already the wire shape.
    writeJson(res, 200, card);
    return;
  }

  if (req.method === "POST" && path === options.jsonRpcPath) {
    await handleJsonRpc(req, res, options.requestHandler, transportHandler);
    return;
  }

  writeJson(res, 404, { error: `No A2A route at ${req.method ?? "?"} ${path}` });
}

async function handleJsonRpc(
  req: IncomingMessage,
  res: ServerResponse,
  requestHandler: A2ARequestHandler,
  transportHandler: JsonRpcTransportHandler,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON payload." },
    });
    return;
  }
  const requestId = (body.id ?? null) as string | number | null;

  try {
    const context = defaultServerCallContextBuilder({
      extensions: Extensions.parseServiceParameter(header(req, HTTP_EXTENSION_HEADER)),
      user: new UnauthenticatedUser(),
      headers: req.headers,
      // The SDK's default is to read an absent header as v0.3. This
      // fixture is v1.0-only, so an absent header means v1.0 and only an
      // explicit non-1.0 value is rejected.
      requestedVersion: header(req, A2A_VERSION_HEADER) ?? A2A_PROTOCOL_VERSION,
    });

    const card = await requestHandler.getAgentCard();
    validateVersion(context.requestedVersion, card, "JSONRPC");

    const result = await transportHandler.handle(body, context);

    if (context.activatedExtensions) {
      res.setHeader(HTTP_EXTENSION_HEADER, Array.from(context.activatedExtensions));
    }

    if (!isAsyncGenerator(result)) {
      writeJson(res, 200, result);
      return;
    }

    // Pull the first event before committing to SSE, so an early failure
    // still surfaces as a plain JSON-RPC error response.
    const iterator = result[Symbol.asyncIterator]();
    let first: IteratorResult<JsonRpcResponseBody>;
    try {
      first = await iterator.next();
    } catch (streamError) {
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id: requestId,
        error: JsonRpcTransportHandler.mapToJSONRPCError(streamError),
      });
      return;
    }

    res.writeHead(200, SSE_HEADERS);
    try {
      let current = first;
      while (!current.done) {
        res.write(formatSSEEvent(current.value));
        current = await iterator.next();
      }
    } catch (streamError) {
      res.write(
        formatSSEErrorEvent({
          jsonrpc: "2.0",
          id: requestId,
          error: JsonRpcTransportHandler.mapToJSONRPCError(streamError),
        }),
      );
    } finally {
      await iterator.return?.();
      res.end();
    }
  } catch (error) {
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id: requestId,
      error: JsonRpcTransportHandler.mapToJSONRPCError(error),
    });
  }
}

function isAsyncGenerator(
  value: unknown,
): value is AsyncGenerator<JsonRpcResponseBody, void, undefined> {
  return (
    typeof (value as AsyncGenerator | undefined)?.[Symbol.asyncIterator] === "function"
  );
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Resolves the `http://127.0.0.1:<port>` base URL of a listening server. */
export function baseUrlOf(server: Server): { url: string; port: number } {
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Server is not listening.");
  }
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}

export { CARD_PATH };
