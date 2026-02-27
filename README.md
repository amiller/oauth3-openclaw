# OAuth3 Enclave

AI agents need real credentials to act on your behalf — but an agent holding your API key is a liability. Prompt injection means any retrieved content could instruct the agent to misuse it. OAuth extensions (OIDC-A, OBO tokens) require every service to upgrade. And revoking a leaked token doesn't undo the damage.

OAuth3 puts a TEE between the agent and the services. The enclave holds your credentials, the agent never touches them. The agent describes what it wants to do, a human approves a scoped capability, and the agent's code runs inside the enclave's sandbox with only the approved functions available. To external services, it looks like a normal user session — no server changes required.

```
Agent                                 TEE (Confidential VM)
┌──────────┐                    ┌─────────────────────────────┐
│  Agent   │── capability spec ►│  LLM drafts scoped function │
│          │                    │  human approves the spec     │
│          │── orchestration   ►│  code runs in SES sandbox    │
│          │   code             │  only approved functions     │
│          │◄── result ─────────│  keys never leave enclave    │
└──────────┘                    └─────────────────────────────┘
```

### Why not just review the agent's code?

Because code review doesn't help when the code was influenced by prompt injection. The key insight: **the capability function is written before any untrusted data enters the system.** The agent submits a rigid JSON spec, Haiku drafts a 5-line fetch wrapper from authoritative API docs, and the human approves it — all before the agent processes any external content. Injected instructions can't change the approved capability; they can only affect data flowing through it, inside the sandbox.

### Open integration surface

Most agent security frameworks assume a **fixed set of tools** — the agent picks from `send_email`, `read_file`, `query_db`, and the security system gates access to that known set. This is true of [Conseca](https://arxiv.org/abs/2501.17070) (Google, HotOS 2025), [Progent](https://arxiv.org/abs/2504.11703), [SEAgent](https://arxiv.org/abs/2601.11893), [MiniScope](https://arxiv.org/abs/2512.11147), [AgentArmor](https://arxiv.org/abs/2508.01249), and others. Their policy languages — whether regex, DSL, or LLM-generated — reference specific tools and endpoints known at policy-definition time.

OAuth3 doesn't require a predefined tool registry. An agent can propose a novel integration with any HTTP API, and the system handles it: the agent submits a capability spec, the enclave's LLM drafts scoped code from API docs, a human reviews the concrete function, and it runs sandboxed. The set of possible integrations is open-ended — bounded only by what a human is willing to approve.

This also addresses the main critiques the field levels at Conseca's approach:
- **"Regex policies can't handle complex attacks"** ([ControlValve](https://arxiv.org/abs/2510.17276)) — OAuth3 generates executable code, not regex patterns
- **"LLM-generated policies are unreliable"** ([MiniScope](https://arxiv.org/abs/2512.11147), [CSAgent](https://arxiv.org/abs/2509.22256)) — the LLM drafts code that a human reviews and that compiles to deterministic constraints; no LLM in the enforcement path
- **"Domain-specific rules limit open-domain use"** ([PSG-Agent](https://arxiv.org/abs/2509.23614)) — capabilities are generated per-task, not predefined per-domain

### What's unique

- **Open integration surface** — works with any HTTP API without predefined tool definitions. Agents propose novel integrations; humans approve concrete code.
- **No server changes** — the enclave holds real credentials and proxies requests. To external services it looks like a normal user session.
- **Credential custody in hardware** — secrets live inside a TEE (dstack CVM). Remote attestation proves what code is running.
- **Capability-based sandbox** — agent code gets named functions (`github()`, `slack()`), not raw `fetch()`. Each function is locked to specific URL patterns, methods, and body fields.
- **Account encumbrance** — the password can be rotated *inside* the TEE so even the user can't bypass policies without visibly destroying the encumbrance. Enables DAO-controlled accounts, mandatory CI gates, escrow delegation.

## Quick start

```bash
cd proxy && npm install && npm run dev
```

Zero config for local dev — JWT secrets auto-generate, SQLite is embedded. Set `ANTHROPIC_API_KEY` in `.env` if you want the LLM to draft capabilities from natural language intent.

```bash
# Get tokens
AGENT=$(curl -s -X POST localhost:3737/signup -H 'Content-Type: application/json' \
  -d '{"name":"my-agent"}' | jq -r .token)
OWNER=$(curl -s -X POST localhost:3737/signup -H 'Content-Type: application/json' \
  -d '{"name":"me","role":"owner"}' | jq -r .token)

# Store a secret
curl -s -X POST localhost:3737/secrets \
  -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d '{"name":"GITHUB_TOKEN","value":"ghp_..."}'

# Request a permit
PERMIT=$(curl -s -X POST localhost:3737/permit \
  -H "Authorization: Bearer $AGENT" -H 'Content-Type: application/json' \
  -d '{
    "description": "List GitHub issues",
    "capabilities": [{
      "type": "scoped-fetch", "name": "github",
      "base_url": "https://api.github.com",
      "scope": ["/repos/OWNER/REPO/issues"],
      "auth": {"header":"Authorization","value":"Bearer {GITHUB_TOKEN}"}
    }]
  }')
REQ_ID=$(echo $PERMIT | jq -r .request_id)
PERMIT_ID=$(echo $PERMIT | jq -r .permit_id)

# Approve (in production this is a browser UI)
curl -s -X POST localhost:3737/approve/$REQ_ID \
  -H 'Content-Type: application/json' \
  -d "{\"owner_token\":\"$OWNER\",\"action\":\"approve\"}"

# Execute
EXEC=$(curl -s -X POST localhost:3737/execute \
  -H "Authorization: Bearer $AGENT" -H 'Content-Type: application/json' \
  -d "{\"permit_id\":\"$PERMIT_ID\",\"action_id\":\"list-issues\",
       \"code\":\"const r = await github('GET','/repos/OWNER/REPO/issues'); console.log(JSON.stringify(r));\"}")

# Poll for result
curl -s "localhost:3737/execute/$(echo $EXEC | jq -r .request_id)/status?wait=true" | jq .result
```

## Deploy to a TEE

For production on [dstack](https://docs.phala.network/dstack/overview) (Phala CVM):

```bash
cp dstack/.env.staging dstack/.env
# Set: JWT_SECRET, ANTHROPIC_API_KEY, PG_PASSWORD, DOMAIN, CLOUDFLARE_API_TOKEN

docker build -t ghcr.io/YOU/oauth3-proxy:latest proxy/
docker push ghcr.io/YOU/oauth3-proxy:latest
# Pin digest (attestation requires exact match):
docker inspect ghcr.io/YOU/oauth3-proxy:latest --format '{{index .RepoDigests 0}}'
# Update dstack/docker-compose.yml with digest

phala deploy --cvm-id <UUID> -c dstack/docker-compose.yml -e dstack/.env
```

The CVM runs: dstack-ingress (attested TLS via Cloudflare) → oauth3-proxy → postgres.

## Project structure

```
proxy/src/
├── server.ts           # HTTP API
├── executor.ts         # SES Compartment sandbox
├── database.ts         # SQLite (dev) / Postgres (prod)
├── auth.ts             # JWT with agent/owner roles
└── plugins/
    ├── scoped-fetch.ts # Main plugin: glob-scoped HTTP with rate limits
    ├── cookie-session.ts
    └── tiktok-history.ts
dstack/
├── docker-compose.yml  # CVM deployment
└── .env.staging        # Env template
```

## License

MIT
