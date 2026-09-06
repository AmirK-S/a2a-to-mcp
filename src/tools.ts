/**
 * The four generic tools of the bridge.
 *
 * Generic rather than one tool per skill: an A2A agent is a peer that takes
 * free text, not a function with a signature, so the agent alias is an
 * argument and the tool count stays at four however many agents are wired.
 *
 * Two schemas are declared per tool, and the reason is worth stating. The
 * published inputSchema types `agent` as an enum of the configured aliases, so
 * a client sees the choice in tools/list. The validation schema types it as a
 * plain string, so an alias the client invented reaches the executor and comes
 * back as a tool result naming the aliases that do exist, rather than as a
 * -32602 the model cannot act on. A missing or ill-typed argument stays a
 * -32602, because that is a client bug and not an agent outcome.
 */
import { z } from "zod";
import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
} from "@modelcontextprotocol/server";
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";

import { A2ABridgeError, a2aErrorName, type A2AClientPool } from "./a2a-client.js";
import {
  A2A_VERSION,
  AgentCardError,
  UnknownAgentError,
  type AgentCardResolver,
  type ResolvedAgent,
} from "./agent-card.js";
import { isTask, resultEnvelope, taskEnvelope, type BridgeHandles } from "./envelope.js";
import { HandleExpiredError, UnknownHandleError } from "./handles.js";
import { MrtrService, readRequestState, type RequestStatePayload } from "./mrtr.js";
import { A2A_META_KEY } from "./parts.js";
import {
  MODERN_REVISION,
  TASKS_EXTENSION_ID,
  type TasksService,
} from "./tasks/handlers.js";

/** The four tool names, in the order they are registered. */
export const TOOL_NAMES = [
  "a2a_discover",
  "a2a_send_message",
  "a2a_get_task",
  "a2a_cancel_task",
] as const;

export interface ToolDeps {
  cards: AgentCardResolver;
  agents: A2AClientPool;
  handles: BridgeHandles;
  tasks: TasksService;
  mrtr: MrtrService;
}

/** What one tools/call says about the client and about its round. */
export interface CallContext {
  /**
   * True when the client declared the tasks extension on the modern route.
   * The declaration is read from the per-request envelope and nowhere else:
   * the bridge holds no session, so a legacy client never reaches this
   * (DECISIONS.md D08).
   */
  tasksExtension: boolean;
  /**
   * True when the client declared elicitation on the modern route. Read from
   * the same envelope, for the same reason: the legacy leg is served
   * statelessly by instances that never saw an initialize, so the capabilities
   * of that handshake are not recoverable there.
   */
  elicitation: boolean;
  /** Input responses of a retried round, lifted by the SDK. Untrusted. */
  inputResponses: Record<string, unknown> | undefined;
  /** The requestState the seam verified and decoded, when the round had one. */
  requestState: RequestStatePayload | undefined;
}

/** The handler context fields the bridge reads out of one tools/call. */
export interface HandlerContext {
  mcpReq: {
    envelope?: unknown;
    inputResponses?: Record<string, unknown> | undefined;
    requestState: <T>() => T | undefined;
  };
}

interface BridgeTool {
  name: string;
  title: string;
  description: string;
  /** Schema published in tools/list: agent is an enum of the aliases. */
  inputSchema: z.ZodType<Record<string, unknown>>;
  /** Schema used to validate a call: agent is any string. */
  argsSchema: z.ZodType<Record<string, unknown>>;
  run: (
    args: Record<string, unknown>,
    deps: ToolDeps,
    context: CallContext,
  ) => Promise<CallToolResult | InputRequiredResult>;
}

/** Registers the four tools and takes tools/call over from the SDK. */
export function registerBridgeTools(mcp: McpServer, deps: ToolDeps): void {
  const tools = buildTools(deps);
  for (const tool of tools) {
    mcp.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      // Never reached: the tools/call handler installed below answers first.
      // registerTool is used for its tools/list side, and for nothing else.
      async () => ({ content: [] }),
    );
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // McpServer wraps input validation in a try/catch and turns it into an
  // isError result. The 2026-07-28 revision wants a malformed call to be a
  // -32602 protocol error instead, so tools/call is served here.
  mcp.server.setRequestHandler("tools/call", async (request, ctx) => {
    const name = request.params.name;
    const tool = byName.get(name);
    if (tool === undefined) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`);
    }
    const parsed = tool.argsSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Invalid arguments for tool ${name}: ${formatIssues(parsed.error)}`,
      );
    }
    try {
      return await tool.run(parsed.data, deps, readCallContext(ctx));
    } catch (error) {
      return toolError(error);
    }
  });
}

function buildTools(deps: ToolDeps): BridgeTool[] {
  const aliases = deps.cards.aliases;
  const agentEnum = z.enum(aliases as [string, ...string[]]).describe(agentDescription(aliases));
  const agentString = z.string().min(1).describe(agentDescription(aliases));
  const retention = deps.handles.describeRetention();

  return [
    {
      name: "a2a_discover",
      title: "Discover an A2A agent",
      description:
        "Fetches and returns the agent card of one configured A2A agent: its name, " +
        "description, transport interfaces, capabilities and skills. Call it before the " +
        "other tools to learn what the agent can be asked for. The card is served from a " +
        "short lived cache, so repeated calls do not hit the agent.",
      inputSchema: z.object({ agent: agentEnum }),
      argsSchema: z.object({ agent: agentString }),
      run: async (args, dependencies) => discover(String(args["agent"]), dependencies),
    },
    {
      name: "a2a_send_message",
      title: "Send a message to an A2A agent",
      description:
        "Sends one text message to an A2A agent and returns its answer, which is either a " +
        "direct message or a task. The reply carries a context handle, and a task handle " +
        "when the agent opened a task. Pass contextHandle back to continue the same " +
        "conversation, and taskHandle back to answer a task the agent left waiting for " +
        `input. ${retention}`,
      inputSchema: z.object({
        agent: agentEnum,
        text: z.string().min(1).describe("The message text to send to the agent."),
        contextHandle: z
          .string()
          .optional()
          .describe("Context handle returned by an earlier call, to continue that conversation."),
        taskHandle: z
          .string()
          .optional()
          .describe("Task handle returned by an earlier call, to answer a task awaiting input."),
      }),
      argsSchema: z.object({
        agent: agentString,
        text: z.string().min(1),
        contextHandle: z.string().optional(),
        taskHandle: z.string().optional(),
      }),
      run: async (args, dependencies, context) => sendMessage(args, dependencies, context),
    },
    {
      name: "a2a_get_task",
      title: "Read an A2A task",
      description:
        "Reads the current state of a task an A2A agent opened, by the task handle an " +
        "earlier call returned. Use historyLength to limit how many past messages come " +
        `back. ${retention}`,
      inputSchema: z.object({
        agent: agentEnum,
        taskHandle: z.string().describe("Task handle returned by an earlier call."),
        historyLength: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Maximum number of recent messages to include. Zero asks for none."),
      }),
      argsSchema: z.object({
        agent: agentString,
        taskHandle: z.string().min(1),
        historyLength: z.number().int().min(0).optional(),
      }),
      run: async (args, dependencies) => getTask(args, dependencies),
    },
    {
      name: "a2a_cancel_task",
      title: "Cancel an A2A task",
      description:
        "Asks an A2A agent to cancel a task, by the task handle an earlier call returned. " +
        "Cancellation is cooperative in A2A: the agent acknowledges the request but may " +
        `still finish the work, so read the state that comes back. ${retention}`,
      inputSchema: z.object({
        agent: agentEnum,
        taskHandle: z.string().describe("Task handle returned by an earlier call."),
      }),
      argsSchema: z.object({ agent: agentString, taskHandle: z.string().min(1) }),
      run: async (args, dependencies) => cancelTask(args, dependencies),
    },
  ];
}

async function discover(alias: string, deps: ToolDeps): Promise<CallToolResult> {
  const resolved = await deps.cards.get(alias);
  return {
    content: [{ type: "text", text: summarize(resolved) }],
    structuredContent: resolved.card as unknown as Record<string, unknown>,
    _meta: { [A2A_META_KEY]: { cardUrl: resolved.cardUrl, a2aVersion: A2A_VERSION } },
  };
}

async function sendMessage(
  args: Record<string, unknown>,
  deps: ToolDeps,
  context: CallContext,
): Promise<CallToolResult | InputRequiredResult> {
  const alias = String(args["agent"]);
  // Validates the alias without a fetch: a handle is checked before the
  // network, so an unknown handle is reported as such even when the agent
  // card happens to be unreachable.
  deps.cards.cardUrlOf(alias);

  if (context.requestState !== undefined) {
    // A later round of a multi round trip: the arguments are the ones the
    // first round was called with, and what matters is the answer the client
    // collected and the task the verified state names.
    return deps.mrtr.resume(alias, context.requestState, context.inputResponses);
  }

  let contextId: string | undefined;
  let taskId: string | undefined;

  const taskHandle = args["taskHandle"];
  if (typeof taskHandle === "string") {
    const record = deps.handles.tasks.resolve(taskHandle);
    assertSameAgent(alias, record.alias, taskHandle);
    taskId = record.a2aTaskId;
    contextId = record.contextId;
  }

  const contextHandle = args["contextHandle"];
  if (typeof contextHandle === "string") {
    const record = deps.handles.resolveContext(contextHandle);
    assertSameAgent(alias, record.alias, contextHandle);
    contextId = record.contextId;
  }

  const input = {
    text: String(args["text"]),
    ...(contextId === undefined ? {} : { contextId }),
    ...(taskId === undefined ? {} : { taskId }),
  };

  if (context.tasksExtension) {
    // The client can hold an MCP task, so an A2A task becomes one instead of
    // being waited out inside the tool call.
    const outcome = await deps.tasks.createTask(alias, input);
    if (outcome.kind === "task") {
      return outcome.result as unknown as CallToolResult;
    }
    return resultEnvelope(deps.handles, alias, outcome.result) as CallToolResult;
  }

  const result = await deps.agents.sendMessage(alias, input);
  if (context.elicitation && isTask(result) && MrtrService.isWaitingForInput(result)) {
    // The client cannot hold an MCP task but can answer a question, so the
    // interruption becomes an elicitation the client fulfils and replays,
    // rather than an envelope the model has to notice on its own.
    return deps.mrtr.ask(alias, result);
  }
  return resultEnvelope(deps.handles, alias, result) as CallToolResult;
}

/**
 * Reads what one tools/call declares and what it carries back.
 *
 * The SDK lifts the reserved io.modelcontextprotocol/* keys out of the params
 * a handler sees and hands them over as ctx.mcpReq.envelope, and it lifts the
 * multi round trip fields out the same way. Both the revision and the
 * declarations are checked: the envelope exists on the 2026-07-28 route only,
 * and neither the extension nor the multi round trip is served elsewhere, so a
 * legacy request can never open an MCP task nor be handed an elicitation
 * however it words its params (DECISIONS.md D08).
 *
 * The requestState has already passed the seam verify hook by the time a
 * handler runs, so what the accessor returns here is the decoded payload of a
 * state this bridge minted, not raw client input.
 */
export function readCallContext(ctx: HandlerContext): CallContext {
  const keys = readObject(ctx.mcpReq.envelope);
  if (keys === undefined || keys[PROTOCOL_VERSION_META_KEY] !== MODERN_REVISION) {
    return {
      tasksExtension: false,
      elicitation: false,
      inputResponses: undefined,
      requestState: undefined,
    };
  }
  const capabilities = readObject(keys[CLIENT_CAPABILITIES_META_KEY]);
  const extensions = readObject(capabilities?.["extensions"]);
  return {
    tasksExtension: extensions?.[TASKS_EXTENSION_ID] !== undefined,
    elicitation: capabilities?.["elicitation"] !== undefined,
    inputResponses: ctx.mcpReq.inputResponses,
    requestState: readRequestState(ctx.mcpReq.requestState()),
  };
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function getTask(args: Record<string, unknown>, deps: ToolDeps): Promise<CallToolResult> {
  const alias = String(args["agent"]);
  const handle = String(args["taskHandle"]);
  deps.cards.cardUrlOf(alias);
  const record = deps.handles.tasks.resolve(handle);
  assertSameAgent(alias, record.alias, handle);
  const historyLength = args["historyLength"];
  const task = await deps.agents.getTask(
    alias,
    record.a2aTaskId,
    typeof historyLength === "number" ? historyLength : undefined,
  );
  deps.handles.tasks.markUpdated(handle);
  return taskEnvelope(deps.handles, alias, task, { includeHistory: true }) as CallToolResult;
}

async function cancelTask(args: Record<string, unknown>, deps: ToolDeps): Promise<CallToolResult> {
  const alias = String(args["agent"]);
  const handle = String(args["taskHandle"]);
  deps.cards.cardUrlOf(alias);
  const record = deps.handles.tasks.resolve(handle);
  assertSameAgent(alias, record.alias, handle);
  const task = await deps.agents.cancelTask(alias, record.a2aTaskId);
  deps.handles.tasks.markUpdated(handle);
  return taskEnvelope(deps.handles, alias, task) as CallToolResult;
}

/** Raised when a handle minted for one agent is replayed against another. */
class WrongAgentError extends Error {
  constructor(expected: string, actual: string, handle: string) {
    super(
      `Handle ${JSON.stringify(handle)} belongs to agent ${JSON.stringify(actual)}, ` +
        `not to ${JSON.stringify(expected)}. Handles are not shared between agents.`,
    );
    this.name = "WrongAgentError";
  }
}

function assertSameAgent(expected: string, actual: string, handle: string): void {
  if (expected !== actual) {
    throw new WrongAgentError(expected, actual, handle);
  }
}

/**
 * Turns any execution failure into a tool result. An MCP client can show a
 * tool result to the model and let it try something else; a JSON-RPC error
 * usually aborts the turn, which is the wrong answer for an agent that simply
 * declined.
 */
export function toolError(error: unknown): CallToolResult {
  const message = describeError(error);
  const structured: Record<string, unknown> = { error: message };
  if (error instanceof A2ABridgeError && error.a2aErrorCode !== undefined) {
    structured["a2aErrorCode"] = error.a2aErrorCode;
  }
  if (error instanceof A2ABridgeError && error.a2aReason !== undefined) {
    structured["a2aReason"] = error.a2aReason;
  }
  if (error instanceof AgentCardError) {
    structured["cardUrl"] = error.cardUrl;
  }
  if (error instanceof UnknownAgentError) {
    structured["agent"] = error.alias;
  }
  if (error instanceof UnknownHandleError || error instanceof HandleExpiredError) {
    structured["handle"] = error.handle;
  }
  return {
    content: [{ type: "text", text: message }],
    structuredContent: structured,
    isError: true,
  };
}

/**
 * The one line a model reads. A typed A2A failure is announced by the name
 * and the code the A2A specification gives it, `TaskNotFound (-32001): ...`,
 * so the code is legible in the text as well as in structuredContent: a
 * client that only renders content still shows which of the nine errors the
 * agent raised.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof A2ABridgeError)) {
    return message;
  }
  const name = a2aErrorName(error.a2aErrorCode);
  if (name === undefined || error.a2aErrorCode === undefined) {
    return message;
  }
  return `${name} (${error.a2aErrorCode}): ${message}`;
}

/** The human readable summary of a card, for clients that ignore structuredContent. */
export function summarize(resolved: ResolvedAgent): string {
  const card = resolved.card;
  const lines: string[] = [];
  lines.push(`${card.name}${card.version ? ` (version ${card.version})` : ""}`);
  if (card.description) {
    lines.push(card.description);
  }
  lines.push(
    `A2A ${resolved.agentInterface.protocolVersion || A2A_VERSION} over ` +
      `${resolved.agentInterface.protocolBinding} at ${resolved.agentInterface.url}`,
  );
  lines.push(
    `Streaming: ${card.capabilities?.streaming ? "supported" : "not supported"}. ` +
      `Push notifications: ${card.capabilities?.pushNotifications ? "supported" : "not supported"}.`,
  );
  const skills = card.skills ?? [];
  lines.push(`Skills (${skills.length}):`);
  for (const skill of skills) {
    lines.push(`  ${skill.id}: ${skill.name}. ${skill.description}`);
  }
  return lines.join("\n");
}

function agentDescription(aliases: readonly string[]): string {
  return `Alias of the A2A agent to talk to. Configured aliases: ${aliases.join(", ")}.`;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
