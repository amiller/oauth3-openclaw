# OAuth3 Enclave

**Your agent's keys don't belong on your agent's machine.**

OAuth3 Enclave runs inside a TEE (Trusted Execution Environment) and holds API keys on behalf of AI agents. When an agent needs to call an API, it describes what it wants to do. The enclave drafts a minimal security policy, a human approves it, and the agent's code runs in a locked-down sandbox with only the approved capabilities injected. The key never leaves the enclave.

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

## Quick start (for agents)

The enclave is self-documenting. Point your agent at the base URL and it gets everything it needs:

```bash
# 1. Discover the API
curl https://your-enclave-url/

# 2. Sign up
curl -X POST https://your-enclave-url/signup \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}'
# → {"token": "...", "tenant_id": "..."}

# 3. Request a permit (intent-based — enclave drafts the policy)
curl -X POST https://your-enclave-url/permit \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Create and list GitHub issues",
    "intent": [{
      "name": "github",
      "goal": "Create and list issues on owner/repo",
      "doc_urls": ["https://docs.github.com/en/rest/issues"],
      "secret_hints": ["GITHUB_TOKEN"]
    }]
  }'
# → {"approval_url": "...", "status_url": "...", "permit_id": "..."}

# 4. Human approves in browser, agent polls status_url

# 5. Execute under the approved permit
curl -X POST https://your-enclave-url/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "permit_id": "...",
    "action_id": "list-issues",
    "code": "const r = await github(\"GET\", \"repos/owner/repo/issues\"); console.log(JSON.stringify(r));"
  }'
```

Permits are reusable — approve once, execute many times.

## How it works

1. **Agent describes intent** — "I want to create GitHub issues" + relevant doc URLs
2. **Enclave drafts policy** — LLM produces a minimal scoped-fetch spec (restricted URLs, methods, body fields, rate limits)
3. **Human reviews** — approval page shows agent's intent alongside the drafted policy
4. **Agent submits code** — runs in an [SES](https://github.com/nicolo-ribaudo/tc39-proposal-ses) sandbox with only the approved API endowments injected
5. **No ambient authority** — no `fetch()`, no `require()`, no env vars. Only the named functions from the permit

## Security model

- **TEE isolation** — runs on [dstack](https://docs.phala.network/dstack/overview) (Phala CVM). Remote attestation proves the code running is the code you audited
- **SES Compartments** — agent code executes in a locked-down JavaScript sandbox. No ambient capabilities
- **Scoped endowments** — each approved API gets a function scoped to specific URL patterns, HTTP methods, and body fields
- **Human-in-the-loop** — every new scope requires explicit human approval via the enclave's HTTPS UI
- **Key custody** — secrets stored in the enclave's encrypted database, injected into endowments at execution time, never returned to the agent

Based on [CONSECA: A Consent-Based Framework for Secure AI Agent Actions](https://eprint.iacr.org/2025/811).

## Deploy

Requires [dstack](https://docs.phala.network/dstack/overview) or any TEE-capable host.

```bash
git clone https://github.com/amiller/oauth3-openclaw && cd oauth3-openclaw

# Configure
cp dstack/.env.example dstack/.env
# Edit dstack/.env — set JWT_SECRET, ANTHROPIC_API_KEY, PG_PASSWORD, DOMAIN, etc.

# Build and push
docker build -t ghcr.io/YOUR_USER/oauth3-proxy:latest proxy/
docker push ghcr.io/YOUR_USER/oauth3-proxy:latest

# Get the digest and update dstack/docker-compose.yml (tags don't trigger CVM updates)
docker inspect ghcr.io/YOUR_USER/oauth3-proxy:latest --format '{{index .RepoDigests 0}}'

# Deploy
cd dstack
phala deploy --cvm-id <VM_UUID> -c docker-compose.yml -e .env
```

## Project structure

```
proxy/src/
├── server.ts           # Routes: /permit, /execute, /approve, /sessions, /secrets
├── capability.ts       # Spec types, hashing, plugin system re-exports
├── executor.ts         # SES Compartment execution with endowment injection
├── database.ts         # PostgreSQL (sessions, executions, secrets, capabilities)
├── auth.ts             # JWT auth with agent/owner roles
├── intent-drafter.ts   # LLM-based policy drafting from agent intent
└── plugins/
    ├── types.ts        # CapabilityPlugin interface, EndowmentFactory
    ├── registry.ts     # Plugin registration
    └── scoped-fetch.ts # Glob-scoped HTTP client (the main plugin)
dstack/
├── docker-compose.yml  # CVM deployment (proxy + ingress + postgres + ssh)
└── .env                # Secrets (not committed)
```

## License

MIT
