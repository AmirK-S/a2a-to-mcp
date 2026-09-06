/**
 * Deterministic `AgentExecutor` for the fixture agent. No language model,
 * no clock-dependent branching: the same input always produces the same
 * sequence of events.
 */
import { randomUUID } from "node:crypto";

import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";

import {
  UNKNOWN_COMMAND_REPLY,
  parseCommand,
  parseSlowMillis,
  reverseText,
} from "./commands.js";

/** A valid 1x1 RGBA PNG, 70 bytes, every chunk CRC correct. */
export const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const REJECT_MESSAGE = "This agent declines the request.";
const FAIL_MESSAGE = "Simulated failure.";
const AUTH_MESSAGE =
  "Authorization needed: complete it out of band at https://example.invalid/authorize";
const WORKING_MESSAGE = "Working on it.";

/** How often the `slow:` wait checks for a cancellation request. */
const CANCEL_POLL_MS = 20;

function textPart(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function dataPart(value: Record<string, unknown>): Part {
  return {
    content: { $case: "data", value },
    metadata: undefined,
    filename: "",
    mediaType: "application/json",
  };
}

function urlPart(value: string, filename: string, mediaType: string): Part {
  return {
    content: { $case: "url", value },
    metadata: undefined,
    filename,
    mediaType,
  };
}

function rawPart(value: Buffer, filename: string, mediaType: string): Part {
  return {
    content: { $case: "raw", value },
    metadata: undefined,
    filename,
    mediaType,
  };
}

/** Reads the text of the first `Part` of a message, empty when absent. */
export function firstPartText(message: Message): string {
  const part = message.parts[0];
  return part?.content?.$case === "text" ? part.content.value : "";
}

function delay(millis: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, millis));
  });
}

export interface FixtureAgentExecutorOptions {
  /**
   * Makes a task unreachable in the task store, so the next `GetTask`
   * raises `TaskNotFoundError`. Used by the `vanish` command; without it
   * `vanish` behaves like a task that stops emitting.
   */
  vanishTask?: (taskId: string) => void;
}

export class FixtureAgentExecutor implements AgentExecutor {
  /** Task ids for which `CancelTask` has been received. */
  private readonly canceledTasks = new Set<string>();

  /**
   * Question asked by `ask:`, keyed by the task waiting for the answer. The
   * context is kept alongside it so a cancellation arriving while the task is
   * parked can publish a terminal event without a running turn.
   */
  private readonly pendingQuestions = new Map<
    string,
    { question: string; contextId: string }
  >();

  private readonly vanishTask: (taskId: string) => void;

  constructor(options: FixtureAgentExecutorOptions = {}) {
    this.vanishTask = options.vanishTask ?? (() => undefined);
  }

  public cancelTask = async (
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> => {
    this.canceledTasks.add(taskId);
    // A task parked in `INPUT_REQUIRED` has no running turn to notice the
    // cancellation, and `DefaultRequestHandler` waits on the event bus for a
    // terminal event before it answers `CancelTask`. The parked turn is over,
    // so the terminal event is published here instead.
    const pending = this.pendingQuestions.get(taskId);
    if (pending !== undefined) {
      this.pendingQuestions.delete(taskId);
      this.canceledTasks.delete(taskId);
      eventBus.publish(
        this.statusEvent(
          taskId,
          pending.contextId,
          TaskState.TASK_STATE_CANCELED,
        ),
      );
    }
  };

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const userMessage = requestContext.userMessage;
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    const text = firstPartText(userMessage);

    // A follow-up turn answering a question left by `ask:` is matched on
    // the taskId, so the whole text is taken as the answer rather than
    // being parsed as a command.
    const pending = this.pendingQuestions.get(taskId);
    if (requestContext.task && pending !== undefined) {
      this.pendingQuestions.delete(taskId);
      eventBus.publish(AgentEvent.task(requestContext.task));
      eventBus.publish(
        this.artifactEvent(taskId, contextId, "result", [
          textPart(`${pending.question} = ${text.trim()}`),
        ]),
      );
      eventBus.publish(
        this.statusEvent(taskId, contextId, TaskState.TASK_STATE_COMPLETED),
      );
      return;
    }

    const { name, argument } = parseCommand(text);

    if (name === undefined) {
      eventBus.publish(
        AgentEvent.message(this.agentMessage(contextId, UNKNOWN_COMMAND_REPLY)),
      );
      return;
    }

    if (name === "echo") {
      eventBus.publish(
        AgentEvent.message(this.agentMessage(contextId, argument)),
      );
      return;
    }

    // Every remaining command produces a Task, and every turn must open
    // with a `task` or `message` event.
    eventBus.publish(
      AgentEvent.task(this.taskSnapshot(requestContext, taskId, contextId)),
    );

    switch (name) {
      case "task":
        this.runTaskCommand(eventBus, taskId, contextId, argument);
        return;
      case "ask":
        this.pendingQuestions.set(taskId, { question: argument, contextId });
        eventBus.publish(
          this.statusEvent(
            taskId,
            contextId,
            TaskState.TASK_STATE_INPUT_REQUIRED,
            `What value should I use for ${argument}?`,
          ),
        );
        return;
      case "slow":
        await this.runSlowCommand(
          eventBus,
          taskId,
          contextId,
          parseSlowMillis(argument),
        );
        return;
      case "reject":
        eventBus.publish(
          this.statusEvent(
            taskId,
            contextId,
            TaskState.TASK_STATE_REJECTED,
            REJECT_MESSAGE,
          ),
        );
        return;
      case "fail":
        eventBus.publish(
          this.statusEvent(
            taskId,
            contextId,
            TaskState.TASK_STATE_FAILED,
            FAIL_MESSAGE,
          ),
        );
        return;
      case "auth":
        eventBus.publish(
          this.statusEvent(
            taskId,
            contextId,
            TaskState.TASK_STATE_AUTH_REQUIRED,
            AUTH_MESSAGE,
          ),
        );
        return;
      case "data":
        this.completeWithPart(
          eventBus,
          taskId,
          contextId,
          "data",
          dataPart({ answer: 42, echo: argument }),
        );
        return;
      case "file":
        this.completeWithPart(
          eventBus,
          taskId,
          contextId,
          "file",
          urlPart(
            "https://example.invalid/files/report.pdf",
            "report.pdf",
            "application/pdf",
          ),
        );
        return;
      case "vanish":
        this.runVanishCommand(eventBus, taskId, contextId);
        return;
      case "image":
        this.completeWithPart(
          eventBus,
          taskId,
          contextId,
          "image",
          rawPart(
            Buffer.from(PIXEL_PNG_BASE64, "base64"),
            "pixel.png",
            "image/png",
          ),
        );
        return;
      default:
        // `echo` returns above; this branch is unreachable and exists so
        // adding a command without handling it fails to compile.
        return assertUnreachableCommand(name);
    }
  }

  /** SUBMITTED, WORKING (a message, so the history holds two), artifact, COMPLETED. */
  private runTaskCommand(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    argument: string,
  ): void {
    eventBus.publish(
      this.statusEvent(
        taskId,
        contextId,
        TaskState.TASK_STATE_WORKING,
        WORKING_MESSAGE,
      ),
    );
    eventBus.publish(
      this.artifactEvent(taskId, contextId, "result", [
        textPart(reverseText(argument)),
      ]),
    );
    eventBus.publish(
      this.statusEvent(taskId, contextId, TaskState.TASK_STATE_COMPLETED),
    );
  }

  /**
   * Opens a task, moves it to WORKING, then makes it unreachable and stops
   * emitting without ever reaching a terminal state. The stream closes when
   * `execute` returns, and the next `GetTask` raises `TaskNotFoundError`
   * (`-32001`): the one case where a bridge can no longer serve a task it
   * has already handed out.
   */
  private runVanishCommand(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
  ): void {
    eventBus.publish(
      this.statusEvent(
        taskId,
        contextId,
        TaskState.TASK_STATE_WORKING,
        WORKING_MESSAGE,
      ),
    );
    this.vanishTask(taskId);
  }

  /** Holds the task in WORKING, checking for cancellation at every tick. */
  private async runSlowCommand(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    durationMillis: number,
  ): Promise<void> {
    eventBus.publish(
      this.statusEvent(
        taskId,
        contextId,
        TaskState.TASK_STATE_WORKING,
        WORKING_MESSAGE,
      ),
    );
    try {
      const deadline = Date.now() + durationMillis;
      while (Date.now() < deadline && !this.canceledTasks.has(taskId)) {
        await delay(Math.min(CANCEL_POLL_MS, deadline - Date.now()));
      }
      const state = this.canceledTasks.has(taskId)
        ? TaskState.TASK_STATE_CANCELED
        : TaskState.TASK_STATE_COMPLETED;
      eventBus.publish(this.statusEvent(taskId, contextId, state));
    } finally {
      this.canceledTasks.delete(taskId);
    }
  }

  private completeWithPart(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    artifactName: string,
    part: Part,
  ): void {
    eventBus.publish(
      this.artifactEvent(taskId, contextId, artifactName, [part]),
    );
    eventBus.publish(
      this.statusEvent(taskId, contextId, TaskState.TASK_STATE_COMPLETED),
    );
  }

  private taskSnapshot(
    requestContext: RequestContext,
    taskId: string,
    contextId: string,
  ): Task {
    return (
      requestContext.task ?? {
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [requestContext.userMessage],
        metadata: undefined,
      }
    );
  }

  private agentMessage(contextId: string, text: string): Message {
    return {
      messageId: randomUUID(),
      contextId,
      taskId: "",
      role: Role.ROLE_AGENT,
      parts: [textPart(text)],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
  }

  private statusEvent(
    taskId: string,
    contextId: string,
    state: TaskState,
    text?: string,
  ): ReturnType<typeof AgentEvent.statusUpdate> {
    const message: Message | undefined =
      text === undefined
        ? undefined
        : {
            messageId: randomUUID(),
            contextId,
            taskId,
            role: Role.ROLE_AGENT,
            parts: [textPart(text)],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          };
    const event: TaskStatusUpdateEvent = {
      taskId,
      contextId,
      status: {
        state,
        message,
        timestamp: new Date().toISOString(),
      },
      metadata: undefined,
    };
    return AgentEvent.statusUpdate(event);
  }

  private artifactEvent(
    taskId: string,
    contextId: string,
    name: string,
    parts: Part[],
  ): ReturnType<typeof AgentEvent.artifactUpdate> {
    const artifact: Artifact = {
      artifactId: randomUUID(),
      name,
      description: "",
      parts,
      metadata: undefined,
      extensions: [],
    };
    const event: TaskArtifactUpdateEvent = {
      taskId,
      contextId,
      artifact,
      append: false,
      lastChunk: true,
      metadata: undefined,
    };
    return AgentEvent.artifactUpdate(event);
  }
}

function assertUnreachableCommand(value: never): never {
  throw new Error(`Unhandled fixture command: ${String(value)}`);
}
