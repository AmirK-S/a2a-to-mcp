# a2a-to-mcp

A2A v1.0.1 agents exposed as MCP tools on a stateless MCP 2026-07-28 server, with the `io.modelcontextprotocol/tasks` extension.

Point the bridge at one or more A2A agents by their agent card. Any MCP client, Claude Code or Cursor among them, then sees four ordinary tools: discover an agent, send it a message, read a task, cancel a task. The bridge translates parts, artifacts, task states and errors between the two protocols and says out loud what it cannot translate.

| Surface | Version served | Pinned dependency |
| --- | --- | --- |
| MCP, modern route | `2026-07-28` via `server/discover`, no session, per-request `_meta` | `@modelcontextprotocol/server` 2.0.0 |
| MCP, legacy route | `2025-11-25` via `initialize`, same endpoint | same |
| MCP tasks extension | `io.modelcontextprotocol/tasks` schema `2026-07-28`, modern route only | none, served by the bridge |
| A2A | `1.0` (`A2A-Version: 1.0`), JSON-RPC binding | `@a2a-js/sdk` 1.1.0 |

Node 20 or later. Apache-2.0.

## Quick start

```sh
npm install -g a2a-to-mcp
```

Or run it from the repository:

```sh
git clone https://github.com/AmirK-S/a2a-to-mcp.git && cd a2a-to-mcp && npm ci && npm run build
```

Write `agents.json`, one alias per agent, by base URL or by card URL:

```json
{
  "agents": {
    "hello": { "url": "http://localhost:9999" },
    "planner": { "cardUrl": "https://planner.example.org/.well-known/agent-card.json" }
  },
  "port": 8931
}
```

Run it:

```sh
node dist/cli.js --config agents.json
```

The bridge listens on `http://127.0.0.1:8931/mcp`. Only loopback hosts are accepted in the `Host` and `Origin` headers unless `allowedHosts` is set in the configuration. There is no authentication in this version, on either side.

### Claude Code

Add to `.mcp.json` at the root of the project, which is the block the bridge prints on startup:

```json
{
  "mcpServers": {
    "a2a-to-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:8931/mcp"
    }
  }
}
```

Claude Code negotiates `2026-07-28` through `server/discover` since its v2 runtime, [documented from 2.1.232](https://code.claude.com/docs/en/mcp) and measured here with 2.1.263. Older versions fall back to `initialize` and get the same four tools on the legacy route. A full annotated trace of a Claude Code session against the bridge, discovery, a task with an artifact and an elicitation round trip, is in [`docs/DEMO-CLAUDE-CODE.md`](docs/DEMO-CLAUDE-CODE.md). In headless mode (`claude -p`) there is nobody to answer an elicitation, so Claude Code cancels it and the bridge cancels the A2A task; the interactive mode asks the user.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "a2a": { "url": "http://localhost:8931/mcp" }
  }
}
```

Cursor speaks `2025-11-25` and is served through `initialize` on the same endpoint.

## The four tools

Every tool takes the agent alias as its first argument when several agents are configured; with a single agent the alias may be omitted and defaults to it.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `a2a_discover` | `agent` | the agent card as the agent served it, after a structural check, in `structuredContent`, with a text summary and the card URL in `_meta` |
| `a2a_send_message` | `agent`, `text`, `contextHandle?`, `taskHandle?` | the agent reply, see the result contract below |
| `a2a_get_task` | `agent`, `taskHandle`, `historyLength?` | the task envelope with its history |
| `a2a_cancel_task` | `agent`, `taskHandle` | the task envelope after the cancellation request |

### Calling a tool on the wire

The argument that carries the message is `text`. A complete `tools/call` on the `2026-07-28` route, as an MCP client sends it:

```sh
curl -sS http://127.0.0.1:8931/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: a2a_send_message' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                 "io.modelcontextprotocol/clientCapabilities":{}},
        "name":"a2a_send_message",
        "arguments":{"agent":"hello","text":"task: hello world"}}}'
```

A run against a public A2A agent, with the one mistake a first user makes, is in [`docs/USAGE-REEL.md`](docs/USAGE-REEL.md).

### Result contract

Each reply is a `CallToolResult` whose `content` holds the translated parts and whose `structuredContent` is an envelope:

```json
{
  "kind": "task",
  "contextHandle": "cx_...",
  "taskHandle": "tk_...",
  "a2aState": "TASK_STATE_COMPLETED",
  "status": "completed",
  "note": "present when the mapping lost information",
  "artifacts": [{ "artifactId": "...", "name": "result" }],
  "data": {}
}
```

`data` holds the single A2A data part of the artifacts, and is absent when there is none or more than one. `history` is added by `a2a_get_task` only.

`kind` is `message` for a direct A2A message and `task` when the agent opened a task. Handles are opaque strings minted by the bridge, never A2A identifiers; they hide the bridge table, not what an agent chooses to write in its own messages. They live in memory for fifteen minutes after their last use by default (`handleTtlMs`), and an expired or unknown handle returns an explicit error. Pass `contextHandle` back to stay in the same conversation, and `taskHandle` back to answer a task the agent left waiting for input.

An agent failure (`FAILED`, `REJECTED`, `AUTH_REQUIRED`), and a task the agent left in the unspecified state, is a tool execution error: `isError: true`, the agent text in `content`, the A2A state and a note in the envelope. A typed A2A error (codes `-32001` to `-32009`) is also a tool execution error, with the code in `structuredContent.a2aErrorCode`. The bridge never re-emits an A2A error code as a JSON-RPC code. JSON-RPC reserves `-32000` to `-32099` for server-defined errors, MCP already uses `-32020`, `-32021` and `-32022` in that band, and an A2A code replayed there would claim an MCP meaning it does not have.

## Long-running tasks

### With the tasks extension

A client that declares `io.modelcontextprotocol/tasks` in the per-request `clientCapabilities.extensions` gets a `CreateTaskResult` from `a2a_send_message` as soon as the agent opens a task, then polls `tasks/get` and may call `tasks/update` and `tasks/cancel`. The bridge consumes `SendStreamingMessage` in the background when the card announces streaming, and `GetTask` otherwise.

| A2A `TaskState` | MCP `TaskStatus` on `tasks/get` | What is lost |
| --- | --- | --- |
| `SUBMITTED` | `working` | MCP has no accepted but not started state; `statusMessage` says so |
| `WORKING` | `working` | nothing |
| `INPUT_REQUIRED` | `input_required` with one synthesized form elicitation | A2A asks in free text; the form has a single string field |
| `COMPLETED` | `completed`, `result` is the full `CallToolResult` | nothing |
| `FAILED`, `REJECTED`, `AUTH_REQUIRED` | `completed`, `result.isError` is true | a refusal and an authorization request become indistinguishable from a failure without the envelope |
| `CANCELED` | `cancelled` | nothing, mind the spelling |
| unspecified | `completed`, `result.isError` is true | A2A sent no lifecycle at all; the bridge does not guess one |
| bridge cannot reach the task any more | `failed` with a JSON-RPC `error`, A2A code in `error.data` | |

`AUTH_REQUIRED` is deliberately not mapped to `input_required`: MCP forbids form elicitation for credentials, and A2A asks for out-of-band authorization. The agent text, which usually carries the URL to visit, is returned in the result.

The extension is served on the `2026-07-28` route only. On the legacy route, `tasks/*` answer `-32021` with the required capability. As of 2026-09-06, the two clients measured against this bridge, Claude Code and Cursor, do not declare the extension. It is exercised by the test suite in this repository and by any client that opts in per request.

`CreateTaskResult` leaves the bridge with an empty `content` array in addition to the fields the extension defines. That is a workaround for the reference SDK, which validates every `tools/call` result against the plain result schema (typescript-sdk issue 2637). The three extension methods are served by a small router in front of the SDK on the modern route, because the SDK answers `-32601` to `tasks/get` and `tasks/cancel` before consulting its handlers (typescript-sdk issue 2598), and splitting the three across two layers would let them drift. Both workarounds are isolated and will be removed when the SDK moves.

### Without the extension

`a2a_send_message` waits for the agent to reach a terminal or interrupted state and answers inline. A task left in `INPUT_REQUIRED` comes back:

- as a multi-round-trip `input_required` result with one form elicitation, for a client that declares `elicitation`, which then replays the call with the answer;
- as an ordinary result whose envelope says `input_required` and carries the `taskHandle`, for any other client, which then sends the answer with that handle.

## What crosses the bridge, and what does not

Parts:

| A2A `Part` | MCP content block |
| --- | --- |
| `text` | `TextContent` |
| `data` | `TextContent` holding the JSON, flagged in `_meta`; also `structuredContent.data` when it is the only data part of the task artifacts |
| `url` | `ResourceLink` with `filename` as name and `mediaType` as `mimeType` |
| `raw`, image or audio media type | `ImageContent` or `AudioContent` in base64 |
| `raw`, other media type | embedded blob resource under an `a2a://part/` URI |

`filename`, artifact identity and name, message and context identifiers travel in `_meta["io.github.amirk-s/a2a"]` on each block.

Not carried, by design: push notifications (no webhook in MCP), agent card signatures, `securitySchemes`, streaming events as such (accumulated into the task), `ListTasks` (handles replace it), and any routing of free text to a skill. The bridge calls no language model and keeps nothing on disk.

## Conformance

Read the score with its cause: on the `2026-07-28` run, 32 of the 37 scored scenarios have at least one check that is not green, 29 with a failure and 3 with warnings only. Nineteen call tool names written into the suite, and 13 exercise prompts, resources or completions, which a bridge to A2A agents does not declare; `logging` is not among them, it is only scored on `2025-11-25`. The suite counts both families as failures on purpose, and points at the expected-failures baseline as the answer ([`modelcontextprotocol/conformance#248`](https://github.com/modelcontextprotocol/conformance/issues/248)). The run records 67 failing checks and 5 warnings in all, every one of them in the committed baseline with its reason; the suite exits 0 on both revisions, and the protocol checks that apply to a bridge are green: wire schema, `server/discover`, the match between the capabilities announced and the handlers mounted, the `subscriptions/listen` acknowledgement, SEP-2243 headers, DNS rebinding protection. The numbers are in [`conformance/REPORT.md`](conformance/REPORT.md), regenerated by the command below.

`npm run conformance` replays the official suite, `@modelcontextprotocol/conformance` at `0.2.0-alpha.11`, for `2026-07-28` and `2025-11-25`, with a baseline of expected failures where every line carries its reason. The report is in [`conformance/REPORT.md`](conformance/REPORT.md).

What the suite proves: every message the bridge emits validates against the schema of its revision (`wire-schema-valid` on both wires), `server/discover` and the stateless wire behave, header validation of SEP-2243 is enforced, DNS rebinding protection is on. What it cannot measure: the scenarios that call the suite's own fixture tools by name, and the `tasks-*` scenarios, which a bridge to real agents cannot satisfy without pretending to be the fixture. The tasks extension is instead covered check by check in `test/integration/tasks-extension.test.ts`, written against the wire.

## Development

```sh
npm ci
npm test                 # unit and integration, in-process fixture agent, no network
npm run test:helloworld  # against the official A2A helloworld sample, see scripts/helloworld
npm run conformance      # official MCP suite, both revisions, baseline applied
```

The fixture agent in `fixtures/agent` is a deterministic A2A v1.0 agent without a model: its commands drive every task state an agent can deliberately report, the two-turn input-required cycle, cancellation, the four part kinds and the nine typed errors. `npx tsx fixtures/agent/cli.ts --port 41241` runs it standalone.

## Maintenance and issues

Issues and pull requests get an answer within seven days. Bug reports against the pinned versions are handled; requests for new features are read and answered but not promised. The extended scope that may follow, one tool per A2A skill, `subscriptions/listen` with task notifications, A2A authentication schemes from the configuration, and the reverse direction, is listed here so that nobody expects it silently.

## End of life

What breaks at the next revision of either protocol is written in [`docs/END-OF-LIFE.md`](docs/END-OF-LIFE.md). Versions are pinned exactly on purpose. [`docs/ETAT-FINAL.md`](docs/ETAT-FINAL.md) records the state of the project at the first release: what is verified, what is published, what is open and will stay so.

## License

Apache-2.0. The specifications of both protocols and the A2A SDK carry the same license.
