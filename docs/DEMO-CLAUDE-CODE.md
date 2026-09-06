# The bridge in Claude Code, wire by wire

A real Claude Code run against the bridge, with every HTTP exchange captured by a
logging reverse proxy sitting between the client and the bridge. Nothing is
reconstructed: what follows is the content of `trace.jsonl`, abridged only where
a field is long, and every abridgement is marked with `...` and named.

## What ran

| Piece | Version |
| --- | --- |
| Claude Code | `2.1.263`, `user-agent: claude-code/2.1.263 (sdk-cli)` |
| Bridge | this repository at commit `b4c8bc3`, `a2a-to-mcp` 0.1.0, built with `npm ci && npm run build` |
| Fixture agent | `fixtures/agent`, card version `1.0.0`, A2A `1.0` over JSONRPC, `@a2a-js/sdk` 1.1.0 |
| Node | v26.4.0 |

Wiring, all on loopback:

```
claude  ->  127.0.0.1:8932  (logging proxy, writes trace.jsonl)
            127.0.0.1:8931  (a2a-to-mcp, node dist/cli.js --config agents.json --port 8931)
            127.0.0.1:41241 (fixture agent, npx tsx fixtures/agent/cli.ts --port 41241)
```

The proxy forwards method, path and every request header unchanged, rewriting
only `Host` so the bridge loopback check sees the port it is bound to. It
buffers each response and writes one JSON line per exchange.

Bridge configuration:

```json
{ "agents": { "fixture": { "url": "http://127.0.0.1:41241" } } }
```

Client configuration, the `.mcp.json` block, passed as `--mcp-config`:

```json
{
  "mcpServers": {
    "a2a": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8932/mcp"
    }
  }
}
```

The exact command:

```sh
MCP_SDK_GENERATION=v2 claude -p "You have MCP tools from an A2A bridge. First call a2a_discover on the agent alias fixture and tell me its name and skills in one line. Then call a2a_send_message on fixture with the text 'task: hello world' and report the text the agent returned. Then call a2a_send_message on fixture with the text 'ask: colour', and if it asks you a question, answer 'blue' by whatever mechanism the tool offers, and report the final text." \
  --mcp-config mcp-config.json \
  --strict-mcp-config \
  --model haiku \
  --output-format json \
  --allowedTools "mcp__a2a__a2a_discover,mcp__a2a__a2a_send_message,mcp__a2a__a2a_get_task,mcp__a2a__a2a_cancel_task"
```

`--allowedTools` is not decoration. A first run without it ended with the model
answering "I need permission to call the A2A MCP tools" and a
`permission_denials` entry for `mcp__a2a__a2a_discover`: in headless mode there
is no one to approve a tool call, so the tools have to be allowed on the command
line. That first run reached the bridge three times, for `server/discover`,
`subscriptions/listen` and `tools/list`, and never called a tool.

Eighteen exchanges follow. Sixteen belong to the Claude Code run, exchanges 17
and 18 are an appendix from a minimal client, clearly marked as such.

## 1. server/discover

Request:

```
POST /mcp
MCP-Protocol-Version: 2026-07-28
Mcp-Method: server/discover
accept: application/json, text/event-stream
```

```json
{
  "jsonrpc": "2.0",
  "id": "server-discover-probe-1",
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "claude-code",
        "title": "Claude Code",
        "version": "2.1.263",
        "description": "Anthropic's agentic coding tool",
        "websiteUrl": "https://claude.com/claude-code"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "roots": { "listChanged": true },
        "elicitation": {}
      }
    }
  }
}
```

Response, HTTP 200, `content-type: application/json`:

```json
{
  "result": {
    "supportedVersions": ["2026-07-28"],
    "capabilities": {
      "extensions": { "io.modelcontextprotocol/tasks": {} },
      "tools": { "listChanged": true }
    },
    "instructions": "This server exposes A2A 1.0 agents as MCP tools. The configured agents are: fixture. ...",
    "resultType": "complete",
    "ttlMs": 0,
    "cacheScope": "private",
    "_meta": {
      "io.modelcontextprotocol/serverInfo": { "name": "a2a-to-mcp", "version": "0.1.0" }
    }
  },
  "jsonrpc": "2.0",
  "id": "server-discover-probe-1"
}
```

The `instructions` string is abridged: the full value continues with the
sentence about calling `a2a_discover` first, then `a2a_send_message`, and about
task handles feeding `a2a_get_task` and `a2a_cancel_task`.

What this exchange proves. The very first byte on the wire is
`server/discover`, not `initialize`: the whole trace contains zero occurrences
of the string `initialize` and zero occurrences of the string `session`, in
headers as well as in bodies. There is no `Mcp-Session-Id` in this response or
in any other. The client states its capabilities inside the per request
envelope `_meta`, and those capabilities are exactly `{roots: {listChanged:
true}, elicitation: {}}`: Claude Code can be asked a question, and cannot be
handed an MCP task. The bridge answers `resultType: "complete"` and advertises
the tasks extension it will serve to any client that asks for it.

## 2. subscriptions/listen, aborted

```
POST /mcp
Mcp-Method: subscriptions/listen
```

```json
{
  "jsonrpc": "2.0",
  "id": "listen:0",
  "method": "subscriptions/listen",
  "params": {
    "_meta": { "...the same envelope as exchange 1..." },
    "notifications": { "toolsListChanged": true }
  }
}
```

No response was recorded: the client closed the connection before the exchange
completed, which the proxy logs as
`"aborted": "client closed the response before it completed"`, with
`"status": null`.

Claude Code opens a long poll for server notifications and drops it as soon as
it has what it needs. The bridge is stateless and has nothing to push, so
nothing is lost. This is the first of three such attempts in the trace,
exchanges 2, 5 and 16.

## 3. notifications/cancelled

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/cancelled",
  "params": {
    "requestId": "listen:0",
    "_meta": { "...the same envelope as exchange 1..." }
  }
}
```

Response: HTTP 202, no body, no `content-type`.

The notification carries no `id`, and the bridge answers 202 with an empty
body, as the specification requires for a notification. Note that the envelope
`_meta` is repeated here too: every request carries it, because there is no
handshake in which it could have been stated once.

## 4. tools/list

```
POST /mcp
Mcp-Method: tools/list
```

```json
{
  "method": "tools/list",
  "jsonrpc": "2.0",
  "id": 0,
  "params": { "_meta": { "...the same envelope as exchange 1..." } }
}
```

Response, HTTP 200:

```json
{
  "result": {
    "tools": [
      { "name": "a2a_discover", "title": "Discover an A2A agent", "description": "...", "inputSchema": { "type": "object", "properties": { "agent": { "type": "string", "enum": ["fixture"] } }, "required": ["agent"] } },
      { "name": "a2a_send_message", "title": "Send a message to an A2A agent", "description": "...", "inputSchema": { "type": "object", "properties": { "agent": { "type": "string", "enum": ["fixture"] }, "text": { "type": "string", "minLength": 1 }, "contextHandle": { "type": "string" }, "taskHandle": { "type": "string" } }, "required": ["agent", "text"] } },
      { "name": "a2a_get_task", "title": "Read an A2A task", "description": "...", "inputSchema": { "...": "agent, taskHandle, historyLength" } },
      { "name": "a2a_cancel_task", "title": "Cancel an A2A task", "description": "...", "inputSchema": { "...": "agent, taskHandle" } }
    ],
    "resultType": "complete",
    "ttlMs": 60000,
    "cacheScope": "private",
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "a2a-to-mcp", "version": "0.1.0" } }
  },
  "jsonrpc": "2.0",
  "id": 0
}
```

The four tool descriptions are abridged, the JSON schema properties of the last
two are summarised by their key names. Nothing else is cut.

Four ordinary tools, no extension needed to see them. The `agent` property is
an `enum` built from the configuration, so the configured aliases are the only
value the model can produce. `resultType: "complete"` appears again, and
`ttlMs: 60000` tells the client the list may be cached for a minute.

## 5. subscriptions/listen, aborted

Same shape as exchange 2, `id: "listen:1"`. Recorded out of order in the file,
because the proxy writes a line when an exchange settles and this one settled
last, after exchange 14.

## 6. tools/call, a2a_discover

```
POST /mcp
Mcp-Method: tools/call
Mcp-Name: a2a_discover
```

```json
{
  "method": "tools/call",
  "params": {
    "name": "a2a_discover",
    "arguments": { "agent": "fixture" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "...": "as above" },
      "io.modelcontextprotocol/clientCapabilities": { "roots": { "listChanged": true }, "elicitation": {} },
      "claudecode/toolUseId": "toolu_01H6QVPfZQkTj71XFpYM1N2g",
      "progressToken": 1
    }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

Response, HTTP 200:

```json
{
  "result": {
    "_meta": {
      "io.github.amirk-s/a2a": {
        "cardUrl": "http://127.0.0.1:41241/.well-known/agent-card.json",
        "a2aVersion": "1.0"
      },
      "io.modelcontextprotocol/serverInfo": { "name": "a2a-to-mcp", "version": "0.1.0" }
    },
    "content": [
      {
        "type": "text",
        "text": "Fixture Agent (version 1.0.0)\nDeterministic A2A v1.0.1 agent with no language model, driven by the prefix of the first text part. ...\nA2A 1.0 over JSONRPC at http://127.0.0.1:41241/a2a\nStreaming: supported. Push notifications: not supported.\nSkills (5):\n  echo: Echo. ...\n  long-task: Long task. ...\n  ask: Ask for input. Parks the Task in INPUT_REQUIRED with a question, then completes it when a second message carrying the same taskId supplies the answer.\n  outcomes: Terminal outcomes. ...\n  media: Non-text parts. ..."
      }
    ],
    "structuredContent": {
      "name": "Fixture Agent",
      "description": "Deterministic A2A v1.0.1 agent with no language model, ...",
      "supportedInterfaces": [
        { "url": "http://127.0.0.1:41241/a2a", "protocolBinding": "JSONRPC", "tenant": "", "protocolVersion": "1.0" }
      ],
      "provider": { "organization": "a2a-to-mcp test bench", "url": "https://example.invalid/a2a-to-mcp" },
      "version": "1.0.0",
      "capabilities": { "streaming": true, "pushNotifications": false, "extensions": [], "extendedAgentCard": false },
      "securitySchemes": {},
      "securityRequirements": [],
      "defaultInputModes": ["text/plain"],
      "defaultOutputModes": ["text/plain"],
      "skills": [ "...the five skills, each with id, name, description, tags, examples, inputModes, outputModes, securityRequirements..." ],
      "signatures": []
    },
    "resultType": "complete"
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

The text summary and the five skill objects are abridged. The card is otherwise
returned whole, in the A2A v1.0 shape, `supportedInterfaces` included.

The agent card crosses the bridge twice, once as prose the model can read and
once as `structuredContent` a program can parse, and the card URL travels in the
vendor namespaced `_meta` rather than in the payload. `resultType: "complete"`
is on the tool result too, not only on the protocol level results.

## 7. tools/call, a2a_send_message, "task: hello world"

```json
{
  "method": "tools/call",
  "params": {
    "name": "a2a_send_message",
    "arguments": { "agent": "fixture", "text": "task: hello world" },
    "_meta": { "...envelope, claudecode/toolUseId, progressToken: 2..." }
  },
  "jsonrpc": "2.0",
  "id": 2
}
```

Response, HTTP 200:

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "dlrow olleh",
        "_meta": {
          "io.github.amirk-s/a2a": {
            "partKind": "text",
            "mediaType": "text/plain",
            "artifactId": "18c8a76a-5164-42c8-ba1a-ab1f0000efa5",
            "artifactName": "result"
          }
        }
      }
    ],
    "structuredContent": {
      "kind": "task",
      "contextHandle": "cx_ecQUpy0G8MSvoZh7OrXMAA",
      "taskHandle": "tk_15bH3peuqnWpk2iQJNDdOg",
      "a2aState": "TASK_STATE_COMPLETED",
      "status": "completed",
      "artifacts": [ { "artifactId": "18c8a76a-5164-42c8-ba1a-ab1f0000efa5", "name": "result" } ]
    },
    "resultType": "complete",
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "a2a-to-mcp", "version": "0.1.0" } }
  },
  "jsonrpc": "2.0",
  "id": 2
}
```

An A2A task ran to completion and came back inline, because this client did not
declare the tasks extension. The identifiers the client sees are
`cx_ecQUpy0G8MSvoZh7OrXMAA` and `tk_15bH3peuqnWpk2iQJNDdOg`, opaque handles
minted by the bridge. The A2A task id and context id are nowhere on the wire.
The A2A artifact identity survives the crossing in the block level `_meta`, and
`a2aState` keeps the A2A vocabulary next to the MCP `status`.

## 8. tools/call, a2a_send_message, "ask: colour", first round

```json
{
  "method": "tools/call",
  "params": {
    "name": "a2a_send_message",
    "arguments": {
      "agent": "fixture",
      "text": "ask: colour",
      "contextHandle": "cx_ecQUpy0G8MSvoZh7OrXMAA"
    },
    "_meta": { "...envelope, progressToken: 3..." }
  },
  "jsonrpc": "2.0",
  "id": 3
}
```

Response, HTTP 200:

```json
{
  "result": {
    "resultType": "input_required",
    "inputRequests": {
      "answer": {
        "method": "elicitation/create",
        "params": {
          "message": "What value should I use for colour?",
          "requestedSchema": {
            "type": "object",
            "properties": { "answer": { "type": "string", "description": "Your answer to the agent" } },
            "required": ["answer"]
          },
          "mode": "form"
        }
      }
    },
    "requestState": "v1.eyJwIjp7ImFsaWFzIjoiZml4dHVyZSIsInRhc2tIYW5kbGUiOiJ0a19BbzdzNGxoSFNjdnNJMzc0MERkLWVnIn0sImV4cCI6MTc4ODY2NzM4OX0.8Ol2KDb4gPFRGjQZcAvEb0AIM2cns-iw4A8IKeEZY9Y",
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "a2a-to-mcp", "version": "0.1.0" } }
  },
  "jsonrpc": "2.0",
  "id": 3
}
```

This is the exchange the whole design turns on. The A2A task parked in
`INPUT_REQUIRED` did not come back as a result the model has to notice: it came
back as `resultType: "input_required"` with one form elicitation, because the
client declared `elicitation` in exchange 1. The free text question of A2A
became a single required string field, which is the only schema A2A can justify.
The `requestState` is HMAC sealed and readable: its payload decodes to
`{"p":{"alias":"fixture","taskHandle":"tk_Ao7s4lhHScvsI3740Dd-eg"},"exp":1788667389}`,
the alias and the opaque handle and nothing else. No A2A task id, no context id,
and an expiry that dies with the handle it names.

Also note the client sent `contextHandle` back from exchange 7, which is how a
conversation is continued without any session on the wire.

## 9. tools/call, a2a_send_message, second round, elicitation cancelled

```json
{
  "method": "tools/call",
  "params": {
    "name": "a2a_send_message",
    "arguments": {
      "agent": "fixture",
      "text": "ask: colour",
      "contextHandle": "cx_ecQUpy0G8MSvoZh7OrXMAA"
    },
    "_meta": { "...envelope, same claudecode/toolUseId as exchange 8, progressToken: 4..." },
    "inputResponses": { "answer": { "action": "cancel" } },
    "requestState": "v1.eyJwIjp7ImFsaWFzIjoiZml4dHVyZSIsInRhc2tIYW5kbGUiOiJ0a19BbzdzNGxoSFNjdnNJMzc0MERkLWVnIn0sImV4cCI6MTc4ODY2NzM4OX0.8Ol2KDb4gPFRGjQZcAvEb0AIM2cns-iw4A8IKeEZY9Y"
  },
  "jsonrpc": "2.0",
  "id": 4
}
```

Response, HTTP 200:

```json
{
  "result": {
    "content": [],
    "structuredContent": {
      "kind": "task",
      "contextHandle": "cx_ecQUpy0G8MSvoZh7OrXMAA",
      "taskHandle": "tk_Ao7s4lhHScvsI3740Dd-eg",
      "a2aState": "TASK_STATE_CANCELED",
      "status": "cancelled"
    },
    "resultType": "complete",
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "a2a-to-mcp", "version": "0.1.0" } }
  },
  "jsonrpc": "2.0",
  "id": 4
}
```

The multi round trip worked exactly as designed, and the answer was a refusal.
Claude Code replayed the same `tools/call`, with the same `claudecode/toolUseId`
and the sealed `requestState` handed straight back, carrying
`inputResponses: {"answer": {"action": "cancel"}}`. It did not ask the model
for the answer and it did not ask a human, because in `-p` headless mode there
is no human to ask, so the elicitation is auto cancelled by the client. The
bridge honoured that: a declined or cancelled elicitation cancels the A2A task
rather than leaving it parked until the handle expires, which is what
`TASK_STATE_CANCELED` and `status: "cancelled"` say here. The handle in the
result, `tk_Ao7s4lhHScvsI3740Dd-eg`, is the one sealed in the `requestState`,
which is how the two rounds are stitched together with no server state.

So the demonstration answers the question it was asked: the `ask:` question does
become an elicitation, and it is the client, not the bridge, that could not
answer it here.

## 10 to 13. The same two rounds, twice more

Exchanges 10 and 11, then 12 and 13, repeat exchanges 8 and 9 verbatim in shape.
The model, seeing a cancelled task, tried the same call again, twice, this time
without `contextHandle`. Each attempt produced the same pair:

- a first `tools/call` answered with `resultType: "input_required"`, the same
  `elicitation/create` for `"What value should I use for colour?"`, and a fresh
  `requestState` sealing a fresh handle;
- a second `tools/call` replaying `inputResponses: {"answer": {"action": "cancel"}}`
  with that state, answered with `a2aState: "TASK_STATE_CANCELED"`.

The handles minted, in order: `tk_zb_siuVsO4oKGWaK1DXWZQ` with context
`cx_Q6GUzEuvZkEdOHzP3nIOjw`, then `tk_oOaubwnGk8su_cb5v5nACw` with context
`cx_ohHUg7aEC68ToKvXqpkqDA`. Every handle is new, and no two calls share one:
they are minted per task, not derived from anything the client sent.

## 14. tools/call, a2a_send_message with a taskHandle, typed A2A error

```json
{
  "method": "tools/call",
  "params": {
    "name": "a2a_send_message",
    "arguments": {
      "agent": "fixture",
      "text": "blue",
      "taskHandle": "tk_oOaubwnGk8su_cb5v5nACw"
    },
    "_meta": { "...envelope, progressToken: 9..." }
  },
  "jsonrpc": "2.0",
  "id": 9
}
```

Response, HTTP 200:

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "A2A SendMessage on agent \"fixture\" failed: Task 01901d79-d889-436c-8f0a-56d61cca46c2 is in a terminal state (5) and cannot be modified."
      }
    ],
    "structuredContent": {
      "error": "A2A SendMessage on agent \"fixture\" failed: Task 01901d79-d889-436c-8f0a-56d61cca46c2 is in a terminal state (5) and cannot be modified.",
      "a2aErrorCode": -32004,
      "a2aReason": "UNSUPPORTED_OPERATION"
    },
    "isError": true,
    "resultType": "complete",
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "a2a-to-mcp", "version": "0.1.0" } }
  },
  "jsonrpc": "2.0",
  "id": 9
}
```

Having run out of elicitation, the model fell back to the other mechanism the
tool offers, the `taskHandle` path, and sent "blue" to the task it had just
cancelled. This is the failure branch, and it is the most instructive exchange
in the trace. The typed A2A error `-32004 UNSUPPORTED_OPERATION` is reported as
a tool execution error, `isError: true` with the code in `structuredContent`,
and the HTTP status stays 200 with a well formed JSON-RPC `result`. The bridge
did not re-emit `-32004` as a JSON-RPC error code, which is the rule it states:
the MCP range `-32000` to `-32019` is implementation defined and the two
vocabularies would collide.

Note the leak this exchange does show: the agent phrases its own error with its
A2A task id, `01901d79-...`, and the bridge passes the agent text through
unedited. Handles hide the bridge mapping, not what an agent chooses to say.

## 15 and 16. notifications/cancelled, subscriptions/listen

Exchange 15 cancels `listen:1` and gets HTTP 202 with an empty body. Exchange 16
opens `listen:2`, which is closed by the client when the process exits, and is
recorded as aborted. Both carry the same per request envelope as everything
else.

## Appendix, exchanges 17 and 18: the accepted answer

Claude Code in headless mode can only cancel an elicitation. To show the other
branch of the same code path on the same running bridge, a minimal client of
about forty lines, no SDK, declaring `clientCapabilities: {"elicitation": {}}`
and nothing else, made the same two calls and answered. It is in
`accept-client.mjs` next to this trace.

Exchange 17, `a2a_send_message` with `{"agent": "fixture", "text": "ask: colour"}`,
answered with the same `resultType: "input_required"`, the same
`elicitation/create` message and schema, and a `requestState` sealing
`tk_2--364Krp-uwAN7JIf7tEg`.

Exchange 18, the replay:

```json
{
  "method": "tools/call",
  "params": {
    "name": "a2a_send_message",
    "arguments": { "agent": "fixture", "text": "ask: colour" },
    "inputResponses": { "answer": { "action": "accept", "content": { "answer": "blue" } } },
    "requestState": "v1.eyJwIjp7ImFsaWFzIjoiZml4dHVyZSIsInRhc2tIYW5kbGUiOiJ0a18yLS0zNjRLcnAtdXdBTjdKSWY3dEVnIn0sImV4cCI6MTc4ODY2NzQzNX0...",
    "_meta": { "io.modelcontextprotocol/clientCapabilities": { "elicitation": {} }, "...": "" }
  },
  "jsonrpc": "2.0",
  "id": 2
}
```

Response, HTTP 200:

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "colour = blue",
        "_meta": {
          "io.github.amirk-s/a2a": {
            "partKind": "text",
            "mediaType": "text/plain",
            "artifactId": "961d5614-42bf-480f-ac8d-b09bcc0333bd",
            "artifactName": "result"
          }
        }
      }
    ],
    "structuredContent": {
      "kind": "task",
      "contextHandle": "cx_OxbPn4dTn5aphvMI2mB64w",
      "taskHandle": "tk_2--364Krp-uwAN7JIf7tEg",
      "a2aState": "TASK_STATE_COMPLETED",
      "status": "completed",
      "artifacts": [ { "artifactId": "961d5614-42bf-480f-ac8d-b09bcc0333bd", "name": "result" } ]
    },
    "resultType": "complete",
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "a2a-to-mcp", "version": "0.1.0" } }
  },
  "jsonrpc": "2.0",
  "id": 2
}
```

The answer travelled to the agent on the same A2A task, the task completed, and
the artifact says `colour = blue`. Same handle across both rounds, no session,
no server side conversation. This is the branch a client with a user in front of
it takes, and it is the same code the Claude Code run exercised up to the
`action` field.

## What Claude Code answered

Verbatim, the `result` field of the JSON output:

> **1. Fixture Agent Discovery:**
> Fixture Agent with skills: Echo (direct message), Long task (multi-state), Ask for input (INPUT_REQUIRED), Terminal outcomes (REJECTED/FAILED/AUTH_REQUIRED), Non-text parts (artifacts).
>
> **2. 'task: hello world' response:**
> Returned as a task (state: TASK_STATE_COMPLETED) with contextHandle `cx_ecQUpy0G8MSvoZh7OrXMAA` and taskHandle `tk_15bH3peuqnWpk2iQJNDdOg`.
>
> **3. 'ask: colour' response:**
> Returned a task with taskHandle `tk_oOaubwnGk8su_cb5v5nACw`, but it was already in TASK_STATE_CANCELED (a terminal state). When attempting to answer with 'blue' using the taskHandle, the agent returned an error: "Task is in a terminal state (5) and cannot be modified." The task could not accept the response because it was already closed.

The run is `"is_error": false`, `"num_turns": 1`, `"permission_denials": []`.
The model missed one thing worth naming: it reported that the task came back
already cancelled, when in fact its own client cancelled it, silently, one
exchange earlier. The elicitation is invisible to the model, which is the point
of the mechanism and also its blind spot in a headless run.

## What this trace does not show

- **The tasks extension.** No exchange here carries
  `io.modelcontextprotocol/tasks` in `clientCapabilities.extensions`, so the
  bridge never returned a `CreateTaskResult` and no `tasks/get`, `tasks/update`
  or `tasks/cancel` appears. That is not a gap in the bridge: it serves the
  extension, and advertises it in exchange 1. It is that as of 2026-09-06 neither
  of the two clients measured against this bridge, Claude Code and Cursor,
  declares the extension. The extension is
  exercised check by check against the wire in
  `test/integration/tasks-extension.test.ts`.
- **The legacy route.** Claude Code 2.1.263 negotiates `2026-07-28` and never
  falls back, so no `initialize` appears anywhere. The legacy route lives on the
  same endpoint and is covered by the test suite and by the conformance run.
- **`a2a_get_task` and `a2a_cancel_task`.** Both were allowed on the command
  line and neither was called in this run: the model had no reason to. An
  earlier run of the same prompt did call `a2a_get_task` twice, and its results
  are ordinary envelopes with a `history` array added.
- **The other part kinds.** Only text parts crossed here. Data parts, url file
  parts and raw bytes are what the fixture `data`, `file` and `image` commands
  exist for.
- **Anything on the A2A side of the bridge.** The proxy sits between the client
  and the bridge only. What the bridge said to the agent over JSON-RPC on port
  41241 is not in this file.

Raw material for all of the above: `trace.jsonl`, one JSON object per exchange
with full headers and bodies, the Claude Code JSON output, the proxy and the
appendix client.
