/**
 * Agent card for the fixture agent, in the A2A v1.0 shape.
 *
 * v1.0 replaced the v0.3 pair `url` + `preferredTransport` with the
 * ordered `supportedInterfaces` list; each entry carries its own
 * `protocolVersion`. There is no top-level `protocolVersion` field on
 * `AgentCard` in v1.0 (see `AgentInterface.protocolVersion` in
 * `node_modules/@a2a-js/sdk/dist/a2a-BChW6W9V.d.ts:277`).
 */
import { A2A_PROTOCOL_VERSION, type AgentCard, type AgentSkill } from "@a2a-js/sdk";

/** Path segment where the JSON-RPC interface is mounted. */
export const JSONRPC_PATH = "/a2a";

const TEXT_MODES = ["text/plain"];

const SKILLS: AgentSkill[] = [
  {
    id: "echo",
    name: "Echo",
    description:
      "Answers with a direct Message (no Task) carrying the text back verbatim.",
    tags: ["message", "deterministic"],
    examples: ["echo: hello", "ECHO: mixed case works"],
    inputModes: TEXT_MODES,
    outputModes: TEXT_MODES,
    securityRequirements: [],
  },
  {
    id: "long-task",
    name: "Long task",
    description:
      "Runs a Task through SUBMITTED, WORKING and COMPLETED, emitting one artifact. " +
      "`slow:` holds the task in WORKING so it can be canceled.",
    tags: ["task", "streaming", "cancel"],
    examples: ["task: reverse me", "slow: 2000"],
    inputModes: TEXT_MODES,
    outputModes: TEXT_MODES,
    securityRequirements: [],
  },
  {
    id: "ask",
    name: "Ask for input",
    description:
      "Parks the Task in INPUT_REQUIRED with a question, then completes it when a " +
      "second message carrying the same taskId supplies the answer.",
    tags: ["task", "input-required", "multi-turn"],
    examples: ["ask: color", "ask: target region"],
    inputModes: TEXT_MODES,
    outputModes: TEXT_MODES,
    securityRequirements: [],
  },
  {
    id: "outcomes",
    name: "Terminal outcomes",
    description:
      "Drives a Task straight to REJECTED, FAILED or AUTH_REQUIRED, each with an " +
      "explanatory status message.",
    tags: ["task", "errors", "auth-required"],
    examples: ["reject", "fail", "auth"],
    inputModes: TEXT_MODES,
    outputModes: TEXT_MODES,
    securityRequirements: [],
  },
  {
    id: "media",
    name: "Non-text parts",
    description:
      "Completes a Task whose single artifact holds a DataPart, a url file part or " +
      "raw bytes, exercising every arm of the v1.0 Part oneof.",
    tags: ["task", "artifacts", "parts"],
    examples: ["data ping", "file", "image"],
    inputModes: TEXT_MODES,
    outputModes: ["text/plain", "application/json", "application/pdf", "image/png"],
    securityRequirements: [],
  },
];

/**
 * Builds the card for an agent reachable at `baseUrl` (no trailing
 * slash), for example `http://127.0.0.1:41241`.
 */
export function buildAgentCard(baseUrl: string): AgentCard {
  return {
    name: "Fixture Agent",
    description:
      "Deterministic A2A v1.0.1 agent with no language model, driven by the prefix " +
      "of the first text part. Covers the lifecycles no official sample exercises.",
    supportedInterfaces: [
      {
        url: `${baseUrl}${JSONRPC_PATH}`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: "a2a-to-mcp test bench",
      url: "https://example.invalid/a2a-to-mcp",
    },
    version: "1.0.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: [...TEXT_MODES],
    defaultOutputModes: [...TEXT_MODES],
    skills: SKILLS.map((skill) => ({ ...skill })),
    signatures: [],
  };
}
