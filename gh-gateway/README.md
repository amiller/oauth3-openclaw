# gh-gateway

OAuth3 MITM proxy for the `gh` CLI. Intercepts all GitHub API calls (REST + GraphQL) and proxies them through the OAuth3 execution sandbox, so `GITHUB_TOKEN` never touches the host process.

## Architecture

```
gh-tee repo list ...
    │
    ▼
gh CLI  (GH_HOST=localhost:3739, GH_TOKEN=placeholder)
    │  HTTPS calls to localhost:3739
    ▼
gh-gateway (localhost:3739, self-signed TLS)
    │  wraps each call as a Deno skill with pre-approved session_id
    ▼
OAuth3 proxy → injects real GITHUB_TOKEN in sandbox
    │
    ▼
api.github.com  ← real API call (REST or GraphQL)
```

**GITHUB_TOKEN never leaves the OAuth3 sandbox.**

## Setup

### 1. Install self-signed cert (one-time)

```bash
# Generate cert
openssl req -x509 -newkey rsa:2048 -keyout /opt/gh-gateway/certs/key.pem \
  -out /opt/gh-gateway/certs/cert.pem -days 365 -nodes \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

# Trust it (so gh CLI accepts it)
cp /opt/gh-gateway/certs/cert.pem /usr/local/share/ca-certificates/gh-gateway.crt
update-ca-certificates
```

### 2. Start the gateway

```bash
OAUTH3_SESSION_ID=session_xxxx \
OAUTH3_BEARER_TOKEN=$OAUTH3_BEARER_TOKEN \
node gh-gateway/server.js &
```

### 3. Use gh-tee

```bash
gh-tee api /user
gh-tee repo list --limit 5
gh-tee pr list --repo amiller/oauth3-openclaw
gh-tee issue create --title "..." --body "..."
```

## Notes

- `gh` caches GraphQL responses at `~/.cache/gh/`. Clear it if you hit stale 404s: `rm -rf ~/.cache/gh`
- `gh` with `GH_HOST` uses GHE path format: `/api/v3/X` (REST) and `/api/graphql` (GraphQL). The gateway normalizes these to standard GitHub API paths.
- TLS is required — `gh` won't connect to a non-HTTPS host even on localhost.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH3_URL` | `http://oauth3-proxy:3737` | OAuth3 proxy endpoint |
| `OAUTH3_BEARER_TOKEN` | (required) | Bearer token for OAuth3 auth |
| `OAUTH3_SESSION_ID` | (required) | Pre-approved session ID |
| `GH_GATEWAY_PORT` | `3739` | Port to listen on |
