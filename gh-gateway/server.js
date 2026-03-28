#!/usr/bin/env node
/**
 * gh-gateway — OAuth3 MITM proxy for the gh CLI
 *
 * Set GH_HOST=127.0.0.1:3739 (and GH_TOKEN=placeholder) when running gh CLI.
 * This gateway intercepts all GitHub API calls, submits them as OAuth3 skills
 * (which inject the real GITHUB_TOKEN), and returns the result.
 *
 * The real token never touches this process.
 */

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

const PORT = process.env.GH_GATEWAY_PORT || 3739;
const OAUTH3_URL = process.env.OAUTH3_URL || "http://oauth3-proxy:3737";
const OAUTH3_BEARER = process.env.OAUTH3_BEARER_TOKEN || "";
const OAUTH3_SESSION_ID = process.env.OAUTH3_SESSION_ID || "";
const REAL_API_BASE = "https://api.github.com";
const REAL_GRAPHQL_BASE = "https://api.github.com";

if (!OAUTH3_BEARER) console.error("WARNING: OAUTH3_BEARER_TOKEN not set");
if (!OAUTH3_SESSION_ID) console.error("WARNING: OAUTH3_SESSION_ID not set — calls will need manual approval");

async function proxyViaOAuth3(method, path, body, extraHeaders) {
  const bodyJson = body ? JSON.stringify(body) : "null";

  // Pass through any extra headers the gh CLI sends (Accept, etc.)
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(extraHeaders || {})) {
    const kl = k.toLowerCase();
    if (kl === "accept" || kl.startsWith("x-github")) {
      forwardHeaders[k] = v;
    }
  }
  const forwardHeadersJson = JSON.stringify(forwardHeaders);

  const skillCode = `\
// @skill gh-api-proxy
// @description Proxy a GitHub API call with injected credentials
// @secrets GITHUB_TOKEN
// @network api.github.com
// @timeout 30

const token = Deno.env.get("GITHUB_TOKEN");
const url = "${REAL_API_BASE}${path}";
const method = "${method}";
const body = ${bodyJson};
const extraHeaders = ${forwardHeadersJson};

const opts = {
  method,
  headers: {
    "Authorization": \`Bearer \${token}\`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "gh-gateway/1.0",
    ...extraHeaders,
  },
};
if (body && method !== "GET" && method !== "HEAD" && method !== "DELETE") {
  opts.body = JSON.stringify(body);
}

const resp = await fetch(url, opts);
const text = await resp.text();

// Preserve response headers we care about
const headers = {};
for (const h of ["content-type", "x-ratelimit-remaining", "x-ratelimit-reset", "link", "location"]) {
  const v = resp.headers.get(h);
  if (v) headers[h] = v;
}

console.log(JSON.stringify({ status: resp.status, headers, body: text }));
`;

  const execPayload = {
    skill_id: `gh-proxy-${method}-${path.replace(/[^a-z0-9]/gi, "-").slice(0, 40)}`,
    skill_code: skillCode,
    secrets: ["GITHUB_TOKEN"],
    args: {},
  };
  if (OAUTH3_SESSION_ID) execPayload.session_id = OAUTH3_SESSION_ID;

  const execResp = await fetch(`${OAUTH3_URL}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OAUTH3_BEARER}`,
    },
    body: JSON.stringify(execPayload),
  });

  const execData = await execResp.json();

  if (execData.status === "auto_approved" || execData.status === "completed") {
    return parseSkillResult(execData.result);
  }

  if (execData.approval_url) {
    console.log(`[gh-gateway] APPROVAL NEEDED: ${execData.approval_url}`);
  }

  if (execData.status !== "pending" && execData.status !== "approved") {
    throw new Error(`OAuth3 submit failed: ${JSON.stringify(execData)}`);
  }

  const statusUrl = execData.status_url ||
    `${OAUTH3_URL}/execute/${execData.request_id}/status?wait=true`;

  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const pollResp = await fetch(statusUrl, {
      headers: { "Authorization": `Bearer ${OAUTH3_BEARER}` },
    });
    const pollData = await pollResp.json();

    if (pollData.status === "completed") return parseSkillResult(pollData.result);
    if (pollData.status === "failed") throw new Error(`Skill failed: ${JSON.stringify(pollData.error)}`);
    if (i % 5 === 0) console.log(`[gh-gateway] Waiting for OAuth3... (${i * 2}s)`);
  }
  throw new Error("Timeout waiting for OAuth3");
}

function parseSkillResult(result) {
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return { status: parsed.status, headers: parsed.headers || {}, body: parsed.body };
  } catch {
    return { status: 200, headers: {}, body: result.stdout };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const data = Buffer.concat(chunks).toString();
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(data); }
    });
  });
}

// Normalize paths that gh adds when using GH_HOST (GHE format)
// /api/v3/X  → /X  (REST)
// /api/graphql → /graphql  (GraphQL)
function normalizeGhPath(url) {
  if (url.startsWith("/api/graphql")) return url.replace("/api/graphql", "/graphql");
  return url.replace(/^\/api\/v3/, "") || "/";
}

const tlsOptions = {
  key: readFileSync("/opt/gh-gateway/certs/key.pem"),
  cert: readFileSync("/opt/gh-gateway/certs/cert.pem"),
};

const server = https.createServer(tlsOptions, async (req, res) => {
  const apiPath = normalizeGhPath(req.url);
  console.log(`[gh-gateway] ${req.method} ${req.url} → ${apiPath}`);

  try {
    const body = await readBody(req);
    const { status, headers, body: responseBody } = await proxyViaOAuth3(
      req.method, apiPath, body, req.headers
    );

    // Forward relevant response headers
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }

    // Detect content type
    let contentType = headers["content-type"] || "application/json";
    res.writeHead(status, { "Content-Type": contentType });
    res.end(responseBody);
  } catch (err) {
    console.error(`[gh-gateway] Error:`, err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: err.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`gh-gateway (OAuth3 MITM) listening on https://127.0.0.1:${PORT}`);
  console.log(`OAuth3: ${OAUTH3_URL}`);
  console.log(`Session: ${OAUTH3_SESSION_ID || "(none — will need approval)"}`);
});
