# OAuth3-OpenClaw

Programmable API gateway running in a TEE. Agents submit code for execution, humans approve scopes via web UI, and Haiku reviews each invocation against natural-language constraints.

```
Agent (openclaw)              Human (browser)
    │                              │
    ├─ POST /scope ──────────────► approval page (TEE HTTPS)
    ├─ POST /execute ──────┐      │
    │  (auto-approve or ◄──┘      ├─ GET /dashboard
    │   pending)                   │
    ▼                              ▼
┌─────────────────────────────────────┐
│  OAuth3 Proxy (Deno sandbox + TEE)  │
│  ├─ Three-layer Haiku review        │
│  ├─ Session policy management       │
│  └─ Secret injection                │
└─────────────────────────────────────┘
                 │
                 ▼
         External APIs (GitHub, Phala, etc.)
```

## Development Workflow

Two agents collaborate through the proxy:

- **Claude Code** — develops the proxy, handles issues, deploys via SSH/`phala` CLI
- **Openclaw agent** — integration-tests the proxy, co-designs scopes + skills, files issues

Both run as Docker containers on a Phala CVM connected via an `internal` bridge network. The proxy is accessible externally at its dstack HTTPS URL.

## Key Concepts

**Scopes** — An agent requests a scope (`POST /scope`) describing what it wants to do, with natural-language constraints. A human approves the scope via a web page served from the TEE.

**Sessions** — An approved scope creates a session. Subsequent `POST /execute` calls referencing the session are auto-approved if they pass Haiku review.

**Three-layer review** — Every execution goes through:
1. **Static code analysis** — is this code safe? (cacheable by hash)
2. **Constraint compliance** — does it match the session's constraints?
3. **Argument review** — are the runtime args safe?

**Co-design pattern** — Write per-operation skills with hardcoded values, then write constraints that describe exactly what the code does. Haiku checks for correspondence, not minimality.

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/execute` | Submit code for execution (`skill_code` or `skill_url`) |
| `GET` | `/execute/:id/status?wait=true` | Long-poll for result (120s timeout) |
| `POST` | `/scope` | Request a scope with constraints |
| `GET/POST` | `/approve/:id?token=...` | Web-based approval page |
| `GET` | `/sessions` | List active sessions |
| `GET` | `/sessions/:id` | Session details |
| `DELETE` | `/sessions/:id` | Revoke a session |
| `GET` | `/dashboard?token=...` | Web UI for browsing sessions/executions |
| `GET` | `/health` | Health check |
| `GET` | `/.well-known/oauth3-proxy` | Discovery endpoint |

## Deployment

```bash
# Build
docker build -t ghcr.io/amiller/oauth3-proxy:latest -f proxy/Dockerfile proxy/

# Push
docker push ghcr.io/amiller/oauth3-proxy:latest

# Update digest in deploy/docker-compose.yml, then:
phala deploy --cvm-id <VM_UUID> -c deploy/docker-compose.yml -e deploy/.env --wait
```

## Project Structure

```
proxy/src/
├── server.ts      # Express server, routes, approval pages, dashboard
├── analyzer.ts    # Three-layer Haiku review (static + constraints + args)
├── executor.ts    # Deno sandbox execution
├── database.ts    # SQLite storage (sessions, executions, secrets)
├── telegram.ts    # Optional Telegram bot integration
└── types.ts       # TypeScript types
deploy/
├── docker-compose.yml  # Phala CVM deployment config
├── .env                # Environment variables
└── ssh-cvm.sh          # SSH helper for CVM access
docs/
├── gnap-positioning.md       # GNAP/RFC 9635 positioning
└── prd-your-shell-or-mine.md # Future prototype PRD
```

## License

MIT
