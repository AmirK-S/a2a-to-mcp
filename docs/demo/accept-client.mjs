// Minimal stateless MCP client, no SDK: declares elicitation and ACCEPTS the
// bridge question with "blue". Written only to show the branch that a headless
// Claude Code run cannot take (no human to elicit).
import fs from "node:fs";
const URL_ = "http://127.0.0.1:8932/mcp";
const out = fs.createWriteStream(new URL("./trace-accept.jsonl", import.meta.url), { flags: "w" });
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "accept-client", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
};
let id = 0;
async function call(method, params, mcpHeaders) {
  const body = { jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: META } };
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      ...mcpHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  out.write(JSON.stringify({ request: body, status: res.status, response: text }) + "\n");
  return JSON.parse(text);
}
const first = await call("tools/call", { name: "a2a_send_message", arguments: { agent: "fixture", text: "ask: colour" } }, { "mcp-method": "tools/call", "mcp-name": "a2a_send_message" });
console.log("ROUND 1:", JSON.stringify(first.result));
const second = await call("tools/call", {
  name: "a2a_send_message",
  arguments: { agent: "fixture", text: "ask: colour" },
  inputResponses: { answer: { action: "accept", content: { answer: "blue" } } },
  requestState: first.result.requestState,
}, { "mcp-method": "tools/call", "mcp-name": "a2a_send_message" });
console.log("ROUND 2:", JSON.stringify(second.result));
out.end();
