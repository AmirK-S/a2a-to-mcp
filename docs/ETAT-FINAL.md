# Final state

Written on 2026-09-06, the day of the first release. This file says what the project is when nobody is working on it, so that a reader knows what to expect before opening an issue.

## Where it is published

| What | Where |
| --- | --- |
| Source | https://github.com/AmirK-S/a2a-to-mcp, tag `v0.1.0` |
| Package | https://www.npmjs.com/package/a2a-to-mcp, `0.1.0` |
| MCP registry | `io.github.AmirK-S/a2a-to-mcp`, version `0.1.0`, status active |
| Measurements shared upstream | comment on `modelcontextprotocol/typescript-sdk` issue 2598 |
| Listing requests | `a2aproject/A2A` issue 2212; pull requests `ai-boost/awesome-a2a` 163 and `sing1ee/a2a-directory` 55 |

## Pinned versions

`@modelcontextprotocol/server` 2.0.0, `@a2a-js/sdk` 1.1.0, `zod` 4.2.0, exact. Protocol surface: MCP `2026-07-28` and `2025-11-25`, tasks extension schema `2026-07-28`, A2A `1.0` (specification v1.0.1). Conformance suite `0.2.0-alpha.11`.

## What has been verified

- 241 tests passing and 7 skipped on a clean checkout (`npm test`); the skipped ones run in CI against the official `helloworld` A2A sample. CI is green on Node 20, 22 and 24.
- The official MCP conformance suite replayed on both revisions with a baseline where every expected failure carries its reason, exit code 0 on both. See `conformance/REPORT.md`.
- One real session in Claude Code, traced and annotated in `docs/DEMO-CLAUDE-CODE.md`.
- One run against a public A2A v1.0 agent, traced in `docs/USAGE-REEL.md`, plus the Cursor measurement recorded there.

## End of life and signals

`docs/END-OF-LIFE.md` lists, in order, the five signals that would break or simplify this bridge, A2A v1.1 first. Last checked on 2026-09-06.

## Issue policy

Issues and pull requests get an answer within seven days. Bug reports against the pinned versions are handled. Feature requests are answered, not promised.

## Open items, and what happens to them

- No authentication on either side: will not be done in the 0.1 line. It is the first item of the extended scope and needs a design of its own.
- One tool per A2A skill, `subscriptions/listen` with task notifications, the reverse direction (an MCP server published as an A2A agent): not done, not promised. Listed in the README so that nobody expects them silently.
- The two workarounds for the reference SDK (issues 2598 and 2637): kept until the SDK moves, then removed as `docs/END-OF-LIFE.md` describes.
- `ListTasks` is not exposed: handles replace it, and it stays out of scope.

No other debt is known. Nothing is half done.
