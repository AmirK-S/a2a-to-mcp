/**
 * DNS rebinding protection (conformance scenario dns-rebinding-protection):
 * a request whose Host header names a foreign origin must be refused with a
 * 4xx, and requests with the loopback host the bridge listens on must pass.
 * The SDK v2 handler provides this when asked; the bridge must ask.
 */
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBridge, type Bridge } from "../../src/server.js";
import { MODERN_VERSION, expectResult, postModern } from "../helpers/mcp-http.js";

const UNREACHABLE_CARD = "http://127.0.0.1:9/.well-known/agent-card.json";

let bridge: Bridge;
let url: string;
let port: number;

beforeAll(async () => {
  bridge = await createBridge({ agents: { fixture: { cardUrl: UNREACHABLE_CARD } } });
  ({ url, port } = await bridge.listen(0));
});

afterAll(async () => {
  await bridge.close();
});

/**
 * fetch in Node refuses to override Host, so the raw http module is used to
 * put a foreign host on the wire, exactly as the conformance suite does.
 */
function discoverWithHost(targetUrl: string, host: string): Promise<{ status: number }> {
  const target = new URL(targetUrl);
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          Host: host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": MODERN_VERSION,
          "Mcp-Method": "server/discover",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

describe("Host header validation", () => {
  it("refuses a foreign Host with a 4xx status", async () => {
    const response = await discoverWithHost(url, "evil.example.com");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("accepts the loopback hosts it listens on, with and without the port", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, "localhost", "127.0.0.1"]) {
      const response = await discoverWithHost(url, host);
      expect(response.status, host).toBe(200);
    }
  });

  it("accepts extra hosts from the configuration", async () => {
    const custom = await createBridge({
      agents: { fixture: { cardUrl: UNREACHABLE_CARD } },
      allowedHosts: ["bridge.internal"],
    });
    const customUrl = (await custom.listen(0)).url;
    try {
      const allowed = await discoverWithHost(customUrl, "bridge.internal");
      expect(allowed.status).toBe(200);
    } finally {
      await custom.close();
    }
  });

  it("still serves the ordinary request path", async () => {
    expectResult(await postModern(url, "server/discover"));
  });
});
