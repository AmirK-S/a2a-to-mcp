#!/usr/bin/env node
// Logging reverse proxy: 127.0.0.1:8932 -> 127.0.0.1:8931
// One JSON line per exchange in trace.jsonl.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACE = path.join(HERE, "trace.jsonl");
const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = 8931;
const LISTEN_PORT = 8932;

let seq = 0;
const out = fs.createWriteStream(TRACE, { flags: "a" });

function record(entry) {
  out.write(JSON.stringify(entry) + "\n");
}

const server = http.createServer((req, res) => {
  const id = ++seq;
  const startedAt = new Date().toISOString();
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const requestBody = Buffer.concat(chunks).toString("utf8");
    const headers = { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };
    const upstream = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method: req.method,
        path: req.url,
        headers,
      },
      (ur) => {
        const rchunks = [];
        ur.on("data", (c) => rchunks.push(c));
        ur.on("end", () => {
          if (settle()) return;
          const responseBody = Buffer.concat(rchunks).toString("utf8");
          record({
            seq: id,
            startedAt,
            endedAt: new Date().toISOString(),
            method: req.method,
            path: req.url,
            requestHeaders: req.headers,
            requestBody,
            status: ur.statusCode,
            responseHeaders: ur.headers,
            responseBody,
          });
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          res.end(Buffer.concat(rchunks));
        });
      },
    );
    let settled = false;
    const settle = () => {
      const done = settled;
      settled = true;
      return done;
    };
    req.on("aborted", () => {
      if (settle()) return;
      record({
        seq: id,
        startedAt,
        endedAt: new Date().toISOString(),
        method: req.method,
        path: req.url,
        requestHeaders: req.headers,
        requestBody,
        status: null,
        aborted: "client aborted the request before the upstream response completed",
      });
      upstream.destroy();
    });
    res.on("close", () => {
      if (settled) return;
      settle();
      record({
        seq: id,
        startedAt,
        endedAt: new Date().toISOString(),
        method: req.method,
        path: req.url,
        requestHeaders: req.headers,
        requestBody,
        status: null,
        aborted: "client closed the response before it completed",
      });
    });
    upstream.on("error", (error) => {
      if (settle()) return;
      record({
        seq: id,
        startedAt,
        endedAt: new Date().toISOString(),
        method: req.method,
        path: req.url,
        requestHeaders: req.headers,
        requestBody,
        status: 0,
        error: String(error),
      });
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("proxy error");
    });
    if (requestBody.length > 0) {
      upstream.write(requestBody);
    }
    upstream.end();
  });
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`[trace-proxy] 127.0.0.1:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}, trace: ${TRACE}`);
});
