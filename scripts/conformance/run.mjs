#!/usr/bin/env node
/**
 * Replays the official MCP conformance suite against the bridge.
 *
 *   node scripts/conformance/run.mjs [--skip-build]
 *
 * The script owns the whole loop, so a run is one command and not a checklist:
 * it builds the bridge, starts the fixture A2A agent, writes a throwaway
 * bridge configuration, starts the bridge on a free port, waits until
 * `server/discover` answers, then runs the pinned suite twice, once per
 * requirement set (D03): `2026-07-28` for the stateless wire and `2025-11-25`
 * for the legacy one. Results land in `conformance/results/<revision>/`, one
 * directory per scenario with its `checks.json`, plus a `run.json` recording
 * the command, the versions, the totals and the scoring of every scenario.
 *
 * Exit code: 0 if and only if every scored failure is covered by
 * `conformance/baseline.yml`. That is the suite's own rule, not ours: a
 * baselined failure exits 0, an unbaselined one exits 1, and a baseline entry
 * that now passes exits 1 as a stale entry. A baselined failure is still a
 * failure against a requirement set, which is why the baseline carries a reason
 * and a category for every line.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned by D03. An alpha, because no stable release knows `--requirements`. */
const SUITE = "@modelcontextprotocol/conformance@0.2.0-alpha.11";

/** One run per requirement set: the two wires are two different protocols. */
const REVISIONS = ["2026-07-28", "2025-11-25"];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const RESULTS_ROOT = join(REPO_ROOT, "conformance", "results");
const BASELINE = join(REPO_ROOT, "conformance", "baseline.yml");

const IS_WINDOWS = process.platform === "win32";
const NPX = IS_WINDOWS ? "npx.cmd" : "npx";
const NPM = IS_WINDOWS ? "npm.cmd" : "npm";

function log(message) {
  process.stdout.write(`[conformance] ${message}\n`);
}

/** Binds port 0 to learn a port the operating system considers free. */
function freePort() {
  return new Promise((ok, ko) => {
    const probe = createServer();
    probe.on("error", ko);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

/** Runs a command to completion, inheriting the console. */
function run(command, args, options = {}) {
  return new Promise((ok, ko) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      ...options,
    });
    child.on("error", ko);
    child.on("close", (code) => ok(code ?? 1));
  });
}

/**
 * Runs a command to completion, echoing its output and keeping a copy. The
 * copy becomes `run.log` and the totals line of `run.json`.
 */
function runCaptured(command, args) {
  return new Promise((ok, ko) => {
    const child = spawn(command, args, { cwd: REPO_ROOT });
    let output = "";
    const collect = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", ko);
    child.on("close", (code) => ok({ code: code ?? 1, output }));
  });
}

/**
 * Starts a long-lived process and resolves once its output announces it is
 * ready. Output is prefixed and kept, so a startup failure is readable.
 */
function startService(name, command, args, ready, timeoutMs = 60_000) {
  return new Promise((ok, ko) => {
    const child = spawn(command, args, { cwd: REPO_ROOT });
    let output = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      ko(new Error(`${name} did not start within ${timeoutMs} ms. Output:\n${output}`));
    }, timeoutMs);

    const collect = (chunk) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split("\n")) {
        if (line.trim() !== "") process.stdout.write(`[${name}] ${line.trim()}\n`);
      }
      if (!settled && ready.test(output)) {
        settled = true;
        clearTimeout(timer);
        ok({ child, output: () => output });
      }
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ko(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ko(new Error(`${name} exited with code ${code} before it was ready. Output:\n${output}`));
    });
  });
}

/** Stops a child process and waits for it, so ports are free for the next run. */
async function stop(service) {
  if (service === undefined || service.child.exitCode !== null) return;
  await new Promise((ok) => {
    service.child.once("close", () => ok());
    service.child.kill("SIGTERM");
    setTimeout(() => {
      service.child.kill("SIGKILL");
      ok();
    }, 5_000).unref();
  });
}

/**
 * Polls `server/discover` on the stateless wire until the bridge answers.
 * That single request is the readiness probe because it is also the first
 * thing the suite does: if it answers, the run can start.
 */
async function waitForDiscover(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const body = await response.json();
      if (response.ok && body?.result?.supportedVersions !== undefined) {
        return body.result;
      }
      last = `HTTP ${response.status} ${JSON.stringify(body).slice(0, 200)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error(`server/discover never answered on ${url}. Last attempt: ${last}`);
}

/** Pulls the two totals out of the runner's summary line. */
function parseTotals(output) {
  const totals = { passed: null, failed: null };
  const line = output.match(/^Total:\s*(\d+)\s*passed,\s*(\d+)\s*failed/m);
  if (line !== null) {
    totals.passed = Number(line[1]);
    totals.failed = Number(line[2]);
  }
  return totals;
}

/**
 * Asks the suite which scenarios of a requirement set are run and reported but
 * never scored, and why.
 *
 * The scoring is written nowhere else: `checks.json` does not carry it, and the
 * runner prints its own "Not scored for ..." section only when no
 * `--expected-failures` file is given, which is exactly the case we never run
 * in. So the frozen requirement set is queried directly. Its output lists one
 * heading per reason:
 *
 *   Run and reported, but never scored:
 *     pending (2):
 *       - json-schema-2020-12 [server]
 */
async function listNotScored(revision) {
  const child = spawn(NPX, ["-y", SUITE, "list", "--requirements", revision], { cwd: REPO_ROOT });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  const code = await new Promise((ok) => child.on("close", (value) => ok(value ?? 1)));
  if (code !== 0) {
    log(`could not list the scoring of ${revision}, the report will call every scenario scored`);
    return {};
  }

  const scoring = {};
  let reason = null;
  let started = false;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r$/, "");
    if (/^Run and reported, but never scored:/.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    const heading = line.match(/^\s{2}(\S+)\s+\(\d+\):\s*$/);
    if (heading !== null) {
      reason = heading[1];
      continue;
    }
    const entry = line.match(/^\s+-\s+(\S+)\s+\[(server|client)\]\s*$/);
    if (entry !== null && entry[2] === "server" && reason !== null) scoring[entry[1]] = reason;
  }
  return scoring;
}

/** Reads the version of a package the way npm reports it, for the record. */
async function versionOf(spec) {
  const child = spawn(NPX, ["-y", spec, "--version"], { cwd: REPO_ROOT });
  let out = "";
  child.stdout.on("data", (c) => (out += c.toString()));
  child.stderr.on("data", (c) => (out += c.toString()));
  const code = await new Promise((ok) => child.on("close", (c) => ok(c ?? 1)));
  const version = out.match(/\d+\.\d+\.\d+[^\s]*/);
  return code === 0 && version !== null ? version[0] : "unknown";
}

async function main() {
  const argv = process.argv.slice(2);
  const skipBuild = argv.includes("--skip-build");
  const unknown = argv.filter((flag) => flag !== "--skip-build");
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown argument ${JSON.stringify(unknown[0])}.\n\nUsage: node scripts/conformance/run.mjs [--skip-build]\n`,
    );
    process.exit(2);
  }

  if (!skipBuild) {
    log("building the bridge");
    const code = await run(NPM, ["run", "build"]);
    if (code !== 0) {
      process.stderr.write("[conformance] build failed\n");
      process.exit(code);
    }
  }
  if (!existsSync(join(REPO_ROOT, "dist", "cli.js"))) {
    process.stderr.write(
      "[conformance] dist/cli.js is missing. Run without --skip-build.\n",
    );
    process.exit(2);
  }

  const hasBaseline = existsSync(BASELINE);
  if (!hasBaseline) {
    log(`no baseline at ${BASELINE}, every scored failure will count`);
  }

  const suiteVersion = await versionOf(SUITE);
  const agentPort = await freePort();
  const bridgePort = await freePort();
  const bridgeUrl = `http://127.0.0.1:${bridgePort}/mcp`;

  const workdir = await mkdtemp(join(tmpdir(), "a2a-to-mcp-conformance-"));
  const configPath = join(workdir, "agents.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ agents: { fixture: { url: `http://127.0.0.1:${agentPort}` } } }, null, 2)}\n`,
  );

  let agent;
  let bridge;
  const runs = [];

  try {
    log(`starting the fixture A2A agent on port ${agentPort}`);
    agent = await startService(
      "fixture-agent",
      NPX,
      ["tsx", "fixtures/agent/cli.ts", "--port", String(agentPort)],
      /\[fixture-agent\] listening on/,
    );

    log(`starting the bridge on port ${bridgePort}`);
    bridge = await startService(
      "bridge",
      process.execPath,
      ["dist/cli.js", "--config", configPath, "--port", String(bridgePort)],
      /listening on/,
    );

    const discover = await waitForDiscover(bridgeUrl);
    log(`server/discover answered: supportedVersions=${JSON.stringify(discover.supportedVersions)}`);

    for (const revision of REVISIONS) {
      const outputDir = join(RESULTS_ROOT, revision);
      await rm(outputDir, { recursive: true, force: true });
      await mkdir(outputDir, { recursive: true });

      const args = [
        "-y",
        SUITE,
        "server",
        "--url",
        bridgeUrl,
        "--requirements",
        revision,
        "-o",
        outputDir,
      ];
      if (hasBaseline) args.push("--expected-failures", BASELINE);

      // The command written to run.json is the one a reader can retype: repo
      // relative paths, and the port left as a placeholder since it is picked
      // free at every run.
      const portable =
        `npx -y ${SUITE} server --url http://127.0.0.1:<port>/mcp ` +
        `--requirements ${revision} -o conformance/results/${revision}` +
        (hasBaseline ? " --expected-failures conformance/baseline.yml" : "");

      log(`running requirements ${revision}`);
      const started = new Date().toISOString();
      const { code, output } = await runCaptured(NPX, args);
      const totals = parseTotals(output);
      const scoring = await listNotScored(revision);

      await writeFile(join(outputDir, "run.log"), output);
      const meta = {
        revision,
        exitCode: code,
        startedAt: started,
        finishedAt: new Date().toISOString(),
        command: portable,
        suiteVersion,
        nodeVersion: process.version,
        bridgeUrl,
        baseline: hasBaseline ? "conformance/baseline.yml" : null,
        totals,
        /** Scenario name to the reason it was not scored. Absent means scored. */
        notScored: scoring,
      };
      await writeFile(join(outputDir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);
      runs.push(meta);
      log(`requirements ${revision} finished with exit code ${code}`);
    }
  } finally {
    await stop(bridge);
    await stop(agent);
    await rm(workdir, { recursive: true, force: true });
  }

  log("writing conformance/REPORT.md");
  const reportCode = await run(process.execPath, [join(SCRIPT_DIR, "summarize.mjs")]);
  if (reportCode !== 0) process.exit(reportCode);

  const failed = runs.filter((entry) => entry.exitCode !== 0);
  if (failed.length > 0) {
    process.stderr.write(
      `[conformance] not clean: ${failed.map((entry) => `${entry.revision} exited ${entry.exitCode}`).join(", ")}. ` +
        "See the unbaselined failures in conformance/REPORT.md.\n",
    );
    process.exit(1);
  }
  log("every scored failure is covered by conformance/baseline.yml");
}

main().catch((error) => {
  process.stderr.write(`[conformance] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
