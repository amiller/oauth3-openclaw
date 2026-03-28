# phala-gateway

An OAuth3-aware MITM proxy that intercepts `phala` CLI calls and routes them through the OAuth3 execution sandbox, so the real Phala API key never touches the host process.

## Architecture

```
phala-tee deploy --compose ... 
    │
    ▼
phala CLI (PHALA_CLOUD_API_PREFIX=http://127.0.0.1:3738)
    │  HTTP calls with placeholder key
    ▼
phala-gateway (localhost:3738)
    │  submits Deno skill to OAuth3
    │  with pre-approved session_id
    ▼
OAuth3 proxy (oauth3-proxy:3737)
    │  injects real PHALA_API_KEY2
    │  runs in isolated Deno sandbox
    ▼
cloud-api.phala.com
    │  real API call with real key
    ▼
response flows back up the chain
```

**The real API key never leaves the OAuth3 sandbox.** The host process only ever holds a `placeholder` string.

## Setup

### 1. Start the gateway

```bash
node phala-gateway/server.js &
```

The gateway reads `OAUTH3_BEARER_TOKEN` and `OAUTH3_SESSION_ID` from the environment.

### 2. Establish an approved OAuth3 session

Submit any skill that uses `PHALA_API_KEY2` + `cloud-api.phala.com` and approve it once. The resulting `session_id` allows future calls to auto-approve without human intervention.

```bash
# Set the session ID in the gateway (or via env var)
export OAUTH3_SESSION_ID=session_xxxx
```

### 3. Use phala-tee instead of phala

```bash
phala-tee cvms list --json
phala-tee deploy --compose docker-compose.yml --name my-cvm
phala-tee deploy --cvm-id app_xxxx --compose updated-compose.yml
```

`phala-tee` is a thin wrapper that sets the right env vars and auto-starts the gateway if needed.

## Scoped Sessions (Recommended)

For production use, create a session scoped to a specific CVM to prevent the agent from touching other CVMs:

```bash
curl -X POST http://oauth3-proxy:3737/scope \
  -H "Authorization: Bearer $OAUTH3_BEARER_TOKEN" \
  -d '{
    "description": "Manage clawteedah-hello CVM only",
    "allowedSecrets": ["PHALA_API_KEY2"],
    "allowedNetworks": ["cloud-api.phala.com"],
    "allowMutating": true,
    "maxRiskLevel": "medium",
    "constraints": [
      "Only permitted to make API calls for app_id 379bf0f2897e6142008c1b9f10a8c6bdb23fb5d1. Reject any skill that modifies or queries a different CVM."
    ]
  }'
```

Approve once → the agent can only ever touch that specific CVM, regardless of instructions.

## Security Properties

| Property | Status |
|----------|--------|
| API key never on host | ✅ Key injected only inside Deno sandbox |
| Human approval required for new sessions | ✅ One-time approval per session scope |
| CVM-scoped operations | ✅ Via constraint text in session policy |
| Audit trail | ✅ All executions logged in OAuth3 |
| Replay prevention | ✅ Each skill execution has unique request_id |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH3_URL` | `http://oauth3-proxy:3737` | OAuth3 proxy endpoint |
| `OAUTH3_BEARER_TOKEN` | (required) | Bearer token for OAuth3 auth |
| `OAUTH3_SESSION_ID` | (required) | Pre-approved session ID |
| `PHALA_GATEWAY_PORT` | `3738` | Port to listen on |

## Files

- `server.js` — Gateway HTTP server
- `phala-tee.sh` — Wrapper script for the phala CLI
- `README.md` — This file
