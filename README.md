# OAuth3 Enclave

A TEE (Trusted Execution Environment) that holds API keys on behalf of AI agents. Agents describe what they want to do, the enclave drafts a minimal security policy, a human approves it, and agent code runs in a locked-down sandbox with only the approved capabilities injected. Keys never leave the enclave.

```
Your machine                          TEE (Trusted Execution Environment)
┌──────────┐                    ┌─────────────────────────────┐
│  Agent   │── POST /permit ───►│  OAuth3 Enclave             │
│          │   "I want to       │  ├─ drafts scoped policy    │
│          │    create issues"  │  ├─ human approves in browser│
│          │                    │  ├─ holds keys in vault      │
│          │── POST /execute ──►│  ├─ runs code in SES sandbox │
│          │◄── result ─────────│  └─ only approved ops work   │
└──────────┘                    └─────────────────────────────┘
```

## Run locally

```bash
cd proxy
npm install
cp .env.example .env
# Edit .env — set JWT_SECRET, optionally ANTHROPIC_API_KEY for LLM drafting

npm run dev
# → http://localhost:3737
```

Or with Docker Compose (includes Postgres):

```bash
cd proxy
docker compose -f docker-compose.dev.yml up
# → proxy on :3000, postgres on :5432
```

Hit the root endpoint to see all available routes and a quick-start guide:

```bash
curl http://localhost:3737/
```

## Deploy to a TEE (dstack)

Requires [dstack](https://docs.phala.network/dstack/overview) or any TEE-capable host.

```bash
# Configure
cp dstack/.env.staging dstack/.env
# Edit dstack/.env — set JWT_SECRET, ANTHROPIC_API_KEY, PG_PASSWORD, DOMAIN, CLOUDFLARE_API_TOKEN

# Build and push (digests, not tags — attestation requires exact image match)
docker build -t ghcr.io/YOUR_USER/oauth3-proxy:latest proxy/
docker push ghcr.io/YOUR_USER/oauth3-proxy:latest
docker inspect ghcr.io/YOUR_USER/oauth3-proxy:latest --format '{{index .RepoDigests 0}}'
# Update the digest in dstack/docker-compose.yml

# Deploy
phala deploy --cvm-id <VM_UUID> -c dstack/docker-compose.yml -e dstack/.env
```

The CVM runs: dstack-ingress (HTTPS + attestation via Cloudflare) → oauth3-proxy → postgres.

## API overview

| Endpoint | Description |
|---|---|
| `GET /` | Discovery — lists all endpoints, plugins, quick-start |
| `POST /signup` | Get an agent or owner token |
| `POST /permit` | Request capabilities (intent-based or direct specs) |
| `POST /execute` | Run code under an approved permit |
| `GET /execute/:id/status?wait=true` | Long-poll for execution result |
| `GET /approve/:id` | Approval details (for human review UI) |
| `POST /approve/:id` | Approve/deny a permit |
| `POST /secrets` | Store a secret (owner only) |
| `GET /sessions` | List active permits |
| `POST /cookies/upload` | Upload browser cookies from extension |
| `GET /plugins` | List capability plugins with schemas |

The enclave is self-documenting — `GET /` returns everything an agent needs to get started.

## Security model

- **TEE isolation** — runs on [dstack](https://docs.phala.network/dstack/overview) (Phala CVM). Remote attestation proves the code running is the code you audited
- **SES Compartments** — agent code executes in a locked-down JavaScript sandbox. No `fetch()`, no `require()`, no env vars
- **Scoped endowments** — each approved API gets a function scoped to specific URL patterns, HTTP methods, and body fields
- **Human-in-the-loop** — every new scope requires explicit human approval
- **Key custody** — secrets stored in the enclave's database, injected into endowments at execution time, never returned to the agent

## How it works

1. **Agent describes intent** — "I want to create GitHub issues" + relevant doc URLs
2. **Enclave drafts policy** — LLM produces a scoped-fetch spec (restricted URLs, methods, body fields, rate limits)
3. **Human reviews** — approval page shows intent alongside the drafted policy
4. **Agent submits code** — runs in an SES sandbox with only the approved API endowments
5. **No ambient authority** — only the named functions from the permit are available

Permits are reusable — approve once, execute many times under the same session.

## Project structure

```
proxy/src/
├── server.ts           # HTTP API — all routes
├── executor.ts         # SES Compartment execution with endowment injection
├── database.ts         # SQLite schema (sessions, secrets, capabilities, executions)
├── postgres.ts         # Optional PostgreSQL for production
├── auth.ts             # JWT auth (agent/owner roles)
├── capability.ts       # Spec types, plugin re-exports
└── plugins/
    ├── types.ts        # CapabilityPlugin interface
    ├── registry.ts     # Plugin registration
    ├── scoped-fetch.ts # Glob-scoped HTTP client (main plugin)
    ├── cookie-session.ts # Cookie-based auth plugin
    └── tiktok-history.ts # Read-only TikTok plugin
dstack/
├── docker-compose.yml  # CVM deployment (ingress + proxy + postgres + ssh)
├── .env.staging        # Staging env template
└── .env.production     # Production env template
```

## For agents

Use the [`oauth3-skill`](https://www.npmjs.com/package/oauth3-skill) SDK to integrate your agent with an enclave. It handles signup, permit requests, polling, and execution.

## License

MIT
