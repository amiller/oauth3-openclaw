# oauth3-proxy as dstack Sidecar

Run oauth3-proxy alongside OpenClaw in a Phala Cloud CVM. The agent gets human-approved secret injection via Telegram, with Deno skills executing directly inside the TEE.

## Architecture

```
┌─ Phala CVM (dstack) ──────────────────────────────┐
│                                                     │
│  ┌─ openclaw ──────────────────────────────────┐   │
│  │  OpenClaw gateway + agent                    │   │
│  │  POST http://oauth3-proxy:3737/execute  ──────── │
│  └──────────────────────────────────────────────┘   │
│                          │                          │
│  ┌─ oauth3-proxy ────────▼─────────────────────┐   │
│  │  Receives execution request                  │   │
│  │  Sends Telegram approval (Run Once / Deny)   │   │
│  │  On approval: runs Deno skill directly       │   │
│  │  Secrets injected as env vars, never leaked  │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Prerequisites

- Existing OpenClaw Phala CVM deployment ([phala-deploy](https://github.com/h4x3rotab/openclaw/tree/phala-deploy))
- Telegram bot token (you likely already have one for OpenClaw)
- Your Telegram chat ID

## Setup

### 1. Add to your docker-compose.yml

Add the `oauth3-proxy` service to your existing `phala-deploy/docker-compose.yml`:

```yaml
  oauth3-proxy:
    image: ghcr.io/amiller/oauth3-proxy:latest
    container_name: oauth3-proxy
    environment:
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID:-}
      PORT: "3737"
      DB_PATH: /data/proxy.db
      EXECUTOR_MODE: direct
    volumes:
      - oauth3_data:/data
    restart: unless-stopped
    networks:
      - internal
```

Add the network and volume to your existing definitions:

```yaml
networks:
  internal:
    driver: bridge

volumes:
  # ... your existing volumes ...
  oauth3_data:
```

And add `networks: [internal]` to your existing `openclaw` service.

### 2. Add env vars to secrets/.env

```
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 3. Deploy

```bash
phala deploy --cvm-id YOUR_CVM_ID \
  --compose docker-compose.yml \
  -e secrets/.env
```

## How the Agent Uses It

From inside the openclaw container, the agent POSTs to the proxy:

```bash
curl -X POST http://oauth3-proxy:3737/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "skill_id": "my-skill",
    "skill_url": "https://gist.githubusercontent.com/.../skill.ts",
    "secrets": ["OPENAI_API_KEY"],
    "args": {"prompt": "Hello"}
  }'
```

The proxy sends a Telegram approval request. On approval, the skill runs with secrets injected. The agent polls `/execute/:id/status` for results.

## Security Model

- **TEE isolation**: Both containers run inside the CVM. The TEE is the outer sandbox.
- **Deno permissions**: Skills run with `--allow-net` and `--allow-env` restricted to declared values only.
- **Clean env**: Proxy secrets (`TELEGRAM_BOT_TOKEN`, etc.) are never passed to skill processes. Only declared skill secrets are injected.
- **No Docker socket**: The oauth3-proxy container is not privileged and has no Docker access.
- **Network isolation**: oauth3-proxy has no external ports. Only the openclaw container can reach it.

## Verification

```bash
# Health check from openclaw container
curl http://oauth3-proxy:3737/health

# Test env isolation — this skill should NOT see TELEGRAM_BOT_TOKEN
curl -X POST http://oauth3-proxy:3737/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "skill_id": "test-isolation",
    "skill_url": "data:text/typescript,console.log(Deno.env.get(\"TELEGRAM_BOT_TOKEN\") || \"NOT ACCESSIBLE\")",
    "secrets": []
  }'
```

## See Also

- [docker-compose-sidecar.yaml](./docker-compose-sidecar.yaml) — full reference compose
- [../README.md](../README.md) — oauth3-openclaw overview
- [../DEPLOYMENT.md](../DEPLOYMENT.md) — standalone deployment guide
