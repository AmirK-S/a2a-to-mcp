# Real usage

The bridge has been run against a public A2A agent that nobody here controls.
This page records that run: what was asked, what came back, what broke.

## The agent

Finding one took longer than running the bridge against it. Nineteen public
agent card URLs are listed in the two community indexes, `ai-boost/awesome-a2a`
and `sing1ee/a2a-directory`. Each was fetched with
`curl -sS -m 10 -H "A2A-Version: 1.0"`. On 2026-09-06 the count was:

- 2 unreachable,
- 8 serving a v0.3 card, or a card with no protocol version at all,
- 9 declaring v1.0, of which 5 sit behind an API key, a bearer token or OAuth2,
- 4 declaring v1.0 with no authentication.

Of those last four, one answered a v1.0 `message/send`. One in nineteen.

Of the other three: two declare `protocolVersion: "1.0"` in the card and then
refuse the call, one with `-32009` "A2A protocol version is not supported for
this method", one with `-32601` "Method not found". A v1.0 card is not a
promise of a v1.0 server.

The one that answered is the **Kinocut Public Guide** at
`https://kinocut.dev/a2a/v1`, a read-only documentation agent for the
open-source video-editing MCP server of the same name. Its card is a genuine
v1.0 card: `supportedInterfaces[0]` with `protocolBinding: "JSONRPC"` and
`protocolVersion: "1.0"`, empty `securitySchemes`, no streaming. Its replies
carry the v1.0 wire shape, `role: "ROLE_AGENT"` and parts keyed by `mediaType`
with no `kind` discriminator.

## The run

Date: 2026-09-06. Built from a clean worktree, `npm ci && npm run build`.

```json
{
  "agents": {
    "kinocut": { "cardUrl": "https://kinocut.dev/.well-known/agent-card.json" }
  },
  "port": 8934
}
```

```sh
node dist/cli.js --config usage-config.json --port 8934
```

Four exchanges, every one HTTP 200, sent with `MCP-Protocol-Version:
2026-07-28`, `Mcp-Method`, `Mcp-Name`, and the `_meta` envelope carrying
`io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities`.

**`server/discover`** returned `supportedVersions: ["2026-07-28"]`, the
`io.modelcontextprotocol/tasks` extension, and instructions naming the
configured alias.

**`a2a_discover`** read the remote card and returned it in
`structuredContent` with a text summary and all three skills.
`_meta` carried `{"cardUrl": ..., "a2aVersion": "1.0"}`.

**`a2a_send_message`** with "How do I connect Kinocut to Claude Code?" returned
the agent reply and `{"kind": "message", "contextHandle": "cx_..."}`. The part
`_meta` carried `partKind`, `mediaType`, `messageId` and `contextId`.

**`a2a_send_message` again**, with that `contextHandle` and with the `agent`
argument omitted, came back on the same remote `contextId`. Both the
single-agent alias default and context continuity hold against a real remote
agent.

No task was opened. This agent is read-only and replies with `message`, never
with `task`, so `a2a_get_task` could not be exercised on a live task. Called
with an identifier that was never minted, it returns `isError: true` and
`Unknown handle "tk_does_not_exist": it was never minted, or it was deleted.`

## What broke

One thing, and on the calling side.

The first `a2a_send_message` was sent with an argument named `message`. It was
rejected:

```
-32602 Invalid arguments for tool a2a_send_message:
text: Invalid input: expected string, received undefined
```

The argument is `text`. The error is already precise, it names the field and
the expected type, and `tools/list` carries the exact schema. Nothing in the
code needs fixing. What was missing is documentation: the README shows the
configuration but no example `tools/call` payload. One example call per tool
would have saved the round trip. That is the fix still to make.

Nothing else broke, and nothing was changed in the bridge for this run.

## v0.3 agents, for the record

A second bridge was run on port 8935 with two public v0.3 agents that need no
authentication. `a2a_discover` on each returns `isError: true`:

```
Cannot use the agent card of "..." at ...: supportedInterfaces must be a
non-empty array. A v0.3 card with url and preferredTransport is not an A2A v1.0
card.
```

The refusal happens while reading the card, not on the wire. The bridge never
sends a v1.0 request to a 0.3 server, so the `-32009` that a 0.3 server would
raise never happens. The card is enough to decide, and the message says why.

## Other client measurements

This page covers curl against the bridge. Two client measurements sit
elsewhere.

[`docs/DEMO-CLAUDE-CODE.md`](DEMO-CLAUDE-CODE.md) is a full annotated trace of a
Claude Code session: `server/discover` negotiating `2026-07-28`, a task with an
artifact, and an elicitation round trip.

Cursor is the second client measured: binary 3.19.13, ceiling `2025-11-25`,
served through `initialize` on the same endpoint. Its `.cursor/mcp.json` needs
the `type: "http"` key, which its own documentation does not mention.
