/**
 * The only layer that talks to an upstream A2A agent.
 *
 * One @a2a-js/sdk client per alias, built from the card the resolver already
 * fetched and pinned to the JSON-RPC binding: the SDK otherwise takes the
 * first entry of supportedInterfaces, which may be HTTP+JSON or gRPC.
 *
 * Every A2A error is translated into an A2ABridgeError. The numeric A2A code
 * (-32001 TASK_NOT_FOUND and friends) is carried as data, never re-emitted as
 * a JSON-RPC code: those codes belong to the A2A envelope, and reusing them on
 * the MCP wire would claim an MCP meaning they do not have.
 */
import { randomUUID } from "node:crypto";

import {
  Role,
  type Message,
  type Part,
  type SendMessageConfiguration,
  type SendMessageResult,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import { A2AError, isJsonRpcError } from "@a2a-js/sdk/errors";

import type { AgentCardResolver } from "./agent-card.js";

/** An upstream A2A failure, ready to be reported as an MCP tool error. */
export class A2ABridgeError extends Error {
  /** The numeric code of the A2A JSON-RPC envelope, when there was one. */
  readonly a2aErrorCode: number | undefined;
  /** The UPPER_SNAKE_CASE reason of the A2A error, when the SDK typed it. */
  readonly a2aReason: string | undefined;

  constructor(message: string, a2aErrorCode?: number, a2aReason?: string) {
    super(message);
    this.name = "A2ABridgeError";
    this.a2aErrorCode = a2aErrorCode;
    this.a2aReason = a2aReason;
  }
}

/** What a2a_send_message hands to the upstream agent. */
export interface SendMessageInput {
  text: string;
  /** A2A context id, to continue a conversation. */
  contextId?: string;
  /** A2A task id, to answer a task parked in INPUT_REQUIRED. */
  taskId?: string;
}

export class A2AClientPool {
  readonly #cards: AgentCardResolver;
  readonly #clients = new Map<string, { client: Client; interfaceUrl: string }>();

  constructor(cards: AgentCardResolver) {
    this.#cards = cards;
  }

  /**
   * Sends one text message. Waits for a terminal or interrupted state by
   * default; `returnImmediately` asks the agent to answer as soon as the
   * task exists, which is what the tasks extension needs from an agent that
   * does not stream.
   */
  async sendMessage(
    alias: string,
    input: SendMessageInput,
    options: { returnImmediately?: boolean } = {},
  ): Promise<SendMessageResult> {
    const client = await this.#clientFor(alias);
    return this.#call(alias, "SendMessage", () =>
      client.sendMessage({
        tenant: "",
        message: buildUserMessage(input),
        // Left unset unless the caller asks otherwise: the SDK fills the
        // configuration from its own ClientConfig, which defaults to
        // returnImmediately false.
        configuration: immediateConfiguration(options.returnImmediately),
        metadata: undefined,
      }),
    );
  }

  /**
   * Opens the SendStreamingMessage stream of an agent. The generator is
   * handed back unconsumed: the caller reads the first event to answer the
   * MCP request, then keeps pulling in the background.
   */
  async sendMessageStream(
    alias: string,
    input: SendMessageInput,
  ): Promise<AsyncGenerator<StreamResponse, void, undefined>> {
    const client = await this.#clientFor(alias);
    return this.#call(alias, "SendStreamingMessage", () =>
      Promise.resolve(
        client.sendMessageStream({
          tenant: "",
          message: buildUserMessage(input),
          configuration: undefined,
          metadata: undefined,
        }),
      ),
    );
  }

  /** True when the agent card of an alias declares streaming support. */
  async supportsStreaming(alias: string): Promise<boolean> {
    const resolved = await this.#cards.get(alias);
    return resolved.card.capabilities?.streaming === true;
  }

  /** Reads one task back, optionally trimming its history. */
  async getTask(alias: string, taskId: string, historyLength?: number): Promise<Task> {
    const client = await this.#clientFor(alias);
    return this.#call(alias, "GetTask", () =>
      client.getTask({
        tenant: "",
        id: taskId,
        ...(historyLength === undefined ? {} : { historyLength }),
      }),
    );
  }

  /** Asks the agent to cancel a task. Cancellation is cooperative in A2A. */
  async cancelTask(alias: string, taskId: string): Promise<Task> {
    const client = await this.#clientFor(alias);
    return this.#call(alias, "CancelTask", () =>
      client.cancelTask({ tenant: "", id: taskId, metadata: undefined }),
    );
  }

  /** Drops the cached client of an alias, so the next call rebuilds it. */
  forget(alias: string): void {
    this.#clients.delete(alias);
  }

  async #clientFor(alias: string): Promise<Client> {
    const resolved = await this.#cards.get(alias);
    const cached = this.#clients.get(alias);
    if (cached !== undefined && cached.interfaceUrl === resolved.agentInterface.url) {
      return cached.client;
    }
    // Only the JSON-RPC factory is registered, so an agent that stopped
    // offering that binding fails loudly instead of silently switching.
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory()],
      preferredTransports: ["JSONRPC"],
    });
    const client = await factory.createFromAgentCard(resolved.card);
    this.#clients.set(alias, { client, interfaceUrl: resolved.agentInterface.url });
    return client;
  }

  async #call<T>(alias: string, operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw toBridgeError(alias, operation, error);
    }
  }
}

/** Builds the single text part user message the bridge sends. */
/**
 * The configuration asking an agent to answer as soon as the task exists.
 * Undefined keeps the SDK default, which waits for a terminal or interrupted
 * state.
 */
function immediateConfiguration(
  returnImmediately: boolean | undefined,
): SendMessageConfiguration | undefined {
  if (!returnImmediately) {
    return undefined;
  }
  return {
    acceptedOutputModes: [],
    taskPushNotificationConfig: undefined,
    returnImmediately: true,
  };
}

export function buildUserMessage(input: SendMessageInput): Message {
  const part: Part = {
    content: { $case: "text", value: input.text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
  return {
    messageId: randomUUID(),
    contextId: input.contextId ?? "",
    taskId: input.taskId ?? "",
    // Role is a numeric ts-proto enum: the string "ROLE_USER" would serialize
    // as UNRECOGNIZED.
    role: Role.ROLE_USER,
    parts: [part],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** Translates anything thrown by the A2A client into an A2ABridgeError. */
export function toBridgeError(alias: string, operation: string, error: unknown): A2ABridgeError {
  const prefix = `A2A ${operation} on agent ${JSON.stringify(alias)} failed`;
  if (error instanceof A2AError) {
    const code = isJsonRpcError(error) ? error.envelopeCode : undefined;
    const reason = error.reason === "" ? undefined : error.reason;
    return new A2ABridgeError(`${prefix}: ${error.message}`, code, reason);
  }
  return new A2ABridgeError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}
