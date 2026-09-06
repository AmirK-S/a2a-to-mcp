#!/usr/bin/env node
/**
 * Standalone launcher for the fixture agent.
 *
 *   npx tsx fixtures/agent/cli.ts --port 41241
 *
 * `--port 0`, or no `--port` at all, binds a free port and prints it.
 */
import { startFixtureAgent } from "./index.js";

function parsePort(argv: string[]): number {
  const index = argv.indexOf("--port");
  if (index === -1) {
    return Number.parseInt(process.env.PORT ?? "", 10) || 41241;
  }
  const raw = argv[index + 1];
  const port = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port expects an integer in [0, 65535], received ${raw ?? "nothing"}`);
  }
  return port;
}

async function main(): Promise<void> {
  const agent = await startFixtureAgent({ port: parsePort(process.argv.slice(2)) });

  console.log(`[fixture-agent] listening on ${agent.url}`);
  console.log(`[fixture-agent] agent card: ${agent.cardUrl}`);
  console.log(`[fixture-agent] JSON-RPC:   ${agent.url}/a2a`);
  console.log(
    "[fixture-agent] commands: echo:, task:, ask:, slow:, reject, fail, auth, data, file, " +
      "image, vanish, error: <-32001..-32009>",
  );
  console.log("[fixture-agent] press Ctrl+C to stop");

  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void agent.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error("[fixture-agent] failed to start:", error);
  process.exitCode = 1;
});
