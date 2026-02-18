# Roadmap

## Now

- Haiku inconsistency on scope-approved destructive ops (#9)
- Agent adoption of long-poll workflow
- `.env.example` for deploy setup

## Next

- Constraint counters — "allow up to N executions" with auto-expiry
- Multi-runtime (Python, Node alongside Deno)
- IP-based auth for known agent hosts

## Later

- Multi-tenant: one TEE serves many users' agents ([PRD](docs/prd-your-shell-or-mine.md))
- GNAP-compatible grant negotiation ([positioning](docs/gnap-positioning.md))
- Attested audit log — cryptographic proof of what ran and when
