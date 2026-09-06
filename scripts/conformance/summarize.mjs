#!/usr/bin/env node
/**
 * Turns the conformance results into one readable report.
 *
 *   node scripts/conformance/summarize.mjs
 *
 * The suite writes one directory per scenario, each holding a single
 * `checks.json`, and nothing that aggregates them: `tier-check --output json`
 * is the only built-in aggregate and it does not cover a `--requirements` run.
 * So this script reads every `checks.json` under `conformance/results/`, joins
 * them with the scoring recorded by `run.mjs` in `run.json` and with
 * `conformance/baseline.yml`, and writes `conformance/REPORT.md`.
 *
 * It reproduces the suite's own verdict rules, so the report and the exit code
 * of a run cannot drift apart:
 *  - under a requirement set the baseline judges scored scenarios only, since a
 *    not-scored scenario cannot fail the run;
 *  - a WARNING counts as a failing check for the baseline, like a FAILURE;
 *  - repeated check ids collapse to their most severe occurrence;
 *  - a baselined check that is absent or SKIPPED is tolerated, a baselined
 *    check that passes is a stale entry.
 */
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const RESULTS_ROOT = join(REPO_ROOT, "conformance", "results");
const BASELINE = join(REPO_ROOT, "conformance", "baseline.yml");
const REPORT = join(REPO_ROOT, "conformance", "REPORT.md");

/**
 * Green checks worth naming. The totals hide them: they are the checks that
 * were not a given for a bridge, and each answers a question the reader has.
 */
const HEADLINE_CHECKS = [
  {
    id: "wire-schema-valid",
    what: "every message the bridge emits validates against the JSON schema of the revision, `resultType` included",
  },
  {
    id: "sep-2575-server-implements-discover",
    what: "`server/discover` answers on the stateless wire",
  },
  {
    id: "sep-2575-discover-capabilities-match-handlers",
    what: "the capabilities announced in `server/discover` match the handlers actually mounted",
  },
  {
    id: "localhost-host-rebinding-rejected",
    what: "a foreign `Host` or `Origin` header is refused with HTTP 4xx (DNS rebinding protection)",
  },
  {
    id: "sep-2243-server-reject-invalid-headers",
    what: "SEP-2243 header validation rejects malformed `Mcp-Method` and `Mcp-Name`",
  },
  {
    id: "sep-2243-header-name-case-insensitive",
    what: "header names are matched case insensitively",
  },
  {
    id: "sep-2575-server-sends-subscription-ack",
    what: "`subscriptions/listen` is acknowledged and tagged with its subscription id",
  },
];

/** Scenarios whose green result is the headline of a whole family. */
const HEADLINE_SCENARIOS = [
  { name: "tools-list", what: "the four bridge tools are listed and well-formed" },
  { name: "server-stateless", what: "the SEP-2575 stateless wire, discover to subscriptions" },
  { name: "http-header-validation", what: "the SEP-2243 header rejections" },
  { name: "dns-rebinding-protection", what: "Host and Origin validation" },
  { name: "server-initialize", what: "the legacy initialize handshake" },
  { name: "server-session-lifecycle", what: "the legacy session lifecycle" },
];

const CATEGORIES = new Set([
  "fixture-tools-absent",
  "capability-not-declared",
  "suite-false-negative",
  "extension-not-applicable",
  "legacy-stateless-by-design",
]);

/**
 * Reads `conformance/baseline.yml`.
 *
 * The file is the format the suite expects for `--expected-failures`: an object
 * with a `server` (and optionally `client`) list, whose entries are
 * `<scenario>` or `<scenario>:<check-id>`, no space after the colon. The reason
 * and the category live in a trailing comment, `# <category> | <reason>`,
 * because the parser of the suite rejects a mapping. Reading them back here is
 * what lets the report justify every baselined line instead of listing names.
 */
async function readBaseline() {
  if (!existsSync(BASELINE)) return { entries: [], problems: ["conformance/baseline.yml is missing"] };

  const problems = [];
  const entries = [];
  let section = null;

  for (const [index, raw] of (await readFile(BASELINE, "utf8")).split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || /^\s*#/.test(line)) continue;

    const heading = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*$/);
    if (heading !== null) {
      section = heading[1];
      continue;
    }

    const item = line.match(/^\s*-\s+([^#\s]+)\s*(?:#\s*(.*))?$/);
    if (item === null) {
      problems.push(`line ${index + 1} is neither a section nor an entry: ${line.trim()}`);
      continue;
    }
    const [text, comment = ""] = [item[1], item[2]];
    const separator = comment.indexOf("|");
    const category = separator === -1 ? "" : comment.slice(0, separator).trim();
    const reason = separator === -1 ? comment.trim() : comment.slice(separator + 1).trim();
    const colon = text.indexOf(":");
    const entry = {
      section,
      raw: text,
      scenario: colon === -1 ? text : text.slice(0, colon),
      checkId: colon === -1 ? null : text.slice(colon + 1),
      category,
      reason,
      matched: false,
    };
    if (section !== "server" && section !== "client") {
      problems.push(`entry ${text} sits outside a 'server' or 'client' section`);
    }
    if (!CATEGORIES.has(entry.category)) {
      problems.push(`entry ${text} carries no known category, got ${JSON.stringify(entry.category)}`);
    }
    if (entry.reason === "") problems.push(`entry ${text} carries no reason`);
    entries.push(entry);
  }
  return { entries: entries.filter((entry) => entry.section === "server"), problems };
}

/** Most severe occurrence wins, ties go to the last, INFO is never collapsed. */
function collapse(checks) {
  const severity = (status) =>
    status === "FAILURE" ? 3 : status === "WARNING" ? 2 : status === "SUCCESS" ? 1 : 0;
  const winner = new Map();
  checks.forEach((check, index) => {
    if (check.status === "INFO") return;
    const current = winner.get(check.id);
    if (current === undefined || severity(check.status) >= severity(checks[current].status)) {
      winner.set(check.id, index);
    }
  });
  return checks.filter((check, index) => check.status === "INFO" || winner.get(check.id) === index);
}

const isFailing = (check) => check.status === "FAILURE" || check.status === "WARNING";

/** Loads one results directory: its `run.json` and every scenario's checks. */
async function readRun(revision) {
  const dir = join(RESULTS_ROOT, revision);
  const meta = existsSync(join(dir, "run.json"))
    ? JSON.parse(await readFile(join(dir, "run.json"), "utf8"))
    : { revision, notScored: {}, totals: { passed: null, failed: null } };

  const scenarios = [];
  for (const name of (await readdir(dir)).sort()) {
    const checksPath = join(dir, name, "checks.json");
    if (!existsSync(checksPath)) continue;
    const scenario = name.replace(/^(server|client)-/, "").replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, "");
    const checks = JSON.parse(await readFile(checksPath, "utf8"));
    const collapsed = collapse(checks).filter((check) => check.status !== "INFO");
    scenarios.push({
      scenario,
      directory: name,
      checks,
      collapsed,
      passed: checks.filter((check) => check.status === "SUCCESS").length,
      failed: checks.filter((check) => check.status === "FAILURE").length,
      warned: checks.filter((check) => check.status === "WARNING").length,
      skipped: checks.filter((check) => check.status === "SKIPPED").length,
      scoring: meta.notScored?.[scenario] ?? "scored",
    });
  }
  scenarios.sort((a, b) => a.scenario.localeCompare(b.scenario));
  return { meta, scenarios };
}

/**
 * Applies the baseline to one run, the way the suite does. Returns, per
 * scenario, the entry that covers each failing check and the ones that nothing
 * covers, plus the stale entries.
 */
function evaluate(run, entries) {
  const wholesale = new Map();
  const perCheck = new Map();
  for (const entry of entries) {
    if (entry.checkId === null) wholesale.set(entry.scenario, entry);
    else {
      const byId = perCheck.get(entry.scenario) ?? new Map();
      byId.set(entry.checkId, entry);
      perCheck.set(entry.scenario, byId);
    }
  }

  const uncovered = [];
  const stale = [];

  for (const scenario of run.scenarios) {
    scenario.covered = [];
    scenario.uncovered = [];
    const failing = scenario.collapsed.filter(isFailing);

    // A not-scored scenario cannot fail the run, so the baseline never judges
    // it and nothing here can change an exit code. Its entries are read all the
    // same, because the report has to say why those scenarios are out of reach.
    if (scenario.scoring !== "scored") {
      const whole = wholesale.get(scenario.scenario);
      const byId = perCheck.get(scenario.scenario);
      for (const check of failing) {
        const entry = whole ?? byId?.get(check.id);
        if (entry === undefined) continue;
        entry.matched = true;
        scenario.covered.push({ check, entry });
      }
      continue;
    }

    const whole = wholesale.get(scenario.scenario);
    if (whole !== undefined) {
      whole.matched = true;
      if (failing.length > 0) scenario.covered = failing.map((check) => ({ check, entry: whole }));
      else stale.push({ entry: whole, scenario: scenario.scenario });
      continue;
    }

    const byId = perCheck.get(scenario.scenario);
    for (const check of failing) {
      const entry = byId?.get(check.id);
      if (entry === undefined) {
        scenario.uncovered.push(check);
        uncovered.push({ scenario: scenario.scenario, check });
      } else {
        entry.matched = true;
        scenario.covered.push({ check, entry });
      }
    }
    if (byId !== undefined) {
      for (const [id, entry] of byId) {
        const emitted = scenario.collapsed.find((check) => check.id === id);
        if (emitted?.status === "SUCCESS") {
          entry.matched = true;
          stale.push({ entry, scenario: scenario.scenario });
        }
      }
    }
  }
  return { uncovered, stale };
}

/** Escapes the pipe so a check message cannot break a Markdown table. */
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

function scoringLabel(scoring) {
  return scoring === "scored" ? "scored" : `not scored (${scoring})`;
}

function scenarioTable(run) {
  const lines = [
    "| Scenario | Scoring | Result | Baseline entry |",
    "| --- | --- | --- | --- |",
  ];
  for (const scenario of run.scenarios) {
    const counts =
      `${scenario.passed} passed, ${scenario.failed} failed` +
      (scenario.warned > 0 ? `, ${scenario.warned} warning` : "") +
      (scenario.skipped > 0 ? `, ${scenario.skipped} skipped` : "");
    const verdict =
      scenario.uncovered.length > 0
        ? "unbaselined"
        : scenario.covered.length > 0
          ? "baselined"
          : scenario.failed + scenario.warned > 0
            ? "failing, not scored and not baselined"
            : "green";
    const baseline =
      scenario.uncovered.length > 0
        ? `**none** for ${scenario.uncovered.map((check) => `\`${check.id}\``).join(", ")}`
        : scenario.covered.length > 0
          ? [...new Set(scenario.covered.map((hit) => `\`${hit.entry.raw}\` (${hit.entry.category})`))].join(", ")
          : "";
    lines.push(
      `| \`${scenario.scenario}\` | ${scoringLabel(scenario.scoring)} | ${verdict}, ${counts} | ${baseline} |`,
    );
  }
  return lines.join("\n");
}

function provenSection(runs) {
  const lines = [];
  const green = new Map();
  for (const run of runs) {
    for (const scenario of run.scenarios) {
      for (const check of scenario.collapsed) {
        if (check.status !== "SUCCESS") continue;
        const seen = green.get(check.id) ?? new Set();
        seen.add(run.meta.revision);
        green.set(check.id, seen);
      }
    }
  }

  lines.push("| Check | Revisions | What it settles |");
  lines.push("| --- | --- | --- |");
  for (const headline of HEADLINE_CHECKS) {
    const seen = green.get(headline.id);
    lines.push(
      `| \`${headline.id}\` | ${seen === undefined ? "not green" : [...seen].sort().join(", ")} | ${headline.what} |`,
    );
  }
  lines.push("");

  const scenarioLines = [];
  for (const headline of HEADLINE_SCENARIOS) {
    const hits = runs
      .flatMap((run) =>
        run.scenarios
          .filter((scenario) => scenario.scenario === headline.name)
          .map((scenario) => ({ run, scenario })),
      )
      .filter((hit) => hit.scenario.failed + hit.scenario.warned === 0);
    // No failing check is not the same as a green result: a scenario that
    // executed nothing measures nothing, and calling it green would claim a
    // proof the run never produced.
    const green = hits.filter((hit) => hit.scenario.passed > 0);
    const empty = hits.filter((hit) => hit.scenario.passed === 0);
    if (green.length > 0) {
      scenarioLines.push(
        `- \`${headline.name}\`, fully green on ${green.map((hit) => hit.run.meta.revision).join(" and ")}: ${headline.what}.`,
      );
    }
    if (empty.length > 0) {
      scenarioLines.push(
        `- \`${headline.name}\`, no check executed on ${empty.map((hit) => hit.run.meta.revision).join(" and ")}: ${headline.what} was not measured.`,
      );
    }
  }
  if (scenarioLines.length > 0) {
    lines.push("Scenarios with no failing check at all:");
    lines.push("");
    lines.push(...scenarioLines);
  }
  return lines.join("\n");
}

/**
 * The other half of an honest report: what the run never exercised. Grouped by
 * the baseline category, because the category is exactly the reason a scenario
 * could not run.
 */
function untestedSection(runs) {
  // Keyed by baseline entry, not by scenario: `caching` and `server-stateless`
  // lose several checks for several reasons, and folding them into one line
  // would drop the reasons the reader came for.
  const byCategory = new Map();
  for (const run of runs) {
    for (const scenario of run.scenarios) {
      for (const hit of scenario.covered) {
        const bucket = byCategory.get(hit.entry.category) ?? new Map();
        const seen = bucket.get(hit.entry.raw) ?? { entry: hit.entry, revisions: new Set() };
        seen.revisions.add(run.meta.revision);
        bucket.set(hit.entry.raw, seen);
        byCategory.set(hit.entry.category, bucket);
      }
    }
  }

  const headings = {
    "fixture-tools-absent":
      "The scenario calls a tool name written into the suite. A bridge exposes the tools of the agents it fronts, so the call cannot resolve and the requirement is never exercised.",
    "capability-not-declared":
      "The bridge declares neither `prompts`, nor `resources`, nor `completions`, nor `logging`, and answers -32601 to them. The answer is correct, and `sep-2575-discover-capabilities-match-handlers` proves it consistent, but the scenario has nothing to measure.",
    "suite-false-negative":
      "The check fails for a reason other than the requirement it states. The bridge satisfies the requirement, verified by hand.",
    "extension-not-applicable":
      "An extension scenario, never scored, and built on the same hard-coded fixture tools.",
    "legacy-stateless-by-design":
      "The 2025-11-25 route is served statelessly by the SDK (legacy: stateless), so no Mcp-Session-Id is issued and a SHOULD-level check that needs a session reports a warning. The bridge holds no session on purpose.",
  };

  const lines = [];
  for (const [category, bucket] of [...byCategory].sort()) {
    lines.push(`**${category}.** ${headings[category] ?? ""}`);
    lines.push("");
    for (const [raw, seen] of [...bucket].sort()) {
      lines.push(`- \`${raw}\` (${[...seen.revisions].sort().join(", ")}): ${seen.entry.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function uncoveredSection(runs) {
  const lines = [];
  let any = false;
  for (const run of runs) {
    const rows = run.scenarios.flatMap((scenario) =>
      scenario.uncovered.map((check) => ({ scenario, check })),
    );
    if (rows.length === 0) continue;
    any = true;
    lines.push(`### ${run.meta.revision}`);
    lines.push("");
    for (const row of rows) {
      lines.push(`- \`${row.scenario.scenario}:${row.check.id}\` (${row.check.status})`);
      lines.push(`  - ${cell(row.check.errorMessage ?? row.check.description ?? "no message")}`);
      lines.push(`  - \`conformance/results/${run.meta.revision}/${row.scenario.directory}/checks.json\``);
    }
    lines.push("");
  }
  if (!any) {
    lines.push(
      "None. Every failing check of a scored scenario is covered by an entry of `conformance/baseline.yml`, so both runs exit 0.",
    );
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  if (!existsSync(RESULTS_ROOT)) {
    process.stderr.write(
      "[summarize] conformance/results is missing. Run `npm run conformance` first.\n",
    );
    process.exit(2);
  }
  const revisions = [];
  for (const name of (await readdir(RESULTS_ROOT)).sort().reverse()) {
    const entry = await stat(join(RESULTS_ROOT, name));
    if (entry.isDirectory()) revisions.push(name);
  }
  if (revisions.length === 0) {
    process.stderr.write("[summarize] no results directory found under conformance/results.\n");
    process.exit(2);
  }

  const { entries, problems } = await readBaseline();
  const runs = [];
  const verdicts = [];
  for (const revision of revisions) {
    const run = await readRun(revision);
    verdicts.push({ revision, ...evaluate(run, entries) });
    runs.push(run);
  }

  const generated = new Date().toISOString();
  const out = [];
  out.push("# Conformance report");
  out.push("");
  out.push(
    "Produced by `npm run conformance`, which replays the official MCP conformance suite against the bridge and then aggregates the per-scenario `checks.json` files the suite leaves behind. Do not edit by hand.",
  );
  out.push("");
  out.push(`Generated: ${generated}`);
  out.push("");

  out.push("## Command and versions");
  out.push("");
  out.push("| Item | Value |");
  out.push("| --- | --- |");
  const first = runs[0].meta;
  out.push(`| Suite | \`@modelcontextprotocol/conformance@${first.suiteVersion ?? "unknown"}\` |`);
  out.push(`| Node | ${first.nodeVersion ?? process.version} |`);
  out.push(`| Bridge endpoint | \`${first.bridgeUrl ?? "http://127.0.0.1:<port>/mcp"}\` |`);
  out.push(`| Baseline | \`${first.baseline ?? "none"}\` |`);
  for (const run of runs) {
    out.push(`| Command, ${run.meta.revision} | \`${run.meta.command ?? "unknown"}\` |`);
  }
  out.push("");

  out.push("## Totals");
  out.push("");
  out.push("| Requirement set | Scenarios | Scored | Checks passed | Checks failed | Warnings | Unbaselined failures | Exit code |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [index, run] of runs.entries()) {
    const scored = run.scenarios.filter((scenario) => scenario.scoring === "scored").length;
    const passed = run.scenarios.reduce((sum, scenario) => sum + scenario.passed, 0);
    const failed = run.scenarios.reduce((sum, scenario) => sum + scenario.failed, 0);
    const warned = run.scenarios.reduce((sum, scenario) => sum + scenario.warned, 0);
    out.push(
      `| \`${run.meta.revision}\` | ${run.scenarios.length} | ${scored} | ${passed} | ${failed} | ${warned} | ${verdicts[index].uncovered.length} | ${run.meta.exitCode ?? "unknown"} |`,
    );
  }
  out.push("");
  out.push(
    "Checks failed counts every FAILURE the suite wrote, baselined or not. The exit code is the suite's verdict once the baseline is applied: 0 means every failing check of a scored scenario has an entry, and no entry has gone stale.",
  );
  out.push("");

  out.push("## What the suite proved");
  out.push("");
  out.push(provenSection(runs));
  out.push("");

  out.push("## What the suite could not test");
  out.push("");
  out.push(
    "A green total would be a lie here, and so would a red one. These scenarios never reached the requirement they state, for the reason given.",
  );
  out.push("");
  out.push(untestedSection(runs));

  out.push("## Failures not covered by the baseline");
  out.push("");
  out.push(uncoveredSection(runs));

  const staleAll = verdicts.flatMap((verdict) => verdict.stale);
  if (staleAll.length > 0) {
    out.push("## Stale baseline entries");
    out.push("");
    out.push("These entries now pass. Remove them from `conformance/baseline.yml`, or the run keeps exiting 1.");
    out.push("");
    for (const item of staleAll) out.push(`- \`${item.entry.raw}\``);
    out.push("");
  }

  const unmatched = entries.filter((entry) => !entry.matched);
  if (unmatched.length > 0) {
    out.push("## Baseline entries no run exercised");
    out.push("");
    out.push(
      "Kept on purpose: the two requirement sets do not run the same scenarios, and an entry the current run never met is silently ignored by the suite.",
    );
    out.push("");
    for (const entry of unmatched) out.push(`- \`${entry.raw}\` (${entry.category})`);
    out.push("");
  }

  if (problems.length > 0) {
    out.push("## Baseline file problems");
    out.push("");
    for (const problem of problems) out.push(`- ${problem}`);
    out.push("");
  }

  for (const [index, run] of runs.entries()) {
    out.push(`## Run \`${run.meta.revision}\`, scenario by scenario`);
    out.push("");
    out.push(scenarioTable(run));
    out.push("");
    out.push(
      `Baselined failing checks: ${run.scenarios.reduce((sum, scenario) => sum + scenario.covered.length, 0)}, warnings included, which the baseline treats like failures. Unbaselined: ${verdicts[index].uncovered.length}.`,
    );
    out.push("");
  }

  out.push("## Reading the raw results");
  out.push("");
  out.push(
    "`conformance/results/<revision>/server-<scenario>-<timestamp>/checks.json` is the machine artefact, one file per scenario, each an array of checks with `id`, `status`, `errorMessage` and `specReferences`. `run.json` beside them records the command, the versions, the totals and which scenarios the requirement set never scores. `run.log` is the console transcript and is not versioned.",
  );
  out.push("");

  await writeFile(REPORT, `${out.join("\n")}\n`);
  process.stdout.write(`[summarize] wrote ${REPORT}\n`);
  for (const [index, run] of runs.entries()) {
    process.stdout.write(
      `[summarize] ${run.meta.revision}: exit ${run.meta.exitCode ?? "?"}, ` +
        `${verdicts[index].uncovered.length} unbaselined, ${verdicts[index].stale.length} stale\n`,
    );
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`[summarize] baseline: ${problem}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`[summarize] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
