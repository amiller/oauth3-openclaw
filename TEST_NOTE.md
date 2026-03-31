# Test Note

Added by clawTEEdah on 2026-02-18 via gh-tee + OAuth3 gateway.

## What this demonstrates

- Feature branch created locally, pushed via `gh-tee` (GitHub CLI MITM proxy)
- `GITHUB_TOKEN` never touched the host process
- All GitHub API calls routed through OAuth3 session `session_200a77f05aafab1c`
- Scope pre-approved once by Andrew; branch push + PR creation auto-approved by Haiku constraint review
- Haiku checks each call against: "Only interact with amiller/oauth3-openclaw, feature branches only, no main commits"

## The pattern

```
gh-tee push → gh-gateway (localhost:3739) → OAuth3 /execute → Haiku constraint check → api.github.com
```

One human approval (scope) → many auto-approved API calls. 🦞🔐
