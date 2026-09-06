# End of life note

This bridge targets two moving protocols and pins both. This note says, by name, what breaks at the next revision of each, so that a reader in six months knows whether the package still applies before running it.

## Pinned surface

| Surface | Pinned to | Where it is read |
| --- | --- | --- |
| MCP core | revision `2026-07-28` and `2025-11-25` | `@modelcontextprotocol/server` 2.0.0, exact |
| MCP tasks extension | schema `2026-07-28` of `io.modelcontextprotocol/tasks` | `src/tasks/`, hand written against the published schema |
| A2A | `1.0` on the wire, specification v1.0.1 | `@a2a-js/sdk` 1.1.0, exact |
| Conformance suite | `@modelcontextprotocol/conformance` 0.2.0-alpha.11 | `scripts/conformance/run.mjs` |

## What breaks on the MCP side

- Any revision that renames or removes `server/discover`, changes the required keys of the per-request `_meta` envelope, or changes the values of `resultType` breaks the modern route entirely. Reread `src/tasks/intercept.ts` first, which holds the required envelope keys, then `src/http.ts` for the modern against legacy classification.
- Any change to the tasks extension schema (`Task` fields, `TaskStatus` values, `inputRequests` shape, `-32021` for an undeclared extension, `-32602` for an unknown task) breaks `src/tasks/handlers.ts`. The five status values and their spelling (`cancelled` with two l) are asserted in `test/unit/lifecycle.test.ts`.
- A release of `@modelcontextprotocol/server` that fixes issue 2598 (extension methods shadowed by the legacy registry) makes the router in `src/tasks/intercept.ts` dead code: the three handlers registered on the SDK by `registerTasksHandlers` in `src/server.ts` already dispatch a request carrying the `2026-07-28` envelope to `TasksService.handle`, the same entry point the router calls and with the same two gates, and refuse only a request that carries no such envelope, which is the legacy route. Remove the router and its test block, keep the handlers.
- A release that fixes issue 2637 (`CreateTaskResult` rejected by the `tools/call` seam) makes the empty `content` array on `CreateTaskResult` unnecessary. Remove it in `src/tasks/handlers.ts`, in `#createTaskResult`.
- A stable `0.2.0` of the conformance suite may change the scenario catalog and the baseline format. `conformance/baseline.yml` follows the `--expected-failures` format of the alpha; rerun `npm run conformance` and rewrite stale entries.
- When an IDE client starts declaring the tasks extension, nothing changes in the code; the dated README sentence naming the clients measured against this bridge has to be measured again and rewritten.

## What breaks on the A2A side

- A2A v1.1 candidates are being consolidated in issue 1942 of `a2aproject/A2A` into five tracking issues: stream resumption and event ordering, idempotency and safe retries, push notification config security, client-directed skill selection, and authentication scheme declaration. A change to the agent card shape breaks `src/agent-card.ts`; a change to `TaskState` breaks `src/lifecycle.ts`, where the nine values are enumerated exhaustively and any unknown value throws; a change to `Part` breaks `src/parts.ts`.
- The bridge fetches every agent card with `A2A-Version: 1.0` (`src/agent-card.ts`) and lets `@a2a-js/sdk` carry the version on the JSON-RPC calls. An agent that only accepts `1.1` answers `-32009`, which the bridge surfaces as a tool error with `a2aErrorCode`.
- A release of `@a2a-js/sdk` that changes the `ts-proto` generated types (numeric `TaskState`, `Part.content.$case`) breaks the two pure modules above; their unit tests fail first.

## Maintenance policy

Versions are pinned exactly and are not meant to float. When one of the events above happens, either a new minor version is published with the pins moved and this note rewritten, or the package is marked deprecated on npm with a pointer to what replaced it. There is no third state.
