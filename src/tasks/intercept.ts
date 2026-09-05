/**
 * HTTP interception of the tasks methods, on the 2026-07-28 route only.
 *
 * @modelcontextprotocol/server 2.0.0 answers -32601 to tasks/get and
 * tasks/cancel before it ever looks a handler up, because both names live in
 * the 2025 method registry and not in the 2026 one (typescript-sdk#2598,
 * measured in recherche/I04, proofs G and M). No option disarms that guard, so
 * the three methods are answered here, in front of the SDK. Everything else,
 * and every legacy request, is passed straight through.
 *
 * The header validation the SDK performs on its own traffic is not reusable:
 * validateStandardRequestHeaders and validateMcpParamHeaders are not exported.
 * It is reimplemented below with the same codes the SDK uses, plus the rule
 * SEP-2663 adds for this namespace: Mcp-Name carries params.taskId.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  MissingRequiredClientCapabilityError,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  SERVER_INFO_META_KEY,
} from "@modelcontextprotocol/server";

import {
  isTasksMethod,
  type ClientCapabilitiesView,
  type TasksMethod,
  type TasksService,
} from "./handlers.js";

/** Code the 2026-07-28 revision reserves for a header that contradicts the body. */
export const HEADER_MISMATCH_ERROR_CODE = -32020;

/** The two envelope keys a modern request must carry (REQUIRED_ENVELOPE_KEYS). */
const REQUIRED_ENVELOPE_KEYS = [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY] as const;

export interface InterceptContext {
  /** Method named by the Mcp-Method header, when there is one. */
  headerMethod: string | undefined;
  /** Value of the Mcp-Name header, when there is one. */
  headerName: string | undefined;
  /** The raw request body, already buffered by the HTTP layer. */
  body: Buffer;
  /** Server identity stamped on every answer this module writes. */
  serverInfo: { name: string; version: string };
  tasks: TasksService;
}

interface JsonRpcRequestBody {
  id: string | number | null;
  method: string;
  params: Record<string, unknown>;
}

/**
 * Answers a tasks request, or returns undefined so the caller hands the
 * request to the SDK unchanged. Call it only when the request was classified
 * modern: on the legacy route the SDK serves the same handlers correctly.
 */
export async function interceptTasksRequest(
  context: InterceptContext,
): Promise<Response | undefined> {
  const body = parseRequestBody(context.body);
  const bodyMethod = body?.method;
  const claimed = context.headerMethod ?? bodyMethod;

  // The exchange is ours as soon as either side names a tasks method: a
  // header and a body that disagree is exactly the case the -32020 check
  // below exists for, and letting it through would hide the disagreement.
  if (claimed === undefined || !isTasksMethod(claimed)) {
    if (bodyMethod === undefined || !isTasksMethod(bodyMethod)) {
      return undefined;
    }
  }

  const id = body?.id ?? null;

  if (context.headerMethod === undefined) {
    return mismatch(id, "(missing)", `the body names method ${String(bodyMethod)} but the required Mcp-Method header is absent`);
  }
  if (bodyMethod === undefined) {
    return mismatch(id, context.headerMethod, "the Mcp-Method header names a method but the body carries no JSON-RPC request");
  }
  if (context.headerMethod !== bodyMethod) {
    return mismatch(
      id,
      context.headerMethod,
      `the body names method ${bodyMethod} but the Mcp-Method header names ${context.headerMethod}`,
    );
  }

  const method = context.headerMethod as TasksMethod;
  const params = body?.params ?? {};

  // SEP-2663: on Streamable HTTP, tasks/get, tasks/update and tasks/cancel
  // carry Mcp-Name set to params.taskId, so an intermediary can route the
  // request to the instance holding the task.
  const bodyTaskId = typeof params["taskId"] === "string" ? params["taskId"] : undefined;
  if (context.headerName === undefined) {
    return mismatch(
      id,
      "(missing)",
      `the body carries params.taskId=${JSON.stringify(bodyTaskId ?? null)} but the required Mcp-Name header is absent`,
    );
  }
  if (bodyTaskId === undefined || context.headerName !== bodyTaskId) {
    return mismatch(
      id,
      context.headerName,
      `the body carries params.taskId=${JSON.stringify(bodyTaskId ?? null)} but the Mcp-Name header names ${JSON.stringify(context.headerName)}`,
    );
  }

  const envelope = readEnvelope(params);
  if (envelope.missing.length > 0) {
    return jsonRpcError(
      400,
      id,
      ProtocolErrorCode.InvalidParams,
      "Invalid params: the request is missing the required per-request envelope key(s): " +
        envelope.missing.join(", "),
      { envelope: { missing: envelope.missing } },
    );
  }

  try {
    const result = await context.tasks.handle(method, params, envelope.clientCapabilities);
    return jsonResponse(200, {
      jsonrpc: "2.0",
      id,
      result: {
        ...result,
        _meta: { [SERVER_INFO_META_KEY]: context.serverInfo },
      },
    });
  } catch (error) {
    return errorResponse(id, error);
  }
}

/** Serializes an error thrown by the handlers into a JSON-RPC error response. */
export function errorResponse(id: string | number | null, error: unknown): Response {
  if (error instanceof MissingRequiredClientCapabilityError) {
    return jsonRpcError(400, id, ProtocolErrorCode.MissingRequiredClientCapability, error.message, {
      requiredCapabilities: error.requiredCapabilities,
    });
  }
  if (error instanceof ProtocolError) {
    return jsonRpcError(200, id, error.code, error.message, error.data);
  }
  return jsonRpcError(
    200,
    id,
    ProtocolErrorCode.InternalError,
    error instanceof Error ? error.message : String(error),
    undefined,
  );
}

/** Reads the modern per-request envelope out of the params. */
function readEnvelope(params: Record<string, unknown>): {
  missing: string[];
  clientCapabilities: ClientCapabilitiesView | undefined;
} {
  const meta = params["_meta"];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { missing: ["_meta"], clientCapabilities: undefined };
  }
  const envelope = meta as Record<string, unknown>;
  const missing = REQUIRED_ENVELOPE_KEYS.filter((key) => envelope[key] === undefined);
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY];
  return {
    missing: [...missing],
    clientCapabilities:
      typeof capabilities === "object" && capabilities !== null && !Array.isArray(capabilities)
        ? (capabilities as ClientCapabilitiesView)
        : undefined,
  };
}

function parseRequestBody(body: Buffer): JsonRpcRequestBody | undefined {
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
  if (typeof message["method"] !== "string") {
    return undefined;
  }
  const params = message["params"];
  const id = message["id"];
  return {
    id: typeof id === "string" || typeof id === "number" ? id : null,
    method: message["method"],
    params:
      typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {},
  };
}

function mismatch(id: string | number | null, header: string, explanation: string): Response {
  return jsonRpcError(
    400,
    id,
    HEADER_MISMATCH_ERROR_CODE,
    `Bad Request: the request headers and body disagree: ${explanation}`,
    { mismatch: { header, body: explanation } },
  );
}

function jsonRpcError(
  status: number,
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return jsonResponse(status, {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
