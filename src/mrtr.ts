/**
 * The synchronous multi-round-trip, for a client that can elicit but does not
 * hold MCP tasks.
 *
 * Claude Code, measured with 2.1.263, declares exactly {roots, elicitation}:
 * it cannot be handed an MCP task, but it can answer a question. So an A2A
 * task parked in INPUT_REQUIRED comes back as an InputRequiredResult instead
 * of an envelope the model has to notice, and the client replays the same
 * tools/call with the answer. The A2A task stays the same task across the
 * rounds; what carries between them is the requestState.
 *
 * That state round-trips through the client and comes back as attacker
 * controlled input, so it is HMAC sealed by the SDK codec and verified by the
 * seam before this module ever runs (ServerOptions.requestState.verify, which
 * answers -32602 on a tampered value). The sealed payload is signed, not
 * encrypted, and the client can read it: it therefore carries the bridge
 * handles only, never the A2A task id or context id.
 */
import { randomBytes } from "node:crypto";

import { TaskState, type Task } from "@a2a-js/sdk";
import {
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";

import type { A2AClientPool } from "./a2a-client.js";
import { isTask, resultEnvelope, taskEnvelope, type BridgeHandles } from "./envelope.js";
import {
  ANSWER_DESCRIPTION,
  ANSWER_KEY,
  readAnswer,
  statusMessageOf,
} from "./tasks/handlers.js";
import { stateOf } from "./tasks/stream.js";

/**
 * What the bridge seals into requestState between two rounds: the alias and
 * the tk_ handle, and nothing else. The payload is readable by the client, so
 * the A2A task id and context id stay behind the handle table.
 */
export interface RequestStatePayload {
  alias: string;
  taskHandle: string;
}

export type BridgeRequestStateCodec = RequestStateCodec<RequestStatePayload>;

/** Length of the HMAC key, the minimum the SDK codec accepts. */
const REQUEST_STATE_KEY_BYTES = 32;

/**
 * Builds the requestState codec of one bridge.
 *
 * The key is drawn once at startup and never leaves the process: on the
 * 2026-07-28 route every request is served by a fresh server instance, so the
 * state itself is the only thing that survives between rounds, and a single
 * process serves every round of a flow. The state expires with the handle it
 * names, so a replay cannot outlive what it points at.
 */
export function createBridgeRequestStateCodec(ttlMs: number): BridgeRequestStateCodec {
  return createRequestStateCodec<RequestStatePayload>({
    key: randomBytes(REQUEST_STATE_KEY_BYTES),
    ttlSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
  });
}

/**
 * Reads back what the verify hook decoded. The value is already proven by the
 * HMAC, so this only rejects a shape the bridge never minted.
 */
export function readRequestState(value: unknown): RequestStatePayload | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { alias, taskHandle } = value as Record<string, unknown>;
  return typeof alias === "string" && alias !== "" && typeof taskHandle === "string" && taskHandle !== ""
    ? { alias, taskHandle }
    : undefined;
}

export interface MrtrServiceOptions {
  handles: BridgeHandles;
  agents: A2AClientPool;
  requestState: BridgeRequestStateCodec;
}

/** Raised when a requestState names an agent other than the one called. */
export class WrongAgentStateError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `The requestState of this round belongs to agent ${JSON.stringify(actual)}, ` +
        `not to ${JSON.stringify(expected)}. Start the conversation again on one agent.`,
    );
    this.name = "WrongAgentStateError";
  }
}

/** The two rounds of one A2A question asked through MCP elicitation. */
export class MrtrService {
  readonly #handles: BridgeHandles;
  readonly #agents: A2AClientPool;
  readonly #requestState: BridgeRequestStateCodec;

  constructor(options: MrtrServiceOptions) {
    this.#handles = options.handles;
    this.#agents = options.agents;
    this.#requestState = options.requestState;
  }

  /** True when an A2A answer is a task the agent parked on a question. */
  static isWaitingForInput(result: Task): boolean {
    return stateOf(result) === TaskState.TASK_STATE_INPUT_REQUIRED;
  }

  /**
   * Turns an A2A question into the one form-mode elicitation the bridge ever
   * asks for. A2A carries the question as free text with no schema, so the
   * schema is a single required string and the agent wording is the message.
   */
  async ask(alias: string, task: Task): Promise<InputRequiredResult> {
    this.#handles.mintContext(alias, task.contextId);
    const taskHandle = this.#handles.tasks.mintFor(alias, task);
    return inputRequired({
      inputRequests: {
        [ANSWER_KEY]: inputRequired.elicit({
          message: statusMessageOf(task),
          requestedSchema: {
            type: "object",
            properties: {
              [ANSWER_KEY]: { type: "string", description: ANSWER_DESCRIPTION },
            },
            required: [ANSWER_KEY],
          },
        }),
      },
      requestState: await this.#requestState.mint({ alias, taskHandle }),
    });
  }

  /**
   * The round after the client answered.
   *
   * An accepted answer travels to the agent on the same A2A task, and the
   * call waits for the terminal or interrupted state exactly as an ordinary
   * a2a_send_message does; an agent that asks again gets a fresh
   * InputRequiredResult, which is the natural loop of the pattern. A declined
   * or cancelled elicitation cancels the A2A task rather than leaving it
   * parked until its handle expires.
   */
  async resume(
    alias: string,
    state: RequestStatePayload,
    responses: Record<string, unknown> | undefined,
  ): Promise<CallToolResult | InputRequiredResult> {
    if (state.alias !== alias) {
      throw new WrongAgentStateError(alias, state.alias);
    }
    const record = this.#handles.tasks.resolve(state.taskHandle);
    const view = inputResponse(responses, ANSWER_KEY);

    if (view.kind === "elicit" && view.action !== "accept") {
      const canceled = await this.#agents.cancelTask(alias, record.a2aTaskId);
      this.#handles.tasks.markUpdated(state.taskHandle);
      return taskEnvelope(this.#handles, alias, canceled) as CallToolResult;
    }

    const answer = view.kind === "elicit" ? readAnswer(view.content) : undefined;
    if (answer === undefined) {
      // The round came back with nothing usable on the key. Asking again is
      // truer than sending the agent an empty turn.
      return this.ask(alias, record.snapshot);
    }

    const result = await this.#agents.sendMessage(alias, {
      text: answer,
      contextId: record.contextId,
      taskId: record.a2aTaskId,
    });
    if (isTask(result) && MrtrService.isWaitingForInput(result)) {
      return this.ask(alias, result);
    }
    return resultEnvelope(this.#handles, alias, result) as CallToolResult;
  }
}
