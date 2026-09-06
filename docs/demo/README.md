# Raw material for `../DEMO-CLAUDE-CODE.md`

`trace.jsonl` is the capture the document transcribes, one JSON object per exchange with full headers and bodies, all 18 of them since the proxy logged the appendix client too; `trace-accept-client.jsonl` is that client's own log of its two calls, request and raw response, without headers.

`trace-proxy.mjs` is the logging reverse proxy that wrote them, 127.0.0.1:8932 in front of the bridge on 8931; `accept-client.mjs` is the forty-line appendix client, no SDK, which declares `clientCapabilities: {"elicitation": {}}` and accepts the question with "blue" (it writes `trace-accept.jsonl`, renamed here to say which client produced it).

`agents.json` is the bridge configuration used, one agent named `fixture`; `mcp-config.json` is the `.mcp.json` given to Claude Code; `claude-output.json` is the `claude -p --output-format json` result of the session.

Nothing was rewritten: the files are byte for byte what the run produced. They carry no absolute path, no credential and no character outside printable ASCII, so no em dash had to be normalised in the model text of `claude-output.json`.
