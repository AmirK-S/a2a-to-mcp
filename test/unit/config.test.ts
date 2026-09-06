/**
 * Configuration file: aliases of A2A agents and their agent card URLs.
 * BRIEF.md section 5.1: "Un fichier de configuration declarant les alias
 * d'agent et leurs URL de carte."
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigError, DEFAULT_HANDLE_TTL_MS, loadConfig, parseConfig } from "../../src/config.js";

describe("parseConfig", () => {
  it("accepts a minimal config with one alias and applies defaults", () => {
    const config = parseConfig({
      agents: { hello: { cardUrl: "http://localhost:9999/.well-known/agent-card.json" } },
    });
    expect(config.agents["hello"]?.cardUrl).toBe("http://localhost:9999/.well-known/agent-card.json");
    expect(config.handleTtlMs).toBe(DEFAULT_HANDLE_TTL_MS);
    expect(config.port).toBe(8931);
    expect(config.host).toBe("127.0.0.1");
  });

  it("defaults the handle lifetime to fifteen minutes", () => {
    expect(DEFAULT_HANDLE_TTL_MS).toBe(15 * 60_000);
  });

  it("keeps explicit port, host and ttl", () => {
    const config = parseConfig({
      agents: { a: { cardUrl: "http://a.test/.well-known/agent-card.json" } },
      port: 1234,
      host: "0.0.0.0",
      handleTtlMs: 5_000,
    });
    expect(config.port).toBe(1234);
    expect(config.host).toBe("0.0.0.0");
    expect(config.handleTtlMs).toBe(5_000);
  });

  it("accepts an agent base URL and derives the well-known card URL", () => {
    const config = parseConfig({ agents: { a: { url: "http://a.test:1234" } } });
    expect(config.agents["a"]?.cardUrl).toBe("http://a.test:1234/.well-known/agent-card.json");
  });

  it("rejects an empty agents map", () => {
    expect(() => parseConfig({ agents: {} })).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(ConfigError);
  });

  it("rejects an alias that would not be valid inside an MCP tool name", () => {
    for (const alias of ["with space", "slash/name", "", "a".repeat(65), "accenté"]) {
      expect(() =>
        parseConfig({ agents: { [alias]: { cardUrl: "http://a.test/card.json" } } }),
      ).toThrow(ConfigError);
    }
  });

  it("accepts aliases with letters, digits, underscore and hyphen", () => {
    const config = parseConfig({
      agents: {
        "hello-world_2": { cardUrl: "http://a.test/card.json" },
        Upper: { cardUrl: "http://b.test/card.json" },
      },
    });
    expect(Object.keys(config.agents).sort()).toEqual(["Upper", "hello-world_2"]);
  });

  it("rejects a card URL that is not http or https", () => {
    expect(() => parseConfig({ agents: { a: { cardUrl: "ftp://a.test/card.json" } } })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ agents: { a: { cardUrl: "not a url" } } })).toThrow(ConfigError);
  });

  it("rejects an agent entry with neither cardUrl nor url, or with both", () => {
    expect(() => parseConfig({ agents: { a: {} } })).toThrow(ConfigError);
    expect(() =>
      parseConfig({ agents: { a: { url: "http://a.test", cardUrl: "http://a.test/c.json" } } }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-positive ttl or port", () => {
    const agents = { a: { cardUrl: "http://a.test/card.json" } };
    expect(() => parseConfig({ agents, handleTtlMs: 0 })).toThrow(ConfigError);
    expect(() => parseConfig({ agents, port: -1 })).toThrow(ConfigError);
    expect(() => parseConfig({ agents, port: 70_000 })).toThrow(ConfigError);
  });

  it("defaults allowedHosts to an empty list and keeps a list of hostnames", () => {
    const agents = { a: { cardUrl: "http://a.test/card.json" } };
    expect(parseConfig({ agents }).allowedHosts).toEqual([]);
    expect(parseConfig({ agents, allowedHosts: ["bridge.internal", "10.0.0.5"] }).allowedHosts).toEqual([
      "bridge.internal",
      "10.0.0.5",
    ]);
  });

  it("rejects allowedHosts entries that are not bare hostnames", () => {
    const agents = { a: { cardUrl: "http://a.test/card.json" } };
    expect(() => parseConfig({ agents, allowedHosts: "bridge.internal" })).toThrow(ConfigError);
    expect(() => parseConfig({ agents, allowedHosts: [""] })).toThrow(ConfigError);
    expect(() => parseConfig({ agents, allowedHosts: ["http://bridge.internal"] })).toThrow(ConfigError);
    expect(() => parseConfig({ agents, allowedHosts: ["bridge.internal:8931"] })).toThrow(/allowedHosts\[0\]/);
  });

  it("names the offending field in the error message", () => {
    let message = "";
    try {
      parseConfig({ agents: { a: { cardUrl: "ftp://x" } } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("agents.a.cardUrl");
  });
});

describe("loadConfig", () => {
  it("reads and parses a JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a2a-to-mcp-"));
    const path = join(dir, "a2a-to-mcp.json");
    await writeFile(
      path,
      JSON.stringify({ agents: { hello: { url: "http://localhost:9999" } }, port: 4321 }),
    );
    const config = await loadConfig(path);
    expect(config.port).toBe(4321);
    expect(config.agents["hello"]?.cardUrl).toBe("http://localhost:9999/.well-known/agent-card.json");
  });

  it("reports a missing file as a ConfigError naming the path", async () => {
    await expect(loadConfig("/nonexistent/a2a-to-mcp.json")).rejects.toThrow(ConfigError);
    await expect(loadConfig("/nonexistent/a2a-to-mcp.json")).rejects.toThrow(/nonexistent/);
  });

  it("reports invalid JSON as a ConfigError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a2a-to-mcp-"));
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json");
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });
});
