# PR Draft: phala-gateway — OAuth3 MITM for Phala CLI

**Branch:** `feature/phala-gateway-mitm`  
**Base:** `feature/phala-cvm-deployment`

## Summary

Adds a local HTTP gateway that intercepts `phala` CLI calls and proxies them through the OAuth3 execution sandbox. The Phala API key never leaves the OAuth3 Deno sandbox — the host process only ever holds a placeholder string.

## Motivation

The `phala` CLI needs a real API key to operate. Without this gateway:
- The key must be on disk or in the host env (insecure)
- Skills in the Deno sandbox can't spawn the CLI binary
- No audit trail of what the agent did with the key

With the gateway, an agent running in a dstack CVM can manage Phala deployments with the same account-encumbrance guarantees as any other OAuth3 operation.

## How It Works

1. `phala-tee` wrapper sets `PHALA_CLOUD_API_PREFIX=http://127.0.0.1:3738` and a dummy `PHALA_CLOUD_API_KEY=placeholder`
2. The `phala` CLI makes HTTP calls to the gateway instead of `cloud-api.phala.com`
3. The gateway dynamically generates a Deno skill that re-issues the same HTTP request but with the real API key injected from the OAuth3 secret store
4. The skill runs against a pre-approved `session_id` — zero human interaction after initial setup
5. Response flows back through the gateway to the CLI

## Key Design Decisions

**Why not just use a Deno skill directly?**  
The Deno sandbox can't spawn the `phala` binary. The CLI handles complex multi-step flows (provision + commit, env encryption, etc.) that would be painful to reimplement in pure Deno.

**Why MITM instead of storing the key?**  
The key stays inside OAuth3's encrypted secret store. The gateway only holds the OAuth3 bearer token (which permits executing skills, not reading secrets).

**Why a scoped session?**  
One-time human approval. After that, calls complete in ~1-2 seconds with zero interaction. The session policy can constrain which CVMs the agent can touch — strong encumbrance guarantee.

## Changes

### New: `phala-gateway/`
- `server.js` — Node.js HTTP server on `localhost:3738`
  - Intercepts all `phala` CLI HTTP calls
  - Wraps each as a Deno skill submitted to OAuth3 with a pre-approved session
  - Parses skill output and relays response to CLI
- `phala-tee.sh` — Wrapper script (`phala-tee <cmd>`)
  - Auto-starts gateway if not running
  - Sets correct env vars transparently
- `README.md` — Architecture, setup, security properties

### New: `examples/phala-deploy-cvm.ts`
Direct REST API deploy skill (used during development, before gateway was built).

### Modified: `examples/phala-list-cvms.ts`
Updated to use correct `cloud-api.phala.com` base URL.

## Demo

```bash
# List CVMs — no approval needed, completes in ~1.5s
phala-tee cvms list --json

# Deploy a new CVM
phala-tee deploy --compose docker-compose.yml --name my-cvm --json

# Update an existing CVM
phala-tee deploy --cvm-id app_379bf0f2 --compose updated.yml --json
```

Live deployment during development:
- `clawteedah-hello` deployed to `266b6532-e22c-4981-bc57-a76bc82dd71a`
- Dashboard: https://cloud.phala.com/dashboard/cvms/266b6532-e22c-4981-bc57-a76bc82dd71a

## Future Work

- [ ] **Session renewal** — Auto-create new session when current one expires
- [ ] **CVM-scoped sessions** — Constraint text like "only app_id X" enforced by OAuth3 LLM analyzer
- [ ] **Request signing** — Gateway could sign requests so OAuth3 can verify they came from the gateway (not a rogue skill)
- [ ] **Rate limiting** — Prevent runaway deploy loops
- [ ] **Dockerfile** — Bundle gateway into the dstack CVM image

## Testing

Tested manually:
- `phala-tee cvms list` ✅ returns 20 CVMs
- `phala-tee deploy` ✅ full provision+commit cycle
- Gateway auto-start ✅
- Key never visible in host process env ✅
