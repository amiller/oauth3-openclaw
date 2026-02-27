# OAuth3 Enclave

Your agent's API keys don't belong on your agent's machine. This runs inside a TEE and holds secrets on behalf of AI agents — agents describe what they want to do, a human approves a scoped policy, and code runs in a sandbox with only the approved capabilities injected.

```
Agent                                 TEE
┌──────────┐                    ┌─────────────────────────────┐
│  Agent   │── POST /permit ───►│  drafts scoped policy       │
│          │                    │  human approves in browser   │
│          │── POST /execute ──►│  runs code in SES sandbox    │
│          │◄── result ─────────│  keys never leave the enclave│
└──────────┘                    └─────────────────────────────┘
```

## Quick start

```bash
cd proxy
npm install
npm run dev
```

No config needed for local dev — JWT secrets auto-generate and SQLite is embedded. Set `ANTHROPIC_API_KEY` in a `.env` file if you want the enclave to auto-draft policies from natural language intent (otherwise you pass capability specs directly).

### Sign up and get a token

```bash
# Get an agent token
curl -s -X POST http://localhost:3737/signup \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}' | jq .
# → { "token": "...", "tenant_id": "..." }

# Get an owner token (can approve permits and manage secrets)
curl -s -X POST http://localhost:3737/signup \
  -H "Content-Type: application/json" \
  -d '{"name": "me", "role": "owner"}' | jq .
```

### Store a secret, request a permit, approve it, execute

```bash
TOKEN=<agent_token>
OWNER=<owner_token>

# Store a GitHub token as the owner
curl -s -X POST http://localhost:3737/secrets \
  -H "Authorization: Bearer $OWNER" \
  -H "Content-Type: application/json" \
  -d '{"name": "GITHUB_TOKEN", "value": "ghp_..."}'

# Agent requests a permit with a capability spec
curl -s -X POST http://localhost:3737/permit \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "List GitHub issues",
    "capabilities": [{
      "type": "scoped-fetch",
      "name": "github",
      "base_url": "https://api.github.com",
      "scope": ["/repos/OWNER/REPO/issues"],
      "auth": {"header": "Authorization", "value": "Bearer {GITHUB_TOKEN}"}
    }]
  }' | jq .
# → { "request_id": "...", "approval_url": "...", "permit_id": "..." }

# Approve it (in production this happens in the browser)
curl -s -X POST http://localhost:3737/approve/<request_id> \
  -H "Content-Type: application/json" \
  -d '{"owner_token": "'$OWNER'", "action": "approve"}'

# Execute code under the permit
curl -s -X POST http://localhost:3737/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "permit_id": "<permit_id>",
    "action_id": "list-issues",
    "code": "const r = await github(\"GET\", \"/repos/OWNER/REPO/issues\"); console.log(JSON.stringify(r));"
  }' | jq .
# → { "request_id": "...", "status_url": "..." }

# Poll for result
curl -s http://localhost:3737/execute/<request_id>/status?wait=true | jq .
```

The agent code runs in an SES sandbox — no `fetch()`, no `require()`, no env vars. Only the `github()` function from the approved permit is available.

## Docker (with Postgres)

```bash
cd proxy
docker compose -f docker-compose.dev.yml up
# proxy on :3000, postgres on :5432
```

## Deploy to a TEE (dstack)

For production on [dstack](https://docs.phala.network/dstack/overview) (Phala CVM):

```bash
cp dstack/.env.staging dstack/.env
# Edit: JWT_SECRET, ANTHROPIC_API_KEY, PG_PASSWORD, DOMAIN, CLOUDFLARE_API_TOKEN

docker build -t ghcr.io/YOUR_USER/oauth3-proxy:latest proxy/
docker push ghcr.io/YOUR_USER/oauth3-proxy:latest
# Pin the digest (attestation requires exact image match):
docker inspect ghcr.io/YOUR_USER/oauth3-proxy:latest --format '{{index .RepoDigests 0}}'
# Update digest in dstack/docker-compose.yml

phala deploy --cvm-id <VM_UUID> -c dstack/docker-compose.yml -e dstack/.env
```

## Security model

- **TEE isolation** — remote attestation proves the code running is the code you audited
- **SES Compartments** — agent code runs in a hardened JavaScript sandbox with zero ambient authority
- **Scoped endowments** — each capability is a function locked to specific URL patterns, methods, and body fields
- **Human-in-the-loop** — every new scope requires explicit approval
- **Key custody** — secrets live in the enclave, injected at execution time, never returned to the agent

## Project structure

```
proxy/src/
├── server.ts           # HTTP API — all routes
├── executor.ts         # SES Compartment execution
├── database.ts         # SQLite schema
├── postgres.ts         # Optional PostgreSQL for production
├── auth.ts             # JWT auth (agent/owner roles)
├── capability.ts       # Spec types, plugin re-exports
└── plugins/
    ├── types.ts        # CapabilityPlugin interface
    ├── registry.ts     # Plugin registration
    ├── scoped-fetch.ts # Glob-scoped HTTP client
    ├── cookie-session.ts
    └── tiktok-history.ts
dstack/
├── docker-compose.yml  # CVM deployment
├── .env.staging        # Env template
└── .env.production
```

## License

MIT
