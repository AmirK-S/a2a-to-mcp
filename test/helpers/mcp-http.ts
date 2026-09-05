/**
 * Raw Streamable HTTP client for tests, written against the wire and not
 * against an SDK, so that the bridge is exercised exactly as a client would
 * exercise it and so that CreateTaskResult (which the SDK client rejects,
 * typescript-sdk issue 2637) can be observed unfiltered.
 */

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-11-25";
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

export interface WireExchange {
  status: number;
  headers: Headers;
  body: JsonRpcResponse;
  raw: string;
}

let nextId = 1;

function parseBody(raw: string, contentType: string | null): JsonRpcResponse {
  if (contentType?.includes("text/event-stream")) {
    const dataLines = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0);
    const last = dataLines.at(-1);
    if (!last) {
      throw new Error(`SSE body without data lines: ${raw}`);
    }
    return JSON.parse(last) as JsonRpcResponse;
  }
  return JSON.parse(raw) as JsonRpcResponse;
}

export interface ModernOptions {
  /** Client capabilities placed in the per-request envelope. */
  clientCapabilities?: Record<string, unknown>;
  /** Override or remove headers, for negative tests. `undefined` removes. */
  headers?: Record<string, string | undefined>;
  /** Skip the envelope entirely, for negative tests. */
  omitEnvelope?: boolean;
  id?: number | string;
}

export const TASKS_CLIENT_CAPABILITIES = {
  extensions: { [TASKS_EXTENSION]: {} },
};

/**
 * One request on the 2026-07-28 route: no session, per-request envelope,
 * Mcp-Method on every POST and Mcp-Name on tools/call.
 */
export async function postModern(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  options: ModernOptions = {},
): Promise<WireExchange> {
  const id = options.id ?? nextId++;
  const envelope = options.omitEnvelope
    ? {}
    : {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
          "io.modelcontextprotocol/clientCapabilities": options.clientCapabilities ?? {},
          "io.modelcontextprotocol/clientInfo": { name: "a2a-to-mcp-tests", version: "0.0.0" },
        },
      };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN_VERSION,
    "Mcp-Method": method,
  };
  if (method === "tools/call" && typeof params["name"] === "string") {
    headers["Mcp-Name"] = params["name"];
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) {
      delete headers[name];
    } else {
      headers[name] = value;
    }
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...envelope, ...params } }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: parseBody(raw, response.headers.get("content-type")),
    raw,
  };
}

/**
 * Legacy 2025-11-25 session: initialize, initialized notification, then
 * requests carrying Mcp-Session-Id. Used to prove the bridge still serves
 * Cursor-class clients.
 */
export class LegacySession {
  private sessionId: string | undefined;

  constructor(
    private readonly url: string,
    private readonly clientCapabilities: Record<string, unknown> = {},
  ) {}

  get id(): string | undefined {
    return this.sessionId;
  }

  async initialize(): Promise<WireExchange> {
    const exchange = await this.post("initialize", {
      protocolVersion: LEGACY_VERSION,
      capabilities: this.clientCapabilities,
      clientInfo: { name: "a2a-to-mcp-tests", version: "0.0.0" },
    });
    this.sessionId = exchange.headers.get("mcp-session-id") ?? undefined;
    await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    return exchange;
  }

  async post(method: string, params: Record<string, unknown> = {}): Promise<WireExchange> {
    const id = nextId++;
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const raw = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: parseBody(raw, response.headers.get("content-type")),
      raw,
    };
  }

  async close(): Promise<void> {
    if (this.sessionId) {
      await fetch(this.url, { method: "DELETE", headers: this.headers() }).catch(() => undefined);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": LEGACY_VERSION,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    return headers;
  }
}

export function expectResult(exchange: WireExchange): Record<string, unknown> {
  if (exchange.body.error) {
    throw new Error(
      `expected a result, got error ${exchange.body.error.code}: ${exchange.body.error.message}`,
    );
  }
  if (!exchange.body.result) {
    throw new Error(`no result in ${exchange.raw}`);
  }
  return exchange.body.result;
}

export function expectError(exchange: WireExchange): JsonRpcError {
  if (!exchange.body.error) {
    throw new Error(`expected an error, got ${exchange.raw}`);
  }
  return exchange.body.error;
}

/** Text of every TextContent block, joined. */
export function textOf(result: Record<string, unknown>): string {
  const content = (result["content"] as Array<{ type: string; text?: string }> | undefined) ?? [];
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}
