/**
 * Command grammar of the fixture agent.
 *
 * The behavior is dictated by the prefix of the text carried by the first
 * `Part` of the user message, matched case-insensitively. The separator
 * between the command and its argument is an optional colon plus optional
 * whitespace, so `data ping`, `data: ping` and `DATA:ping` are the same
 * request.
 */

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
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

const KNOWN = new Set<string>(COMMAND_NAMES);

const COMMAND_PATTERN = /^([A-Za-z-]+)\s*:?\s*([\s\S]*)$/;

/** Reply sent for any text that does not start with a known command. */
export const UNKNOWN_COMMAND_REPLY =
  "Unknown command. Try echo:, task:, ask:, slow:, reject, fail, auth, data, file, image.";

/** Upper bound, in milliseconds, on the wait requested by `slow:`. */
export const MAX_SLOW_MS = 10_000;

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

/** Reverses a string by code point, not by UTF-16 code unit. */
export function reverseText(text: string): string {
  return [...text].reverse().join("");
}
