/**
 * Bridge configuration: the aliases of the A2A agents exposed as MCP tools,
 * and where their agent card is fetched from.
 *
 * Validation is written by hand rather than with a schema library, because the
 * error messages have to name the offending field in dotted notation
 * (agents.a.cardUrl) and that reads better as explicit checks.
 */
import { readFile } from "node:fs/promises";

/** Default lifetime of a handle: fifteen minutes. */
export const DEFAULT_HANDLE_TTL_MS = 15 * 60_000;

/** Default port of the MCP HTTP server. */
export const DEFAULT_PORT = 8931;

/** Default bind address: loopback only. */
export const DEFAULT_HOST = "127.0.0.1";

/** Path of the agent card, relative to the agent base URL (A2A v1.0.1). */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/** An alias must be usable inside an MCP tool name. */
const ALIAS_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_PORT = 65_535;

/** One A2A agent, resolved to the URL of its agent card. */
export interface AgentConfig {
  cardUrl: string;
}

export interface BridgeConfig {
  agents: Record<string, AgentConfig>;
  handleTtlMs: number;
  port: number;
  host: string;
  /** Extra hostnames accepted in the Host header, without port. Loopback is always accepted. */
  allowedHosts: string[];
}

/** Raised when the configuration is unusable. Names the offending field. */
export class ConfigError extends Error {
  /** Dotted path of the field at fault, when there is one. */
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(field === undefined ? message : `${field}: ${message}`);
    this.name = "ConfigError";
    this.field = field;
  }
}

/** Validates a parsed configuration object and applies the defaults. */
export function parseConfig(raw: unknown): BridgeConfig {
  const root = asObject(raw, "config");

  return {
    agents: parseAgents(root["agents"]),
    handleTtlMs: parsePositiveInteger(root["handleTtlMs"], "handleTtlMs", DEFAULT_HANDLE_TTL_MS),
    port: parsePort(root["port"]),
    host: parseHost(root["host"]),
    allowedHosts: parseAllowedHosts(root["allowedHosts"]),
  };
}

const HOSTNAME = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)$/;

function parseAllowedHosts(raw: unknown): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError(`expected an array of hostnames, received ${describe(raw)}`, "allowedHosts");
  }
  return raw.map((entry, index) => {
    const field = `allowedHosts[${index}]`;
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigError(`expected a non-empty hostname, received ${describe(entry)}`, field);
    }
    if (!HOSTNAME.test(entry)) {
      throw new ConfigError(
        `expected a bare hostname without scheme, path or port, received ${JSON.stringify(entry)}`,
        field,
      );
    }
    return entry;
  });
}

/** Reads a JSON configuration file and validates it. */
export async function loadConfig(path: string): Promise<BridgeConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `cannot read the configuration file ${path}: ${messageOf(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${messageOf(error)}`);
  }

  return parseConfig(parsed);
}

function parseAgents(raw: unknown): Record<string, AgentConfig> {
  if (raw === undefined) {
    throw new ConfigError("at least one agent must be declared", "agents");
  }
  const entries = asObject(raw, "agents");
  const aliases = Object.keys(entries);
  if (aliases.length === 0) {
    throw new ConfigError("at least one agent must be declared", "agents");
  }

  const agents: Record<string, AgentConfig> = {};
  for (const alias of aliases) {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new ConfigError(
        `${JSON.stringify(alias)} is not a valid agent alias. ` +
          "Use 1 to 64 characters among letters, digits, underscore and hyphen, " +
          "so the alias fits inside an MCP tool name.",
        "agents",
      );
    }
    agents[alias] = parseAgent(entries[alias], `agents.${alias}`);
  }
  return agents;
}

function parseAgent(raw: unknown, path: string): AgentConfig {
  const entry = asObject(raw, path);
  const cardUrl = entry["cardUrl"];
  const url = entry["url"];

  if (cardUrl !== undefined && url !== undefined) {
    throw new ConfigError(
      "declare either cardUrl, the address of the agent card, or url, the agent base URL, but not both",
      path,
    );
  }
  if (cardUrl !== undefined) {
    return { cardUrl: parseHttpUrl(cardUrl, `${path}.cardUrl`) };
  }
  if (url !== undefined) {
    const base = parseHttpUrl(url, `${path}.url`);
    return { cardUrl: base.replace(/\/+$/, "") + AGENT_CARD_PATH };
  }
  throw new ConfigError(
    "declare either cardUrl, the address of the agent card, or url, the agent base URL",
    path,
  );
}

function parseHttpUrl(raw: unknown, path: string): string {
  if (typeof raw !== "string" || raw === "") {
    throw new ConfigError(`expected a non-empty URL string, received ${describe(raw)}`, path);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${JSON.stringify(raw)} is not a valid URL`, path);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `${JSON.stringify(raw)} must use the http or https scheme, not ${parsed.protocol.replace(":", "")}`,
      path,
    );
  }
  return raw;
}

function parsePositiveInteger(raw: unknown, path: string, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new ConfigError(
      `expected a strictly positive integer number of milliseconds, received ${describe(raw)}`,
      path,
    );
  }
  return raw;
}

function parsePort(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_PORT) {
    throw new ConfigError(
      `expected an integer TCP port between 1 and ${MAX_PORT}, received ${describe(raw)}`,
      "port",
    );
  }
  return raw;
}

function parseHost(raw: unknown): string {
  if (raw === undefined) {
    return DEFAULT_HOST;
  }
  if (typeof raw !== "string" || raw === "") {
    throw new ConfigError(`expected a non-empty host string, received ${describe(raw)}`, "host");
  }
  return raw;
}

function asObject(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`expected an object, received ${describe(raw)}`, path);
  }
  return raw as Record<string, unknown>;
}

function describe(value: unknown): string {
  if (value === undefined) {
    return "nothing";
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
