# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and the project follows Semantic Versioning.

## [Unreleased]

## [0.1.0] - 2026-09-06

First release. Targets A2A v1.0.1 and MCP 2026-07-28, with the 2025-11-25 route served on the same endpoint.

### Added

- `server/discover` announcing `2026-07-28` and the `io.modelcontextprotocol/tasks` extension; `initialize` for `2025-11-25` clients.
- Four tools: `a2a_discover`, `a2a_send_message`, `a2a_get_task`, `a2a_cancel_task`, with opaque task and context handles that expire.
- `agent` is optional when exactly one agent is configured: the tool schema carries that alias as its default. With two or more it stays required.
- Tasks extension on the modern route: `CreateTaskResult` from `a2a_send_message`, `tasks/get`, `tasks/update`, `tasks/cancel`, fed by `SendStreamingMessage` or `GetTask`.
- Multi-round-trip for clients that declare `elicitation`: an A2A `INPUT_REQUIRED` becomes one form elicitation and the replay answers the same A2A task.
- Translation of the four part kinds, of artifacts, of the nine task states and of the nine typed A2A errors, with every loss reported.
- DNS rebinding protection through `Host` and `Origin` validation, loopback by default, `allowedHosts` in the configuration.
- Configuration file, validated field by field, with dotted paths in the error messages.
- Deterministic A2A fixture agent, integration tests against the official `helloworld` sample, official MCP conformance suite with a justified baseline.

### Known limitations

- No authentication on either side.
- As of 2026-09-06, the two clients measured against this bridge, Claude Code and Cursor, do not declare the extension; it is exercised by the test suite and by any client that opts in per request.
- Two workarounds for the reference SDK are in place, see the README and `docs/END-OF-LIFE.md`.

[Unreleased]: https://github.com/AmirK-S/a2a-to-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AmirK-S/a2a-to-mcp/releases/tag/v0.1.0
