#!/usr/bin/env node
/**
 * phala-gateway — MITM proxy for Phala Cloud API
 *
 * Set PHALA_CLOUD_API_PREFIX=http://127.0.0.1:3738 when running phala CLI.
 * This gateway intercepts all API calls, submits them as OAuth3 skills
 * (which inject the real PHALA_API_KEY2), and returns the result.
 *
 * The real API key never touches this process.
 */

import http from "node:http";

const PORT = process.env.PHALA_GATEWAY_PORT || 3738;
const OAUTH3_URL = process.env.OAUTH3_URL || "http://oauth3-proxy:3737";
const OAUTH3_BEARER = process.env.OAUTH3_BEARER_TOKEN || "";
const REAL_API_BASE = "https://cloud-api.phala.com/api/v1";

if (!OAUTH3_BEARER) {
  console.error("WARNING: OAUTH3_BEARER_TOKEN not set");
}

/**
 * Submit a skill to OAuth3 and wait for result.
 * The skill re-issues the original HTTP request with the real API key injected.
 */
const GATEWAY_SESSION_ID = process.env.OAUTH3_SESSION_ID || "session_c0539248fc6b3c48";

async function proxyViaOAuth3(method, path, body) {
  const bodyJson = body ? JSON.stringify(body) : "null";

  const skillCode = `\
// @skill phala-api-proxy
// @description Proxy a Phala Cloud API call with injected credentials
// @secrets PHALA_API_KEY2
// @network cloud-api.phala.com
// @timeout 30

const apiKey = Deno.env.get("PHALA_API_KEY2");
const url = "${REAL_API_BASE}${path}";
const method = "${method}";
const body = ${bodyJson};

const opts = {
  method,
  headers: {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  },
};
if (body && method !== "GET" && method !== "HEAD") {
  opts.body = JSON.stringify(body);
}

const resp = await fetch(url, opts);
const text = await resp.text();
console.log(JSON.stringify({ status: resp.status, body: text }));
`;

  // Submit to OAuth3 with pre-approved session
  const execResp = await fetch(`${OAUTH3_URL}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OAUTH3_BEARER}`,
    },
    body: JSON.stringify({
      skill_id: `phala-proxy-${method}-${path.replace(/\//g, "-")}`,
      skill_code: skillCode,
      secrets: ["PHALA_API_KEY2"],
      session_id: GATEWAY_SESSION_ID,
      args: {},
    }),
  });

  const execData = await execResp.json();

  if (execData.status === "auto_approved" || execData.status === "completed") {
    return parseSkillResult(execData.result);
  }

  // "approved" means auto-approved but result not yet available — poll by request_id
  if (execData.status !== "pending" && execData.status !== "approved") {
    throw new Error(`OAuth3 submit failed: ${JSON.stringify(execData)}`);
  }

  // Log approval URL so operator can share it (manual approval case)
  if (execData.approval_url) {
    console.log(`[gateway] APPROVAL NEEDED: ${execData.approval_url}`);
  }

  // Build status URL from request_id if not provided
  const statusUrl = execData.status_url ||
    `${OAUTH3_URL}/execute/${execData.request_id}/status?wait=true`;
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const pollResp = await fetch(statusUrl, {
      headers: { "Authorization": `Bearer ${OAUTH3_BEARER}` },
    });
    const pollData = await pollResp.json();

    if (pollData.status === "completed") {
      return parseSkillResult(pollData.result);
    }
    if (pollData.status === "failed") {
      throw new Error(`Skill failed: ${JSON.stringify(pollData.error)}`);
    }
    if (pollData.status === "pending") {
      if (i % 5 === 0) console.log(`[gateway] Waiting for OAuth3 approval... (${i}s)`);
    }
  }
  throw new Error("Timeout waiting for OAuth3 approval");
}

function parseSkillResult(result) {
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return { status: parsed.status, body: parsed.body };
  } catch {
    return { status: 200, body: result.stdout };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); }
      catch { resolve(data); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // Strip leading slash to get the API path
  const apiPath = req.url;
  console.log(`[gateway] ${req.method} ${apiPath}`);

  try {
    const body = await readBody(req);
    const { status, body: responseBody } = await proxyViaOAuth3(req.method, apiPath, body);

    // Try to parse as JSON for content-type
    let responseText, contentType;
    try {
      JSON.parse(responseBody);
      responseText = responseBody;
      contentType = "application/json";
    } catch {
      responseText = responseBody;
      contentType = "text/plain";
    }

    res.writeHead(status, { "Content-Type": contentType });
    res.end(responseText);
  } catch (err) {
    console.error(`[gateway] Error:`, err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`phala-gateway (OAuth3 MITM) listening on http://127.0.0.1:${PORT}`);
  console.log(`OAuth3: ${OAUTH3_URL}`);
  console.log(`Bearer set: ${!!OAUTH3_BEARER}`);
});
