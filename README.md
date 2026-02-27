# OAuth3 Enclave

An API gateway where every integration is defined just-in-time. There's no fixed set of tools — an agent states its **intent** (a goal, API doc URLs, and which secrets it needs), a trusted LLM inside the enclave drafts a minimal scoped-fetch spec from only that trusted context, a human approves the intent, and the spec compiles into a deterministic sandbox. Credentials never leave the TEE. The agent never sees them.

This is the [Conseca](https://arxiv.org/abs/2501.17070) architecture (Google, HotOS 2025) made concrete: separate trusted policy generation from untrusted execution. The LLM drafts policy using **only trusted inputs** (the intent spec + authoritative API docs). The policy compiles to a locked-down fetch function — specific URL globs, HTTP methods, body fields, rate limits. No LLM in the enforcement path. No predefined tool registry. No server-side changes.

```
  Agent                    Human                    TEE (Confidential VM)
┌─────────┐            ┌───────────┐          ┌──────────────────────────────┐
│         │── intent ──►           │          │                              │
│         │  name       │ reviews  │─approve─►│ LLM drafts scoped-fetch spec │
│         │  goal       │ the      │          │ from intent + API docs only   │
│         │  doc_urls   │ intent   │          │ (no untrusted input)          │
│         │  secrets    │          │          │                              │
│         │             └───────────┘          │ spec compiles to:            │
│         │                                   │  URL globs, methods,         │
│         │                                   │  body schema, rate limits    │
│         │                                   │                              │
│         │──── orchestration code ──────────►│ runs in SES sandbox          │
│         │                                   │ github('GET', '/repos/...')   │
│         │◄──── result ─────────────────────│ credentials injected by TEE  │
└─────────┘                                   └──────────────────────────────┘

  untrusted ▲                                   trusted ▲
  prompt injection can't                        attested, deterministic
  change the approved spec                      no LLM at enforcement time
```

### Intent, not code review

The human approves a **goal** — "create issues on owner/repo using the GitHub API" — not a page of code. The trusted LLM inside the enclave translates that into a scoped-fetch spec: which base URL, which path globs, which HTTP methods, which body fields, which secrets to inject. That spec is the policy. It compiles to a sandbox function that can't do anything outside its scope.

An intent looks like:
```json
{
  "name": "github",
  "goal": "Create issues on owner/repo",
  "doc_urls": ["https://docs.github.com/en/rest/issues"],
  "secret_hints": ["GITHUB_TOKEN"]
}
```

The LLM drafts this into a scoped-fetch spec — locked to `POST /repos/owner/repo/issues`, with `Authorization: Bearer {GITHUB_TOKEN}` injected, body restricted to `title` and `body` fields, rate-limited. That's what runs. Nothing else exists in the sandbox.

### Why this matters

Every other agent security framework assumes the set of integrations is **known in advance**. [Progent](https://arxiv.org/abs/2504.11703), [SEAgent](https://arxiv.org/abs/2601.11893), [MiniScope](https://arxiv.org/abs/2512.11147), [AgentArmor](https://arxiv.org/abs/2508.01249) — they all gate access to predefined tools. Their policy languages (regex, DSL, Cedar) reference specific tool names and endpoints. This works for closed systems, but agents operating in the real world need to hit APIs nobody anticipated at design time.

OAuth3 is open-ended: the agent proposes an intent, the human approves a goal, the enclave enforces a spec. The set of possible integrations is unbounded — limited only by what a human is willing to approve.

This sidesteps the main critiques the field levels at contextual policy generation:
- **"Regex policies can't handle complex attacks"** ([ControlValve](https://arxiv.org/abs/2510.17276)) — the spec compiles to URL globs + method + body schema, enforced deterministically
- **"LLM-generated policies are unreliable"** ([MiniScope](https://arxiv.org/abs/2512.11147), [CSAgent](https://arxiv.org/abs/2509.22256)) — the LLM only drafts from trusted context; a human approves; enforcement has no LLM
- **"Domain-specific rules can't cover open-domain tasks"** ([PSG-Agent](https://arxiv.org/abs/2509.23614)) — intents are generated per-task for any API

### Features

- **Open integration surface** — any HTTP API, no predefined tools. Agents propose intents; the enclave drafts specs.
- **Credential custody in hardware** — secrets live in a TEE (dstack CVM). Remote attestation proves what code runs.
- **No server changes** — to external services it looks like a normal user session.
- **Deterministic sandbox** — each approved spec compiles to a named function locked to specific URL globs, methods, body fields, and rate limits. No `fetch()`, no escape.
- **Account encumbrance** — the password can be rotated *inside* the TEE so even the user can't bypass policies without visibly destroying the encumbrance.

## Quick start

```bash
cd proxy && npm install && npm run dev
```

Zero config for local dev — JWT secrets auto-generate, SQLite is embedded. Set `ANTHROPIC_API_KEY` in `.env` for LLM-drafted capabilities.

```bash
AGENT=$(curl -s -X POST localhost:3737/signup -H 'Content-Type: application/json' \
  -d '{"name":"my-agent"}' | jq -r .token)
OWNER=$(curl -s -X POST localhost:3737/signup -H 'Content-Type: application/json' \
  -d '{"name":"me","role":"owner"}' | jq -r .token)

# Store a secret
curl -s -X POST localhost:3737/secrets \
  -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d '{"name":"GITHUB_TOKEN","value":"ghp_..."}'

# Request a permit via intent (LLM drafts the scoped-fetch spec)
PERMIT=$(curl -s -X POST localhost:3737/permit \
  -H "Authorization: Bearer $AGENT" -H 'Content-Type: application/json' \
  -d '{
    "description": "List GitHub issues",
    "intent": [{
      "name": "github",
      "goal": "List issues on owner/repo",
      "doc_urls": ["https://docs.github.com/en/rest/issues"],
      "secret_hints": ["GITHUB_TOKEN"]
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
       \"code\":\"const r = await github('GET','/repos/owner/repo/issues'); console.log(JSON.stringify(r));\"}")

# Poll for result
curl -s "localhost:3737/execute/$(echo $EXEC | jq -r .request_id)/status?wait=true" | jq .result
```

See [DEPLOY.md](dstack/DEPLOY.md) for TEE deployment on dstack/Phala CVM.

## Project structure

```
proxy/src/
├── server.ts           # HTTP API + intent drafting
├── executor.ts         # SES Compartment sandbox
├── database.ts         # SQLite (dev) / Postgres (prod)
├── auth.ts             # JWT with agent/owner roles
└── plugins/
    └── scoped-fetch.ts # URL globs, methods, body schema, rate limits
dstack/
├── docker-compose.yml  # CVM deployment
└── .env.staging        # Env template
```

## License

MIT
