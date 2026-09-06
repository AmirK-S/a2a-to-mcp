# Conformance report

Produced by `npm run conformance`, which replays the official MCP conformance suite against the bridge and then aggregates the per-scenario `checks.json` files the suite leaves behind. Do not edit by hand.

Generated: 2026-09-06T05:11:16.389Z

## Command and versions

| Item | Value |
| --- | --- |
| Suite | `@modelcontextprotocol/conformance@0.2.0-alpha.11` |
| Node | v26.4.0 |
| Bridge endpoint | `http://127.0.0.1:52213/mcp` |
| Baseline | `conformance/baseline.yml` |
| Command, 2026-07-28 | `npx -y @modelcontextprotocol/conformance@0.2.0-alpha.11 server --url http://127.0.0.1:<port>/mcp --requirements 2026-07-28 -o conformance/results/2026-07-28 --expected-failures conformance/baseline.yml` |
| Command, 2025-11-25 | `npx -y @modelcontextprotocol/conformance@0.2.0-alpha.11 server --url http://127.0.0.1:<port>/mcp --requirements 2025-11-25 -o conformance/results/2025-11-25 --expected-failures conformance/baseline.yml` |

## Totals

| Requirement set | Scenarios | Scored | Checks passed | Checks failed | Warnings | Unbaselined failures | Exit code |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `2026-07-28` | 50 | 37 | 101 | 67 | 5 | 0 | 0 |
| `2025-11-25` | 33 | 30 | 35 | 26 | 4 | 0 | 0 |

Checks failed counts every FAILURE the suite wrote, baselined or not. The exit code is the suite's verdict once the baseline is applied: 0 means every failing check of a scored scenario has an entry, and no entry has gone stale.

## What the suite proved

| Check | Revisions | What it settles |
| --- | --- | --- |
| `wire-schema-valid` | 2025-11-25, 2026-07-28 | every message the bridge emits validates against the JSON schema of the revision, `resultType` included |
| `sep-2575-server-implements-discover` | 2026-07-28 | `server/discover` answers on the stateless wire |
| `sep-2575-discover-capabilities-match-handlers` | 2026-07-28 | the capabilities announced in `server/discover` match the handlers actually mounted |
| `localhost-host-rebinding-rejected` | 2025-11-25, 2026-07-28 | a foreign `Host` or `Origin` header is refused with HTTP 4xx (DNS rebinding protection) |
| `sep-2243-server-reject-invalid-headers` | 2026-07-28 | SEP-2243 header validation rejects malformed `Mcp-Method` and `Mcp-Name` |
| `sep-2243-header-name-case-insensitive` | 2026-07-28 | header names are matched case insensitively |
| `sep-2575-server-sends-subscription-ack` | 2026-07-28 | `subscriptions/listen` is acknowledged and tagged with its subscription id |

Scenarios with no failing check at all:

- `tools-list`, fully green on 2026-07-28 and 2025-11-25: the four bridge tools are listed and well-formed.
- `http-header-validation`, fully green on 2026-07-28: the SEP-2243 header rejections.
- `dns-rebinding-protection`, fully green on 2026-07-28 and 2025-11-25: Host and Origin validation.
- `server-initialize`, fully green on 2025-11-25: the legacy initialize handshake.
- `server-session-lifecycle`, no check executed on 2025-11-25: the legacy session lifecycle was not measured.

## What the suite could not test

A green total would be a lie here, and so would a red one. These scenarios never reached the requirement they state, for the reason given.

**capability-not-declared.** The bridge declares neither `prompts`, nor `resources`, nor `completions`, nor `logging`, and answers -32601 to them. The answer is correct, and `sep-2575-discover-capabilities-match-handlers` proves it consistent, but the scenario has nothing to measure.

- `caching:sep-2549-prompts-list-caching-hints` (2026-07-28): Reads caching hints off prompts/list, which is -32601 for want of a declared prompts capability.
- `caching:sep-2549-resources-list-caching-hints` (2026-07-28): Reads caching hints off resources/list, which is -32601 for want of a declared resources capability.
- `caching:sep-2549-resources-templates-list-caching-hints` (2026-07-28): Reads caching hints off resources/templates/list, which is -32601 for want of a declared resources capability.
- `completion-complete:completion-complete` (2025-11-25, 2026-07-28): The bridge declares no completions capability and answers -32601 to completion/complete.
- `input-required-result-non-tool-request:sep-2322-non-tool-incomplete` (2026-07-28): Probes prompts/get, which the bridge does not declare and answers -32601.
- `logging-set-level:logging-set-level` (2025-11-25): The bridge declares no logging capability, so the legacy logging/setLevel is -32601.
- `prompts-get-embedded-resource:prompts-get-embedded-resource` (2025-11-25, 2026-07-28): The bridge declares no prompts capability and answers -32601 to prompts/get.
- `prompts-get-simple:prompts-get-simple` (2025-11-25, 2026-07-28): The bridge declares no prompts capability and answers -32601 to prompts/get.
- `prompts-get-with-args:prompts-get-with-args` (2025-11-25, 2026-07-28): The bridge declares no prompts capability and answers -32601 to prompts/get.
- `prompts-get-with-image:prompts-get-with-image` (2025-11-25, 2026-07-28): The bridge declares no prompts capability and answers -32601 to prompts/get.
- `prompts-list:prompts-list` (2025-11-25, 2026-07-28): The bridge declares no prompts capability and answers -32601 to prompts/list.
- `resources-list:resources-list` (2025-11-25, 2026-07-28): The bridge declares no resources capability and answers -32601 to resources/list.
- `resources-read-binary:resources-read-binary` (2025-11-25, 2026-07-28): The bridge declares no resources capability and answers -32601 to resources/read.
- `resources-read-text:resources-read-text` (2025-11-25, 2026-07-28): The bridge declares no resources capability and answers -32601 to resources/read.
- `resources-subscribe:resources-subscribe` (2025-11-25): The bridge declares no resources capability, so the legacy resources/subscribe is -32601.
- `resources-templates-read:resources-templates-read` (2025-11-25, 2026-07-28): The bridge declares no resources capability and answers -32601 to resources/templates/list.
- `resources-unsubscribe:resources-unsubscribe` (2025-11-25): The bridge declares no resources capability, so the legacy resources/unsubscribe is -32601.
- `sep-2164-resource-not-found:sep-2164-data-uri` (2026-07-28): Same -32601: with no resources handler there is no error data.uri to carry the requested resource.
- `sep-2164-resource-not-found:sep-2164-error-code` (2026-07-28): The undeclared resources capability makes resources/read -32601, so the scenario never reaches the -32602 it wants to grade.

**extension-not-applicable.** An extension scenario, never scored, and built on the same hard-coded fixture tools.

- `tasks-capability-negotiation` (2026-07-28): Extension scenario driving slow_compute, a fixture tool of the suite that the bridge does not expose.
- `tasks-dispatch-and-envelope` (2026-07-28): Extension scenario driving greet, slow_compute and failing_job, fixture tools of the suite that the bridge does not expose.
- `tasks-lifecycle` (2026-07-28): Extension scenario driving greet, slow_compute, failing_job and protocol_error_job, four fixture tools of the suite that the bridge does not expose.
- `tasks-mrtr-composition` (2026-07-28): Extension scenario driving test_tool_with_task, a fixture tool of the suite that the bridge does not expose.
- `tasks-mrtr-input` (2026-07-28): Extension scenario driving confirm_delete and multi_input, fixture tools of the suite that the bridge does not expose.
- `tasks-request-headers` (2026-07-28): Extension scenario driving greet and slow_compute, fixture tools of the suite that the bridge does not expose.
- `tasks-request-state-removal` (2026-07-28): Extension scenario driving slow_compute, a fixture tool of the suite that the bridge does not expose.
- `tasks-required-task-error` (2026-07-28): Extension scenario whose -32021 grading is reached through failing_job, a fixture tool of the suite that the bridge does not expose.
- `tasks-wire-fields` (2026-07-28): Extension scenario driving slow_compute, a fixture tool of the suite that the bridge does not expose.

**fixture-tools-absent.** The scenario calls a tool name written into the suite. A bridge exposes the tools of the agents it fronts, so the call cannot resolve and the requirement is never exercised.

- `elicitation-sep1034-defaults:elicitation-sep1034-general` (2025-11-25): Needs a fixture tool that elicits with SEP-1034 defaults, which the bridge does not expose.
- `elicitation-sep1330-enums:elicitation-sep1330-general` (2025-11-25): Needs a fixture tool that elicits with SEP-1330 enums, which the bridge does not expose.
- `http-custom-header-server-validation` (2026-07-28): All five checks report untestable: the suite needs a tool carrying x-mcp-header annotations, which the bridge does not expose.
- `input-required-result-basic-elicitation:sep-2322-elicitation-incomplete` (2026-07-28): Calls test_input_required_result_elicitation, a fixture tool of the suite that the bridge does not expose.
- `input-required-result-basic-list-roots:sep-2322-list-roots-incomplete` (2026-07-28): Calls test_input_required_result_list_roots, a fixture tool of the suite that the bridge does not expose.
- `input-required-result-basic-sampling:sep-2322-sampling-incomplete` (2026-07-28): Calls test_input_required_result_sampling, a fixture tool of the suite that the bridge does not expose.
- `input-required-result-capability-check:sep-2322-respect-client-capabilities` (2026-07-28): Calls test_input_required_result_capabilities, a fixture tool of the suite that the bridge does not expose.
- `input-required-result-ignore-extra-params:sep-2322-ignore-unexpected-params` (2026-07-28): Warns because the extra-params probe targets a fixture tool the bridge does not expose, so the SHOULD is never exercised.
- `input-required-result-missing-input-response:sep-2322-missing-response-rerequests` (2026-07-28): Warns because the re-request probe targets a fixture tool the bridge does not expose, so the SHOULD is never exercised.
- `input-required-result-multi-round:sep-2322-multi-round-r1` (2026-07-28): Expects an InputRequiredResult from a fixture tool of the suite that the bridge does not expose.
- `input-required-result-multiple-input-requests:sep-2322-multiple-inputs-incomplete` (2026-07-28): Calls test_input_required_result_multiple_inputs, a fixture tool of the suite that the bridge does not expose.
- `input-required-result-request-state:sep-2322-request-state-incomplete` (2026-07-28): Calls test_input_required_result_request_state, a fixture tool of the suite that the bridge does not expose.
- `input-required-result-result-type:sep-2322-result-type-included` (2026-07-28): Reads resultType off the answer of a fixture tool of the suite that the bridge does not expose.
- `input-required-result-tampered-state:sep-2322-reject-tampered-state` (2026-07-28): Its prerequisite is an InputRequiredResult from a fixture tool the bridge does not expose, so the tamper is never attempted.
- `json-schema-2020-12:json-schema-2020-12-tool-found` (2025-11-25, 2026-07-28): Looks for json_schema_2020_12_tool, a fixture tool of the suite that the bridge does not expose.
- `server-stateless:sep-2575-http-server-no-independent-requests-on-stream` (2026-07-28): Reported untestable: needs test_streaming_elicitation to open a response stream, which the bridge does not expose.
- `server-stateless:sep-2575-missing-capability-http-400` (2026-07-28): Reported untestable: the -32021 HTTP status needs test_missing_capability, which the bridge does not expose.
- `server-stateless:sep-2575-server-no-log-without-loglevel` (2026-07-28): Reported untestable: needs test_logging_tool to emit a log, which the bridge does not expose.
- `server-stateless:sep-2575-server-rejects-undeclared-capability` (2026-07-28): Reported untestable: needs the diagnostic tool test_missing_capability, which the bridge does not expose.
- `server-stateless:sep-2575-server-sends-tools-list-changed-on-subscription` (2026-07-28): Mutating the tool list goes through test_trigger_tool_change, which the bridge does not expose, so no mutation happened and the missing notification proves nothing.
- `tools-call-audio:tools-call-audio` (2025-11-25, 2026-07-28): Calls test_audio_content, a fixture tool of the suite that the bridge does not expose.
- `tools-call-elicitation:tools-call-elicitation` (2025-11-25): Calls test_elicitation on the legacy wire, a fixture tool of the suite that the bridge does not expose.
- `tools-call-embedded-resource:tools-call-embedded-resource` (2025-11-25, 2026-07-28): Calls test_embedded_resource, a fixture tool of the suite that the bridge does not expose.
- `tools-call-error:tools-call-error` (2025-11-25, 2026-07-28): Calls test_error_handling, a fixture tool of the suite that the bridge does not expose.
- `tools-call-image:tools-call-image` (2025-11-25, 2026-07-28): Calls test_image_content, a fixture tool of the suite that the bridge does not expose.
- `tools-call-mixed-content:tools-call-mixed-content` (2025-11-25, 2026-07-28): Calls test_multiple_content_types, a fixture tool of the suite that the bridge does not expose.
- `tools-call-sampling:tools-call-sampling` (2025-11-25): Calls test_sampling on the legacy wire, a fixture tool of the suite that the bridge does not expose.
- `tools-call-simple-text:tools-call-simple-text` (2025-11-25, 2026-07-28): Calls test_simple_text, a fixture tool of the suite that the bridge does not expose.
- `tools-call-with-logging:tools-call-with-logging` (2025-11-25): Calls test_logging_tool on the legacy wire, a fixture tool of the suite that the bridge does not expose.
- `tools-call-with-progress:tools-call-with-progress` (2025-11-25, 2026-07-28): Calls test_tool_with_progress, a fixture tool of the suite that the bridge does not expose.

**legacy-stateless-by-design.** The 2025-11-25 route is served statelessly by the SDK (legacy: stateless), so no Mcp-Session-Id is issued and a SHOULD-level check that needs a session reports a warning. The bridge holds no session on purpose.

- `server-sse-multiple-streams:server-sse-multiple-streams-session` (2025-11-25): The SDK serves the 2025-11-25 route without a session (legacy: stateless), so the SHOULD-level check that opens several SSE streams on one session warns; the bridge issues no Mcp-Session-Id on purpose.

## Failures not covered by the baseline

None. Every failing check of a scored scenario is covered by an entry of `conformance/baseline.yml`, so both runs exit 0.

## Run `2026-07-28`, scenario by scenario

| Scenario | Scoring | Result | Baseline entry |
| --- | --- | --- | --- |
| `caching` | scored | baselined, 4 passed, 3 failed, 1 skipped | `caching:sep-2549-prompts-list-caching-hints` (capability-not-declared), `caching:sep-2549-resources-list-caching-hints` (capability-not-declared), `caching:sep-2549-resources-templates-list-caching-hints` (capability-not-declared) |
| `completion-complete` | scored | baselined, 1 passed, 1 failed | `completion-complete:completion-complete` (capability-not-declared) |
| `dns-rebinding-protection` | scored | green, 2 passed, 0 failed |  |
| `http-custom-header-server-validation` | not scored (pending) | baselined, 1 passed, 5 failed | `http-custom-header-server-validation` (fixture-tools-absent) |
| `http-header-validation` | not scored (pending) | green, 14 passed, 0 failed |  |
| `input-required-result-basic-elicitation` | scored | baselined, 1 passed, 1 failed | `input-required-result-basic-elicitation:sep-2322-elicitation-incomplete` (fixture-tools-absent) |
| `input-required-result-basic-list-roots` | scored | baselined, 1 passed, 1 failed | `input-required-result-basic-list-roots:sep-2322-list-roots-incomplete` (fixture-tools-absent) |
| `input-required-result-basic-sampling` | scored | baselined, 1 passed, 1 failed | `input-required-result-basic-sampling:sep-2322-sampling-incomplete` (fixture-tools-absent) |
| `input-required-result-capability-check` | scored | baselined, 1 passed, 1 failed | `input-required-result-capability-check:sep-2322-respect-client-capabilities` (fixture-tools-absent) |
| `input-required-result-ignore-extra-params` | scored | baselined, 1 passed, 0 failed, 1 warning | `input-required-result-ignore-extra-params:sep-2322-ignore-unexpected-params` (fixture-tools-absent) |
| `input-required-result-missing-input-response` | scored | baselined, 1 passed, 0 failed, 1 warning | `input-required-result-missing-input-response:sep-2322-missing-response-rerequests` (fixture-tools-absent) |
| `input-required-result-multi-round` | scored | baselined, 1 passed, 1 failed | `input-required-result-multi-round:sep-2322-multi-round-r1` (fixture-tools-absent) |
| `input-required-result-multiple-input-requests` | scored | baselined, 1 passed, 1 failed | `input-required-result-multiple-input-requests:sep-2322-multiple-inputs-incomplete` (fixture-tools-absent) |
| `input-required-result-non-tool-request` | scored | baselined, 1 passed, 1 failed | `input-required-result-non-tool-request:sep-2322-non-tool-incomplete` (capability-not-declared) |
| `input-required-result-request-state` | scored | baselined, 1 passed, 1 failed | `input-required-result-request-state:sep-2322-request-state-incomplete` (fixture-tools-absent) |
| `input-required-result-result-type` | scored | baselined, 1 passed, 1 failed | `input-required-result-result-type:sep-2322-result-type-included` (fixture-tools-absent) |
| `input-required-result-tampered-state` | scored | baselined, 1 passed, 1 failed | `input-required-result-tampered-state:sep-2322-reject-tampered-state` (fixture-tools-absent) |
| `input-required-result-unsupported-methods` | scored | green, 2 passed, 0 failed |  |
| `input-required-result-validate-input` | scored | green, 3 passed, 0 failed |  |
| `json-schema-2020-12` | not scored (pending) | baselined, 1 passed, 1 failed | `json-schema-2020-12:json-schema-2020-12-tool-found` (fixture-tools-absent) |
| `prompts-get-embedded-resource` | scored | baselined, 1 passed, 1 failed | `prompts-get-embedded-resource:prompts-get-embedded-resource` (capability-not-declared) |
| `prompts-get-simple` | scored | baselined, 1 passed, 1 failed | `prompts-get-simple:prompts-get-simple` (capability-not-declared) |
| `prompts-get-with-args` | scored | baselined, 1 passed, 1 failed | `prompts-get-with-args:prompts-get-with-args` (capability-not-declared) |
| `prompts-get-with-image` | scored | baselined, 1 passed, 1 failed | `prompts-get-with-image:prompts-get-with-image` (capability-not-declared) |
| `prompts-list` | scored | baselined, 1 passed, 1 failed | `prompts-list:prompts-list` (capability-not-declared) |
| `resources-list` | scored | baselined, 1 passed, 1 failed | `resources-list:resources-list` (capability-not-declared) |
| `resources-read-binary` | scored | baselined, 1 passed, 1 failed | `resources-read-binary:resources-read-binary` (capability-not-declared) |
| `resources-read-text` | scored | baselined, 1 passed, 1 failed | `resources-read-text:resources-read-text` (capability-not-declared) |
| `resources-templates-read` | scored | baselined, 1 passed, 1 failed | `resources-templates-read:resources-templates-read` (capability-not-declared) |
| `sep-2164-resource-not-found` | scored | baselined, 2 passed, 0 failed, 2 warning | `sep-2164-resource-not-found:sep-2164-error-code` (capability-not-declared), `sep-2164-resource-not-found:sep-2164-data-uri` (capability-not-declared) |
| `server-sse-multiple-streams` | scored | green, 1 passed, 0 failed |  |
| `server-stateless` | scored | baselined, 24 passed, 4 failed, 1 warning, 1 skipped | `server-stateless:sep-2575-server-rejects-undeclared-capability` (fixture-tools-absent), `server-stateless:sep-2575-missing-capability-http-400` (fixture-tools-absent), `server-stateless:sep-2575-http-server-no-independent-requests-on-stream` (fixture-tools-absent), `server-stateless:sep-2575-server-no-log-without-loglevel` (fixture-tools-absent), `server-stateless:sep-2575-server-sends-tools-list-changed-on-subscription` (fixture-tools-absent) |
| `tasks-capability-negotiation` | not scored (extension) | baselined, 3 passed, 2 failed | `tasks-capability-negotiation` (extension-not-applicable) |
| `tasks-dispatch-and-envelope` | not scored (extension) | baselined, 4 passed, 5 failed | `tasks-dispatch-and-envelope` (extension-not-applicable) |
| `tasks-lifecycle` | not scored (extension) | baselined, 1 passed, 8 failed | `tasks-lifecycle` (extension-not-applicable) |
| `tasks-mrtr-composition` | not scored (extension) | baselined, 1 passed, 1 failed | `tasks-mrtr-composition` (extension-not-applicable) |
| `tasks-mrtr-input` | not scored (extension) | baselined, 1 passed, 3 failed | `tasks-mrtr-input` (extension-not-applicable) |
| `tasks-request-headers` | not scored (extension) | baselined, 2 passed, 3 failed | `tasks-request-headers` (extension-not-applicable) |
| `tasks-request-state-removal` | not scored (extension) | baselined, 1 passed, 1 failed | `tasks-request-state-removal` (extension-not-applicable) |
| `tasks-required-task-error` | not scored (extension) | baselined, 1 passed, 1 failed | `tasks-required-task-error` (extension-not-applicable) |
| `tasks-status-notifications` | not scored (extension) | green, 0 passed, 0 failed, 1 skipped |  |
| `tasks-wire-fields` | not scored (extension) | baselined, 1 passed, 3 failed | `tasks-wire-fields` (extension-not-applicable) |
| `tools-call-audio` | scored | baselined, 1 passed, 1 failed | `tools-call-audio:tools-call-audio` (fixture-tools-absent) |
| `tools-call-embedded-resource` | scored | baselined, 1 passed, 1 failed | `tools-call-embedded-resource:tools-call-embedded-resource` (fixture-tools-absent) |
| `tools-call-error` | scored | baselined, 1 passed, 1 failed | `tools-call-error:tools-call-error` (fixture-tools-absent) |
| `tools-call-image` | scored | baselined, 1 passed, 1 failed | `tools-call-image:tools-call-image` (fixture-tools-absent) |
| `tools-call-mixed-content` | scored | baselined, 1 passed, 1 failed | `tools-call-mixed-content:tools-call-mixed-content` (fixture-tools-absent) |
| `tools-call-simple-text` | scored | baselined, 1 passed, 1 failed | `tools-call-simple-text:tools-call-simple-text` (fixture-tools-absent) |
| `tools-call-with-progress` | scored | baselined, 1 passed, 1 failed | `tools-call-with-progress:tools-call-with-progress` (fixture-tools-absent) |
| `tools-list` | scored | green, 3 passed, 0 failed |  |

Baselined failing checks: 72, warnings included, which the baseline treats like failures. Unbaselined: 0.

## Run `2025-11-25`, scenario by scenario

| Scenario | Scoring | Result | Baseline entry |
| --- | --- | --- | --- |
| `completion-complete` | scored | baselined, 1 passed, 1 failed | `completion-complete:completion-complete` (capability-not-declared) |
| `dns-rebinding-protection` | scored | green, 2 passed, 0 failed |  |
| `elicitation-sep1034-defaults` | scored | baselined, 1 passed, 1 failed | `elicitation-sep1034-defaults:elicitation-sep1034-general` (fixture-tools-absent) |
| `elicitation-sep1330-enums` | scored | baselined, 1 passed, 1 failed | `elicitation-sep1330-enums:elicitation-sep1330-general` (fixture-tools-absent) |
| `json-schema-2020-12` | not scored (pending) | baselined, 1 passed, 1 failed | `json-schema-2020-12:json-schema-2020-12-tool-found` (fixture-tools-absent) |
| `logging-set-level` | scored | baselined, 1 passed, 1 failed | `logging-set-level:logging-set-level` (capability-not-declared) |
| `ping` | scored | green, 2 passed, 0 failed |  |
| `prompts-get-embedded-resource` | scored | baselined, 1 passed, 1 failed | `prompts-get-embedded-resource:prompts-get-embedded-resource` (capability-not-declared) |
| `prompts-get-simple` | scored | baselined, 1 passed, 1 failed | `prompts-get-simple:prompts-get-simple` (capability-not-declared) |
| `prompts-get-with-args` | scored | baselined, 1 passed, 1 failed | `prompts-get-with-args:prompts-get-with-args` (capability-not-declared) |
| `prompts-get-with-image` | scored | baselined, 1 passed, 1 failed | `prompts-get-with-image:prompts-get-with-image` (capability-not-declared) |
| `prompts-list` | scored | baselined, 1 passed, 1 failed | `prompts-list:prompts-list` (capability-not-declared) |
| `resources-list` | scored | baselined, 1 passed, 1 failed | `resources-list:resources-list` (capability-not-declared) |
| `resources-read-binary` | scored | baselined, 1 passed, 1 failed | `resources-read-binary:resources-read-binary` (capability-not-declared) |
| `resources-read-text` | scored | baselined, 1 passed, 1 failed | `resources-read-text:resources-read-text` (capability-not-declared) |
| `resources-subscribe` | scored | baselined, 1 passed, 1 failed | `resources-subscribe:resources-subscribe` (capability-not-declared) |
| `resources-templates-read` | scored | baselined, 1 passed, 1 failed | `resources-templates-read:resources-templates-read` (capability-not-declared) |
| `resources-unsubscribe` | scored | baselined, 1 passed, 1 failed | `resources-unsubscribe:resources-unsubscribe` (capability-not-declared) |
| `server-initialize` | scored | green, 2 passed, 0 failed |  |
| `server-session-lifecycle` | not scored (added-after-release) | green, 0 passed, 0 failed |  |
| `server-sse-multiple-streams` | scored | baselined, 0 passed, 0 failed, 1 warning | `server-sse-multiple-streams:server-sse-multiple-streams-session` (legacy-stateless-by-design) |
| `server-sse-polling` | not scored (pending) | failing, not scored and not baselined, 0 passed, 0 failed, 3 warning |  |
| `tools-call-audio` | scored | baselined, 1 passed, 1 failed | `tools-call-audio:tools-call-audio` (fixture-tools-absent) |
| `tools-call-elicitation` | scored | baselined, 1 passed, 1 failed | `tools-call-elicitation:tools-call-elicitation` (fixture-tools-absent) |
| `tools-call-embedded-resource` | scored | baselined, 1 passed, 1 failed | `tools-call-embedded-resource:tools-call-embedded-resource` (fixture-tools-absent) |
| `tools-call-error` | scored | baselined, 1 passed, 1 failed | `tools-call-error:tools-call-error` (fixture-tools-absent) |
| `tools-call-image` | scored | baselined, 1 passed, 1 failed | `tools-call-image:tools-call-image` (fixture-tools-absent) |
| `tools-call-mixed-content` | scored | baselined, 1 passed, 1 failed | `tools-call-mixed-content:tools-call-mixed-content` (fixture-tools-absent) |
| `tools-call-sampling` | scored | baselined, 1 passed, 1 failed | `tools-call-sampling:tools-call-sampling` (fixture-tools-absent) |
| `tools-call-simple-text` | scored | baselined, 1 passed, 1 failed | `tools-call-simple-text:tools-call-simple-text` (fixture-tools-absent) |
| `tools-call-with-logging` | scored | baselined, 1 passed, 1 failed | `tools-call-with-logging:tools-call-with-logging` (fixture-tools-absent) |
| `tools-call-with-progress` | scored | baselined, 1 passed, 1 failed | `tools-call-with-progress:tools-call-with-progress` (fixture-tools-absent) |
| `tools-list` | scored | green, 3 passed, 0 failed |  |

Baselined failing checks: 27, warnings included, which the baseline treats like failures. Unbaselined: 0.

## Reading the raw results

`conformance/results/<revision>/server-<scenario>-<timestamp>/checks.json` is the machine artefact, one file per scenario, each an array of checks with `id`, `status`, `errorMessage` and `specReferences`. `run.json` beside them records the command, the versions, the totals and which scenarios the requirement set never scores. `run.log` is the console transcript and is not versioned.

