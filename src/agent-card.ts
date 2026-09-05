/**
 * Agent card resolution, one entry per configured alias.
 *
 * The bridge fetches the card itself rather than letting the A2A client do it
 * through ClientFactory.createFromUrl, for three reasons: the card is the
 * structuredContent of a2a_discover and must reach the client unmodified; the
 * bridge picks the JSON-RPC interface explicitly instead of taking the first
 * entry of supportedInterfaces (which is what the SDK does by default); and a
 * card fetched once has to be reused across tool calls, so the cache and its
 * TTL live here.
 *
 * Validation is deliberately minimal. The bridge refuses a payload that could
 * not possibly be an A2A v1.0 card, and passes everything else through: a card
 * the bridge does not understand is still useful to the model reading it.
 */
import type { AgentCard, AgentInterface } from "@a2a-js/sdk";

/** Default lifetime of a cached agent card: one minute. */
export const DEFAULT_CARD_TTL_MS = 60_000;

/** The A2A protocol version the bridge speaks. */
export const A2A_VERSION = "1.0";

/** The protocolBinding value of the JSON-RPC interface, compared case-insensitively. */
const JSONRPC_BINDING = "jsonrpc";

/** Raised when a card cannot be fetched, parsed or validated. Names the URL. */
export class AgentCardError extends Error {
  readonly alias: string;
  readonly cardUrl: string;

  constructor(alias: string, cardUrl: string, reason: string) {
    super(`Cannot use the agent card of ${JSON.stringify(alias)} at ${cardUrl}: ${reason}`);
    this.name = "AgentCardError";
    this.alias = alias;
    this.cardUrl = cardUrl;
  }
}

/** Raised when a tool names an alias that is not configured. */
export class UnknownAgentError extends Error {
  readonly alias: string;

  constructor(alias: string, known: readonly string[]) {
    super(
      `Unknown agent alias ${JSON.stringify(alias)}. ` +
        `The configured agents are: ${known.map((name) => JSON.stringify(name)).join(", ")}.`,
    );
    this.name = "UnknownAgentError";
    this.alias = alias;
  }
}

/** One resolved agent: the raw card, its URL, and the interface the bridge calls. */
export interface ResolvedAgent {
  alias: string;
  cardUrl: string;
  /** The card exactly as the agent served it, only validated. */
  card: AgentCard;
  /** The JSON-RPC interface the bridge talks to. */
  agentInterface: AgentInterface;
}

export interface AgentCardResolverOptions {
  /** Alias to card URL, from the bridge configuration. */
  agents: Record<string, { cardUrl: string }>;
  /** Lifetime of a cached card. Defaults to DEFAULT_CARD_TTL_MS. */
  ttlMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, for tests. */
  now?: () => number;
}

interface CacheEntry {
  resolved: ResolvedAgent;
  expiresAt: number;
}

export class AgentCardResolver {
  readonly #agents: Record<string, { cardUrl: string }>;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<ResolvedAgent>>();
  readonly #ttlMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #fetches = 0;

  constructor(options: AgentCardResolverOptions) {
    this.#agents = { ...options.agents };
    this.#ttlMs = options.ttlMs ?? DEFAULT_CARD_TTL_MS;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** The configured aliases, in declaration order. */
  get aliases(): string[] {
    return Object.keys(this.#agents);
  }

  /** How many times a card was actually fetched over the network. */
  get fetches(): number {
    return this.#fetches;
  }

  /** The card URL of an alias, without fetching anything. */
  cardUrlOf(alias: string): string {
    const entry = this.#agents[alias];
    if (entry === undefined) {
      throw new UnknownAgentError(alias, this.aliases);
    }
    return entry.cardUrl;
  }

  /** The card of an alias, already resolved and still fresh, if there is one. */
  peek(alias: string): ResolvedAgent | undefined {
    const cached = this.#cache.get(alias);
    if (cached === undefined || cached.expiresAt <= this.#now()) {
      return undefined;
    }
    return cached.resolved;
  }

  /** Resolves an alias, fetching the card at most once per TTL window. */
  async get(alias: string): Promise<ResolvedAgent> {
    const cardUrl = this.cardUrlOf(alias);
    const fresh = this.peek(alias);
    if (fresh !== undefined) {
      return fresh;
    }
    // Two tool calls racing on a cold cache must still fetch only once.
    const pending = this.#inFlight.get(alias);
    if (pending !== undefined) {
      return pending;
    }
    const attempt = this.#load(alias, cardUrl).finally(() => {
      this.#inFlight.delete(alias);
    });
    this.#inFlight.set(alias, attempt);
    return attempt;
  }

  /** Drops the cached card of an alias, so the next get refetches. */
  invalidate(alias: string): void {
    this.#cache.delete(alias);
  }

  async #load(alias: string, cardUrl: string): Promise<ResolvedAgent> {
    const card = await this.#fetchCard(alias, cardUrl);
    const resolved: ResolvedAgent = {
      alias,
      cardUrl,
      card,
      agentInterface: pickJsonRpcInterface(alias, cardUrl, card),
    };
    this.#cache.set(alias, { resolved, expiresAt: this.#now() + this.#ttlMs });
    return resolved;
  }

  async #fetchCard(alias: string, cardUrl: string): Promise<AgentCard> {
    let response: Response;
    try {
      response = await this.#fetch(cardUrl, {
        headers: { Accept: "application/json", "A2A-Version": A2A_VERSION },
      });
    } catch (error) {
      throw new AgentCardError(alias, cardUrl, `the request failed (${messageOf(error)})`);
    }
    this.#fetches += 1;
    if (!response.ok) {
      throw new AgentCardError(
        alias,
        cardUrl,
        `the agent answered HTTP ${response.status} ${response.statusText}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AgentCardError(alias, cardUrl, `the body is not JSON (${messageOf(error)})`);
    }
    return validateCard(alias, cardUrl, payload);
  }
}

/** Minimal structural validation of an A2A v1.0 agent card. */
export function validateCard(alias: string, cardUrl: string, payload: unknown): AgentCard {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AgentCardError(alias, cardUrl, `expected a JSON object, received ${describe(payload)}`);
  }
  const card = payload as Record<string, unknown>;
  if (typeof card["name"] !== "string" || card["name"] === "") {
    throw new AgentCardError(alias, cardUrl, "the card has no name");
  }
  const interfaces = card["supportedInterfaces"];
  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    throw new AgentCardError(
      alias,
      cardUrl,
      "supportedInterfaces must be a non-empty array. " +
        "A v0.3 card with url and preferredTransport is not an A2A v1.0 card.",
    );
  }
  if (!Array.isArray(card["skills"])) {
    throw new AgentCardError(alias, cardUrl, "skills must be an array");
  }
  return card as unknown as AgentCard;
}

/** Picks the JSON-RPC interface, preferring the one that declares A2A 1.0. */
export function pickJsonRpcInterface(
  alias: string,
  cardUrl: string,
  card: AgentCard,
): AgentInterface {
  const candidates = (card.supportedInterfaces ?? []).filter(
    (entry): entry is AgentInterface =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.url === "string" &&
      entry.url !== "" &&
      typeof entry.protocolBinding === "string" &&
      entry.protocolBinding.toLowerCase() === JSONRPC_BINDING,
  );
  const preferred =
    candidates.find((entry) => String(entry.protocolVersion ?? "").startsWith(A2A_VERSION)) ??
    candidates[0];
  if (preferred === undefined) {
    const bindings = (card.supportedInterfaces ?? [])
      .map((entry) => String((entry as { protocolBinding?: unknown }).protocolBinding))
      .join(", ");
    throw new AgentCardError(
      alias,
      cardUrl,
      `no JSONRPC interface is declared. The card offers: ${bindings || "nothing"}. ` +
        "The bridge only speaks the A2A JSON-RPC binding.",
    );
  }
  return preferred;
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : typeof value;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message !== "") {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return String(error);
}
