# Roadmap

## Done

- TEE deployment on Phala CVM (dstack)
- Web-based approval pages served from TEE
- Session management with scope-based auto-approval
- Three-layer Haiku review (static analysis, constraint compliance, arg review)
- Natural-language constraints on scopes
- Web dashboard for browsing sessions and executions
- Bearer token auth on internal endpoints
- Long-poll status endpoint (`?wait=true`, 120s)
- Push notifications to agent on status changes
- Dry run mode
- Discovery endpoint (`/.well-known/oauth3-proxy`)
- Inline `skill_code` in execute requests
- `gh-gateway` — GitHub CLI interception via `GH_HOST` rewrite
- `phala-gateway` — Phala CLI interception pattern

## In Progress

- Agent adoption of long-poll (replacing file-based notification)
- Push notification listener on openclaw side

## Future

- **Static/dynamic arg review refinement** — cache code analysis by hash, only re-run arg review per invocation (#14)
- **Scope-approved destructive actions** — Haiku inconsistently gates destructive ops even when scope allows them (#9)
- **Rename skill → scope** — terminology cleanup throughout codebase
- **IP-based auth** — allow requests from known IPs without bearer token
- **Constraint counters** — "allow up to N executions" with automatic session expiry
- **Multi-runtime support** — Python, Node in addition to Deno
