# OAuth3-OpenClaw Deployment Guide

This guide walks you through deploying the OAuth3-OpenClaw execution proxy on your host machine to provide secure secret management for OpenClaw agents.

## Overview

The execution proxy runs **outside** the agent's VM to provide a real isolation boundary. When your agent needs to run code that requires secrets (API keys, tokens, etc.), it submits an execution request to the proxy. You receive a Telegram notification with inline buttons to approve/deny the execution.

**Key Benefits:**
- Agent never receives plaintext secrets (when possible)
- Human approval required for all executions
- Trust levels: one-time, 24h, or always-trusted
- Automatic agent notifications via OpenClaw cron wake

## Prerequisites

- Node.js 18+ and npm
- Docker (for isolated execution sandbox)
- Telegram account
- OpenClaw gateway running (for cron wake notifications)

## Step 1: Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Save the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
4. Message your new bot and send `/start`
5. Get your chat ID by running:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
   ```
   Look for `"chat":{"id":123456789}` in the response

## Step 2: Install the Proxy

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/oauth3-openclaw.git
cd oauth3-openclaw/proxy

# Install dependencies
npm install

# Build TypeScript
npm run build
```

## Step 3: Configure Secrets

Create a `.env` file in the `proxy/` directory:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_ID=703331076
PORT=3737
```

Add your actual API keys/secrets to the database (we'll provide a CLI tool for this soon):

```javascript
// For now, use the database directly
const db = new ProxyDatabase('./proxy.db');
await db.storeSecret('OPENAI_API_KEY', 'sk-...');
await db.storeSecret('ANTHROPIC_API_KEY', 'sk-ant-...');
```

## Step 4: Start the Proxy

```bash
# From the proxy/ directory
npm start
```

You should see:
```
✅ Telegram bot initialized
✅ Execution Proxy running on port 3737
📊 Database: ./proxy.db
🤖 Telegram: Configured
```

## Step 5: Configure Your Agent

Tell your agent about the proxy by adding to its workspace config:

```bash
# In your agent's workspace
echo "http://10.x.x.1:3737" > ~/.openclaw/execution-proxy-url
```

(Replace `10.x.x.1` with your host IP accessible from the agent's VM)

## Step 6: Test the Integration

From your agent's environment:

```bash
curl -X POST http://10.x.x.1:3737/execute \
  -H "Content-Type: application/json" \
  -d '{
    "skill_id": "test-hello",
    "skill_url": "https://gist.github.com/test/example",
    "secrets": ["OPENAI_API_KEY"],
    "code": "console.log(\"Key length:\", Deno.env.get(\"OPENAI_API_KEY\").length);",
    "metadata": {
      "description": "Test secret access",
      "secrets": ["OPENAI_API_KEY"],
      "network": ["api.openai.com"],
      "timeout": 5
    }
  }'
```

You should receive a Telegram message with approval buttons. Click "Run Once" and your agent will receive a cron wake notification with the result.

## Running as a Service (Optional)

### Using systemd

Create `/etc/systemd/system/oauth3-proxy.service`:

```ini
[Unit]
Description=OAuth3-OpenClaw Execution Proxy
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/oauth3-openclaw/proxy
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable oauth3-proxy
sudo systemctl start oauth3-proxy
sudo systemctl status oauth3-proxy
```

### Using Docker Compose

```yaml
version: '3.8'
services:
  oauth3-proxy:
    build: ./proxy
    ports:
      - "3737:3737"
    volumes:
      - ./proxy.db:/app/proxy.db
      - /var/run/docker.sock:/var/run/docker.sock  # For sandbox execution
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
      - PORT=3737
    restart: always
```

Run with:
```bash
docker-compose up -d
```

## Security Considerations

1. **Network isolation**: The proxy should only be accessible from your agent's VM, not the public internet
2. **Secret storage**: The SQLite database is encrypted at rest. Keep backups secure.
3. **Docker access**: The proxy needs Docker socket access to create isolated sandboxes. This is equivalent to root access.
4. **Telegram bot token**: Keep this secret. Anyone with the token can impersonate your bot.
5. **Host placement**: Run the proxy on the host machine (outside the agent's VM) for real isolation

## Troubleshooting

**Bot not responding:**
- Check bot token is correct in `.env`
- Verify you've sent `/start` to the bot
- Check logs: `npm start` should show "Telegram bot initialized"

**Agent not receiving notifications:**
- Verify OpenClaw gateway is running: `openclaw status`
- Check proxy logs for "Agent notified via cron wake"
- Test cron wake manually: `openclaw cron wake --text "test" --mode now`

**Execution failing:**
- Check Docker is running: `docker ps`
- Verify secrets exist in database
- Check network restrictions aren't too tight
- Review execution logs in proxy output

## Next Steps

- Configure additional secrets in the database
- Create reusable skills with documentation URLs
- Set up hash-based trust for frequently-used skills
- Monitor execution logs for security auditing

For more information, see [README.md](./README.md) and [PLAN.md](./PLAN.md).
