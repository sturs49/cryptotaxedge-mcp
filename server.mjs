#!/usr/bin/env node
/**
 * Tiny catalog proxy for the hosted CryptoTaxEdge MCP
 * (https://mcp.cryptotaxedge.com/). This listing repo does not contain the
 * classification engine.
 *
 * Default: streamable HTTP / JSON-RPC on PORT (8080).
 * Also accepts MCP over stdio (newline-delimited or Content-Length), so
 * Glama's mcp-proxy wrapper can introspect the same process.
 *
 * initialize / tools/list / ping (and empty resources/prompts lists) are
 * answered from catalog.json so Glama inspect works with no network.
 * tools/call is 401 unless CTE_API_KEY is set or the request already has
 * Authorization: Bearer … — never anonymous classify.
 */

import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "catalog.json"), "utf8")
);

const UPSTREAM = process.env.CTE_MCP_URL || "https://mcp.cryptotaxedge.com/";
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const args = new Set(process.argv.slice(2));
const transportEnv = (process.env.MCP_TRANSPORT || "").toLowerCase();
const stdioOnly = args.has("--stdio") || transportEnv === "stdio";
const httpOnly = args.has("--http") || transportEnv === "http";

const PUBLIC_METHODS = new Set([
  "initialize",
  "initialized",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "logging/setLevel",
]);

const CALL_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

let pending = 0;
let stdinEnded = false;
let stdioChain = Promise.resolve();

function track(promise) {
  pending += 1;
  return promise.finally(() => {
    pending -= 1;
    maybeExit();
  });
}

function enqueueStdio(fn) {
  const run = stdioChain.then(() => fn(), () => fn());
  stdioChain = run.catch(() => {});
  return track(run);
}

function maybeExit() {
  if (stdioOnly && stdinEnded && pending === 0) process.exit(0);
}

function log(...parts) {
  process.stderr.write(parts.join(" ") + "\n");
}

function jsonRpcError(id, code, message, httpStatus = 400) {
  return {
    httpStatus,
    body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
  };
}

function bearerFromIncoming(header) {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  return /^Bearer\s+\S+/i.test(trimmed) ? trimmed : null;
}

function bearerFromEnv() {
  const key = process.env.CTE_API_KEY;
  if (!key) return null;
  return /^Bearer\s+/i.test(key) ? key : `Bearer ${key}`;
}

function authForCall(incomingAuthorization) {
  return bearerFromIncoming(incomingAuthorization) || bearerFromEnv();
}

function methodOf(message) {
  return typeof message?.method === "string" ? message.method : "";
}

function isNotification(message) {
  return message && typeof message === "object" && !("id" in message);
}

function postUpstream(payload, extraHeaders = {}) {
  const url = new URL(UPSTREAM);
  const body = Buffer.from(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8"
  );
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "content-length": String(body.length),
    ...extraHeaders,
  };
  const lib = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: `${url.pathname}${url.search}` || "/",
        method: "POST",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => {
      req.destroy(new Error("upstream timeout"));
    });
    req.end(body);
  });
}

function localCatalog(message) {
  const method = methodOf(message);
  if (isNotification(message) || method === "notifications/initialized" || method === "initialized") {
    return { httpStatus: 202, body: null, notification: true };
  }
  if (method === "initialize") {
    return {
      httpStatus: 200,
      body: { jsonrpc: "2.0", id: message.id ?? null, result: CATALOG.initialize },
    };
  }
  if (method === "tools/list") {
    return {
      httpStatus: 200,
      body: { jsonrpc: "2.0", id: message.id ?? null, result: CATALOG.tools },
    };
  }
  if (method === "ping" || method === "logging/setLevel") {
    return { httpStatus: 200, body: { jsonrpc: "2.0", id: message.id ?? null, result: {} } };
  }
  if (method === "resources/list") {
    return {
      httpStatus: 200,
      body: { jsonrpc: "2.0", id: message.id ?? null, result: { resources: [] } },
    };
  }
  if (method === "resources/templates/list") {
    return {
      httpStatus: 200,
      body: { jsonrpc: "2.0", id: message.id ?? null, result: { resourceTemplates: [] } },
    };
  }
  if (method === "prompts/list") {
    return {
      httpStatus: 200,
      body: { jsonrpc: "2.0", id: message.id ?? null, result: { prompts: [] } },
    };
  }
  return null;
}

async function handleRpcMessage(message, incomingAuthorization) {
  if (Array.isArray(message)) {
    const parts = await Promise.all(
      message.map((item) => handleRpcMessage(item, incomingAuthorization))
    );
    return {
      httpStatus: parts.some((p) => p.httpStatus >= 400) ? 400 : 200,
      body: parts.map((p) => p.body),
      notification: false,
    };
  }

  if (!message || typeof message !== "object") {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const method = methodOf(message);
  if (!method) {
    return jsonRpcError(message.id ?? null, -32600, "Invalid Request");
  }

  const local = localCatalog(message);
  if (local) return local;

  if (CALL_METHODS.has(method)) {
    const auth = authForCall(incomingAuthorization);
    if (!auth) {
      return jsonRpcError(
        message.id ?? null,
        -32001,
        "Unauthorized. Supply a valid Bearer API key in the Authorization header.",
        401
      );
    }
    const upstream = await postUpstream(message, { authorization: auth });
    return encodeUpstream(upstream, message);
  }

  if (!PUBLIC_METHODS.has(method) && method.startsWith("tools/")) {
    const auth = authForCall(incomingAuthorization);
    if (!auth) {
      return jsonRpcError(
        message.id ?? null,
        -32001,
        "Unauthorized. Supply a valid Bearer API key in the Authorization header.",
        401
      );
    }
    const upstream = await postUpstream(message, { authorization: auth });
    return encodeUpstream(upstream, message);
  }

  const headers = {};
  const auth = bearerFromIncoming(incomingAuthorization) || bearerFromEnv();
  if (auth) headers.authorization = auth;
  const upstream = await postUpstream(message, headers);
  return encodeUpstream(upstream, message);
}

function encodeUpstream(upstream, original) {
  const raw = upstream.body.toString("utf8");
  if (isNotification(original) && (upstream.statusCode === 202 || raw === "")) {
    return { httpStatus: 202, body: null, notification: true };
  }
  try {
    return {
      httpStatus: upstream.statusCode,
      body: JSON.parse(raw),
      contentType: upstream.headers["content-type"] || "application/json",
    };
  } catch {
    return {
      httpStatus: upstream.statusCode,
      raw,
      contentType: upstream.headers["content-type"] || "text/plain",
    };
  }
}

function writeHttp(res, result) {
  if (result.notification || result.body === null) {
    res.writeHead(result.httpStatus || 202);
    res.end();
    return;
  }
  if (result.raw !== undefined) {
    res.writeHead(result.httpStatus || 200, {
      "content-type": result.contentType || "text/plain",
    });
    res.end(result.raw);
    return;
  }
  const payload = JSON.stringify(result.body);
  res.writeHead(result.httpStatus || 200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "Content-Type, Authorization, apiKey, x-api-key, MCP-Protocol-Version, Mcp-Session-Id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function healthPayload() {
  return {
    ok: true,
    transport: "streamable-http",
    port: PORT,
    upstream: UPSTREAM,
  };
}

async function onRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "Content-Type, Authorization, apiKey, x-api-key, MCP-Protocol-Version, Mcp-Session-Id",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    writeHttp(res, { httpStatus: 200, body: healthPayload() });
    return;
  }

  if (req.method !== "POST" || (path !== "/" && path !== "/mcp")) {
    writeHttp(res, jsonRpcError(null, -32601, "Method not found", 404));
    return;
  }

  let parsed;
  try {
    const raw = (await readBody(req)).toString("utf8").trim();
    if (!raw) {
      writeHttp(res, jsonRpcError(null, -32700, "Parse error"));
      return;
    }
    parsed = JSON.parse(raw);
  } catch {
    writeHttp(res, jsonRpcError(null, -32700, "Parse error"));
    return;
  }

  try {
    const result = await handleRpcMessage(parsed, req.headers.authorization);
    writeHttp(res, result);
  } catch (err) {
    log("upstream error:", err && err.message ? err.message : err);
    writeHttp(
      res,
      jsonRpcError(parsed?.id ?? null, -32002, "Upstream MCP request failed", 502)
    );
  }
}

function writeStdio(obj, framing) {
  if (obj == null) return;
  const json = JSON.stringify(obj);
  if (framing === "content-length") {
    const payload = Buffer.from(json, "utf8");
    process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
    process.stdout.write(payload);
    return;
  }
  process.stdout.write(json + "\n");
}

async function onStdioMessage(text, framing) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    writeStdio(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      framing
    );
    return;
  }
  try {
    const result = await handleRpcMessage(parsed, process.env.AUTHORIZATION);
    if (result.notification || result.body === null) return;
    if (result.raw !== undefined) {
      writeStdio(result.raw, framing);
      return;
    }
    writeStdio(result.body, framing);
  } catch (err) {
    log("stdio upstream error:", err && err.message ? err.message : err);
    writeStdio(
      {
        jsonrpc: "2.0",
        id: parsed?.id ?? null,
        error: { code: -32002, message: "Upstream MCP request failed" },
      },
      framing
    );
  }
}

function attachStdio() {
  process.stdin.resume();
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    buf = drainStdio(buf);
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    maybeExit();
  });
}

function drainStdio(buf) {
  while (buf.length > 0) {
    const head = buf.toString("utf8", 0, Math.min(buf.length, 64));
    if (/^Content-Length:/i.test(head)) {
      const asString = buf.toString("utf8");
      let headerEnd = asString.indexOf("\r\n\r\n");
      let sepLen = 4;
      if (headerEnd === -1) {
        headerEnd = asString.indexOf("\n\n");
        sepLen = 2;
      }
      if (headerEnd === -1) break;
      const match = asString.match(/^Content-Length:\s*(\d+)/i);
      if (!match) break;
      const len = Number(match[1]);
      const start = headerEnd + sepLen;
      const bytes = Buffer.from(asString.slice(0, start), "utf8").length;
      if (buf.length < bytes + len) break;
      const body = buf.subarray(bytes, bytes + len).toString("utf8");
      buf = buf.subarray(bytes + len);
      enqueueStdio(() => onStdioMessage(body, "content-length"));
      continue;
    }
    const nl = buf.indexOf(0x0a);
    if (nl === -1) break;
    const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
    buf = buf.subarray(nl + 1);
    if (line.trim()) enqueueStdio(() => onStdioMessage(line, "ndjson"));
  }
  return buf;
}

function startHttp() {
  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      log("request error:", err && err.message ? err.message : err);
      if (!res.headersSent) {
        writeHttp(res, jsonRpcError(null, -32603, "Internal error", 500));
      }
    });
  });
  server.listen(PORT, HOST, () => {
    log(
      `CryptoTaxEdge MCP catalog proxy listening on http://${HOST}:${PORT}/ (upstream ${UPSTREAM})`
    );
  });
  return server;
}

if (stdioOnly) {
  attachStdio();
} else {
  startHttp();
  if (!httpOnly) attachStdio();
}
