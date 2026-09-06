/**
 * Command grammar of the fixture agent.
 *
 * The behavior is dictated by the prefix of the text carried by the first
 * `Part` of the user message, matched case-insensitively. The separator
 * between the command and its argument is an optional colon plus optional
 * whitespace, so `data ping`, `data: ping` and `DATA:ping` are the same
 * request.
 */
import {
  A2AError,
  ContentTypeNotSupportedError,
  ExtendedAgentCardNotConfiguredError,
  ExtensionSupportRequiredError,
  InvalidAgentResponseError,
  PushNotificationNotSupportedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
  VersionNotSupportedError,
} from "@a2a-js/sdk/errors";

/** Every command the fixture agent recognizes. */
export const COMMAND_NAMES = [
  "echo",
  "task",
  "ask",
  "slow",
  "reject",
  "fail",
  "auth",
  "data",
  "file",
  "image",
  "vanish",
  "error",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

const KNOWN = new Set<string>(COMMAND_NAMES);

const COMMAND_PATTERN = /^([A-Za-z-]+)\s*:?\s*([\s\S]*)$/;

/**
 * Reply sent for any text that does not start with a known command.
 *
 * `vanish` and `error:` are deliberately absent from this list: the exact
 * wording is pinned by `test/integration/fixture-agent.test.ts:227`, a frozen
 * test. Both commands are listed on the agent card (skill `outcomes`) and in
 * the standalone launcher instead.
 */
export const UNKNOWN_COMMAND_REPLY =
  "Unknown command. Try echo:, task:, ask:, slow:, reject, fail, auth, data, file, image.";

/** Upper bound, in milliseconds, on the wait requested by `slow:`. */
export const MAX_SLOW_MS = 10_000;

/**
 * The nine typed A2A errors of specification section 5.4, by JSON-RPC code.
 * These are the only values `error:` accepts. Each entry is the semantic
 * class of `@a2a-js/sdk/errors`, built with no argument so the fixture
 * raises the SDK's own standard message rather than one of its own.
 */
const A2A_ERROR_BY_CODE: Record<number, new () => A2AError> = {
  [-32_001]: TaskNotFoundError,
  [-32_002]: TaskNotCancelableError,
  [-32_003]: PushNotificationNotSupportedError,
  [-32_004]: UnsupportedOperationError,
  [-32_005]: ContentTypeNotSupportedError,
  [-32_006]: InvalidAgentResponseError,
  [-32_007]: ExtendedAgentCardNotConfiguredError,
  [-32_008]: ExtensionSupportRequiredError,
  [-32_009]: VersionNotSupportedError,
};

export interface ParsedCommand {
  /** `undefined` when the text matches no known command. */
  name: CommandName | undefined;
  /** Everything after the command and its separator, trimmed. */
  argument: string;
}

/** Splits a user text into a command name and its argument. */
export function parseCommand(text: string): ParsedCommand {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) {
    return { name: undefined, argument: "" };
  }
  const name = (match[1] ?? "").toLowerCase();
  if (!KNOWN.has(name)) {
    return { name: undefined, argument: "" };
  }
  return { name: name as CommandName, argument: (match[2] ?? "").trim() };
}

/**
 * Parses the `slow:` argument, clamped to `[0, MAX_SLOW_MS]`. A missing or
 * unparsable argument means "do not wait".
 */
export function parseSlowMillis(argument: string): number {
  const parsed = Number.parseInt(argument, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(parsed, MAX_SLOW_MS);
}

/**
 * Builds the typed A2A error the `error:` argument names, or `undefined`
 * for anything that is not one of the nine codes: a malformed argument
 * then falls through to the normal reply instead of silently raising the
 * wrong error.
 */
export function a2aErrorForCode(argument: string): A2AError | undefined {
  const code = Number.parseInt(argument.trim(), 10);
  const errorClass = Number.isFinite(code) ? A2A_ERROR_BY_CODE[code] : undefined;
  return errorClass === undefined ? undefined : new errorClass();
}

/** Reverses a string by code point, not by UTF-16 code unit. */
export function reverseText(text: string): string {
  return [...text].reverse().join("");
}
