# OAuth3 Proxy

**Your agent's keys don't belong on your agent's machine.**

OAuth3 Proxy runs inside a TEE (Trusted Execution Environment) and holds API keys on behalf of AI agents. When an agent needs to use a key — call the GitHub API, post to Slack, sign a transaction — it submits code to the proxy. A human approves (or the session policy auto-approves), the code runs inside the enclave with the key injected, and only the result comes back. The key never touches the agent's host.

```
Your machine                          TEE (dstack CVM)
┌──────────┐                    ┌──────────────────────┐
│  Agent   │── POST /execute ──►│  OAuth3 Proxy        │
│          │◄─ result ──────────│  ├─ holds your keys   │
└──────────┘                    │  ├─ runs code in Deno │
                                │  └─ Haiku reviews it  │
┌──────────┐                    │                      │
│  You     │── approve via ────►│  approval page       │
│ (browser)│   TEE HTTPS        │  dashboard           │
└──────────┘                    └──────────────────────┘
```

## Why

AI agents are gaining tool-use capabilities fast. The bottleneck is trust: if you give an agent your GitHub token, it can do *anything* with that token. OAuth scopes are too coarse. Revoking access requires rotating the key.

This proxy inverts the model. Instead of delegating a key, you delegate *specific operations*. The agent writes code describing what it wants to do, an LLM reviews the code against natural-language constraints you set, and execution happens in a sandbox you never gave the key to.

It's like `sudo` for AI agents, where the TEE is the trusted kernel.

## How it works

1. **Agent submits code** — `POST /execute` with inline TypeScript
2. **Three-layer review** — Haiku analyzes the code (cached), checks constraints, reviews runtime args
3. **Human approves** (or session auto-approves) — web page served from the TEE
4. **Code runs in Deno sandbox** — secrets injected as env vars, network restricted
5. **Result returned** — agent long-polls `/execute/:id/status?wait=true`

Sessions remember your approvals. After you approve a scope ("this agent can read/write issues on repo X"), subsequent matching operations auto-approve without prompting.

## Deploy on dstack

Requires [dstack](https://github.com/aspect-build/dstack) (Phala CVM or any TEE-capable host).

```bash
# 1. Clone
git clone https://github.com/amiller/oauth3-openclaw && cd oauth3-openclaw

# 2. Configure
cp deploy/.env.example deploy/.env
# Edit deploy/.env — set ANTHROPIC_API_KEY, API_BEARER_TOKEN, and any secrets

# 3. Build and push the proxy image
docker build -t ghcr.io/YOUR_USER/oauth3-proxy:latest -f proxy/Dockerfile proxy/
docker push ghcr.io/YOUR_USER/oauth3-proxy:latest

# 4. Update the image digest in deploy/docker-compose.yml

# 5. Deploy to your CVM
phala deploy --cvm-id <VM_UUID> -c deploy/docker-compose.yml -e deploy/.env --wait
```

The proxy starts on port 3737. Your agent talks to it over the internal Docker network; the approval UI is exposed over dstack's HTTPS endpoint.

## Agent integration

Once deployed, the proxy serves its own protocol docs at `GET /`. Point your agent there and it knows how to use it. The short version:

```bash
# Submit code for execution
curl -X POST https://your-cvm-url/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"skill_code": "const resp = await fetch(\"https://api.github.com/repos/you/repo/issues\", { headers: { Authorization: \"Bearer \" + Deno.env.get(\"GITHUB_TOKEN\") }}); console.log(JSON.stringify(await resp.json()));"}'

# Long-poll for result (blocks up to 120s)
curl https://your-cvm-url/execute/REQ_ID/status?wait=true \
  -H "Authorization: Bearer $TOKEN"
```

For repeated operations, use scopes (`POST /scope`) to set up a session with constraints like "can only read issues on repo X" — then executions matching those constraints auto-approve.

## What this is and isn't

**This is** a working prototype of TEE-based key custody for AI agents. It's useful today if you run dstack and want to give an agent scoped access to your API keys without handing them over.

**This isn't** a production multi-tenant service (yet). Right now it's single-user, single-TEE. The [hosted multi-tenant version](docs/prd-your-shell-or-mine.md) where one TEE serves many users is the eventual product direction.

**Open questions:**
- How should agents discover and negotiate with proxies? ([GNAP positioning](docs/gnap-positioning.md))
- Haiku is inconsistent at gating destructive operations even when the scope explicitly allows them ([#9](https://github.com/amiller/oauth3-openclaw/issues/9))
- Should code review be separated from arg review for cacheability? (Done — [#14](https://github.com/amiller/oauth3-openclaw/issues/14))

## Project structure

```
proxy/src/
├── server.ts      # Routes, approval pages, dashboard
├── analyzer.ts    # Three-layer Haiku review
├── executor.ts    # Deno sandbox execution (Docker or direct mode)
├── database.ts    # SQLite (sessions, executions, secrets)
├── telegram.ts    # Optional Telegram notifications
└── types.ts       # TypeScript types
deploy/
├── docker-compose.yml  # CVM deployment config
└── .env                # Secrets (not committed)
```

## License

MIT
