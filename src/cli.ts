#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   a2a-to-mcp --config ./agents.json [--port 8931] [--host 127.0.0.1]
 *
 * The configuration file names the A2A agents to expose. On startup the
 * bridge prints its URL and the .mcp.json block to paste into a client, so
 * wiring it up is a copy and not a lookup in the README.
 */
import { ConfigError, loadConfig } from "./config.js";
import { createBridge } from "./server.js";

interface CliArguments {
  configPath: string;
  port: number | undefined;
  host: string | undefined;
}

const USAGE =
  "Usage: a2a-to-mcp --config <file> [--port <number>] [--host <address>]\n" +
  "\n" +
  "  --config  JSON file declaring the A2A agents to expose, by alias.\n" +
  "  --port    TCP port to bind. Defaults to the config file, then to 8931.\n" +
  "  --host    Address to bind. Defaults to the config file, then to 127.0.0.1.\n";

export function parseArguments(argv: readonly string[]): CliArguments {
  let configPath: string | undefined;
  let port: number | undefined;
  let host: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--config":
      case "-c":
        configPath = requireValue(argv, index, flag);
        index += 1;
        break;
      case "--port":
      case "-p": {
        const raw = requireValue(argv, index, flag);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
          throw new Error(`--port expects an integer in [0, 65535], received ${JSON.stringify(raw)}`);
        }
        port = parsed;
        index += 1;
        break;
      }
      case "--host":
      case "-H":
        host = requireValue(argv, index, flag);
        index += 1;
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument ${JSON.stringify(String(flag))}.\n\n${USAGE}`);
    }
  }

  if (configPath === undefined) {
    throw new Error(`--config is required.\n\n${USAGE}`);
  }
  return { configPath, port, host };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} expects a value.`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const config = await loadConfig(args.configPath);

  const bridge = await createBridge({
    agents: config.agents,
    handleTtlMs: config.handleTtlMs,
    allowedHosts: config.allowedHosts,
  });
  const address = await bridge.listen(args.port ?? config.port, args.host ?? config.host);

  const aliases = Object.keys(config.agents);
  process.stdout.write(`a2a-to-mcp listening on ${address.url}\n`);
  process.stdout.write(`agents: ${aliases.join(", ")}\n`);
  process.stdout.write("\nPaste this into .mcp.json:\n");
  process.stdout.write(
    `${JSON.stringify(
      { mcpServers: { "a2a-to-mcp": { type: "http", url: address.url } } },
      null,
      2,
    )}\n`,
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.stdout.write("\nshutting down\n");
    void bridge.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`a2a-to-mcp: ${message}\n`);
  process.exitCode = 1;
});
