# OAuth3-OpenClaw

**Human-approved secret management and execution sandbox for OpenClaw agents.**

OAuth3-OpenClaw provides a secure execution proxy that enables AI agents to request access to secrets (API keys, tokens, credentials) with explicit human approval via Telegram. The agent submits code for execution, you review and approve via inline buttons, and the proxy runs the code in an isolated Docker sandbox with time-limited secret access.

🔗 **GitHub:** https://github.com/claw-tee-dah/oauth3-openclaw  
📋 **Status:** ✅ Fully functional (see [TESTING-RESULTS.md](./TESTING-RESULTS.md))  
📖 **Host Setup:** See [DEPLOYMENT.md](./DEPLOYMENT.md) for step-by-step instructions

## Why OAuth3?

Traditional OAuth requires the service provider to implement flows and trust boundaries. **OAuth3** inverts this: the **resource owner** (you) runs the authorization server, and agents request delegated access through human approval. Think of it as "OAuth for AI agents where you are the provider."

Key properties:
- **Human in the loop**: Every execution requires your explicit approval
- **Real isolation**: Agent never receives plaintext secrets (when possible)
- **Trust levels**: Approve once, trust for 24h, or always trust based on code hash
- **Auditable**: All requests and approvals logged to SQLite
- **Agent notifications**: Automatic cron wake events notify your agent of approval/denial

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Agent (Multipass VM)                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ OpenClaw Agent                                        │  │
│  │   - Prepares execution request (code + secrets list)  │  │
│  │   - Sends POST /execute to proxy                      │  │
│  │   - Waits for cron wake notification                  │  │
│  │   - Never receives plaintext secrets                  │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (10.x.x.1:3737)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Host Machine                                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ OAuth3 Execution Proxy                                │  │
│  │   - Receives execution request                        │  │
│  │   - Computes code hash                                │  │
│  │   - Checks trust DB (hash-based approval)             │  │
│  │   - Sends Telegram approval request                   │  │
│  │   - On approval: creates Docker sandbox               │  │
│  │   - Injects secrets as environment variables          │  │
│  │   - Executes code with network restrictions           │  │
│  │   - Sends cron wake to agent                          │  │
│  │   - Returns result                                    │  │
│  │   - Destroys sandbox                                  │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          │ Telegram Bot API                  │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ You (via Telegram)                                    │  │
│  │   - Receive approval request with inline buttons      │  │
│  │   - Click: Run Once / Trust 24h / Always Trust / Deny │  │
│  │   - View code on GitHub before approving              │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Features

### ✅ Implemented

- **Telegram approval workflow** with inline buttons
- **Telegram secret management** - Add secrets via `/add_secret` command (see [TELEGRAM-COMMANDS.md](./TELEGRAM-COMMANDS.md))
- **Docker sandbox execution** (Deno runtime by default)
- **Network restrictions** (allow-list specific domains)
- **Resource limits** (memory, CPU, timeout)
- **Code hash verification** for trust levels
- **SQLite storage** for approvals and audit logs
- **OpenClaw integration** via notification system
- **Skill metadata** (description, required secrets, network access)

### 🚧 Roadmap

- **CLI tool** for secret management (`oauth3 secret add OPENAI_API_KEY`)
- **Skill registry** with hash-based verification
- **GitHub Gist integration** for skill documentation hosting
- **Multi-runtime support** (Deno, Node, Python, QuickJS)
- **BotMaker pattern** for LLM API proxying (header rewriting)
- **Web UI** for approval management and audit logs
- **Nested VM option** for even stronger isolation

## Quick Start

### 🚀 For Host (Deploy the Proxy)

**→ See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete step-by-step instructions.**

**TL;DR:**
```bash
git clone https://github.com/claw-tee-dah/oauth3-openclaw.git
cd oauth3-openclaw/proxy
npm install
cp .env.example .env
# Edit .env with your Telegram bot token and chat ID
npm run build
npm start
```

Then configure your agent to submit requests to `http://YOUR_HOST_IP:3737/execute`

### For Users (Agent Integration)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for agent-side setup instructions.

**TL;DR:**
1. Create a Telegram bot via @BotFather
2. Clone this repo and run `npm install` in `proxy/`
3. Create `.env` with bot token and chat ID
4. Run `npm start`
5. Agent sends execution requests to `http://host:3737/execute`
6. You approve via Telegram, agent gets notified via cron wake

### For Developers (Build & Test)

```bash
# Clone and install
git clone https://github.com/YOUR_USERNAME/oauth3-openclaw.git
cd oauth3-openclaw/proxy
npm install

# Set up test environment
cp .env.example .env
# Edit .env with your test bot token

# Build TypeScript
npm run build

# Run in development mode (auto-reload)
npm run dev

# Run tests (coming soon)
npm test
```

## API Reference

### POST /execute

Submit code for execution with required secrets.

**Request:**
```json
{
  "skill_id": "openai-completion",
  "skill_url": "https://gist.github.com/user/abc123",
  "secrets": ["OPENAI_API_KEY"],
  "code": "const response = await fetch('https://api.openai.com/v1/chat/completions', {\n  method: 'POST',\n  headers: {\n    'Authorization': `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({model: 'gpt-4', messages: [{role: 'user', content: 'Hello!'}]})\n});\nconsole.log(await response.json());",
  "metadata": {
    "description": "Send a chat completion request to OpenAI",
    "secrets": ["OPENAI_API_KEY"],
    "network": ["api.openai.com"],
    "timeout": 30
  }
}
```

**Response (pending approval):**
```json
{
  "status": "pending",
  "request_id": "req_abc123",
  "message": "Approval request sent to Telegram"
}
```

**Response (auto-approved via hash trust):**
```json
{
  "status": "success",
  "request_id": "req_abc123",
  "stdout": "{\"id\":\"chatcmpl-...\",\"choices\":[...]}",
  "stderr": "",
  "duration": 1234,
  "trusted": true
}
```

### GET /health

Check proxy status.

**Response:**
```json
{
  "status": "ok",
  "telegram": "connected",
  "database": "ok"
}
```

## Development Guide

### Project Structure

```
oauth3-openclaw/
├── proxy/                    # Execution proxy server
│   ├── src/
│   │   ├── server.ts        # Main Express server
│   │   ├── telegram.ts      # Telegram bot integration
│   │   ├── executor.ts      # Docker sandbox execution
│   │   ├── database.ts      # SQLite storage
│   │   └── types.ts         # TypeScript type definitions
│   ├── dist/                # Compiled JavaScript (generated)
│   ├── package.json
│   └── tsconfig.json
├── docs/
│   ├── PLAN.md              # Original design document
│   ├── TESTING.md           # Test strategy
│   ├── BOTMAKER-ANALYSIS.md # BotMaker pattern analysis
│   └── NESTED-VM-ISOLATION.md
├── DEPLOYMENT.md            # Host deployment guide
└── README.md                # This file
```

### Building from Source

```bash
cd proxy
npm install
npm run build  # Compiles TypeScript to dist/
```

### Development Mode

Auto-recompile on file changes:
```bash
npm run dev
```

Or use `tsc --watch` in a separate terminal:
```bash
npx tsc --watch  # Terminal 1
npm start        # Terminal 2 (restart manually on changes)
```

### Adding a New Runtime

The executor currently supports Deno. To add support for Node, Python, or other runtimes:

1. Edit `src/executor.ts`
2. Add a new `execute${Runtime}` method
3. Create appropriate Docker image (see `Dockerfile.deno` example)
4. Update `executeCode()` to dispatch based on skill metadata

Example for Node.js:
```typescript
private async executeNode(
  code: string,
  secrets: Record<string, string>,
  metadata: ExecutionMetadata
): Promise<ExecutionResult> {
  const image = 'node:22-alpine';
  const env = Object.entries(secrets)
    .map(([k, v]) => `--env ${k}="${v}"`)
    .join(' ');
  
  // Write code to temp file
  const tmpFile = `/tmp/skill-${Date.now()}.js`;
  await fs.writeFile(tmpFile, code);
  
  const cmd = `docker run --rm ${env} --network none -v ${tmpFile}:/app/script.js ${image} node /app/script.js`;
  // ... execute and handle result
}
```

### Database Schema

The proxy uses SQLite with three main tables:

**secrets** - Encrypted secret storage
```sql
CREATE TABLE secrets (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**approvals** - Trust levels by code hash
```sql
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  skill_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  trust_level TEXT CHECK(trust_level IN ('once', '24h', 'forever')),
  approved_at INTEGER NOT NULL,
  expires_at INTEGER,
  UNIQUE(skill_id, code_hash)
);
```

**executions** - Audit log
```sql
CREATE TABLE executions (
  id INTEGER PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  skill_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending', 'approved', 'denied', 'success', 'failed')),
  approved BOOLEAN DEFAULT FALSE,
  executed_at INTEGER,
  duration_ms INTEGER,
  result TEXT,
  created_at INTEGER NOT NULL
);
```

### Testing Tips

1. **Test bot locally first**: Use a personal bot token and send `/start` before integrating with agents
2. **Mock Docker in tests**: Use `docker run hello-world` to verify Docker access without secrets
3. **Test approval flow**: Send a request, approve via Telegram, verify agent receives cron wake
4. **Check isolation**: Try to escape the sandbox (you shouldn't be able to)
5. **Test trust levels**: 
   - Run same code twice → first requires approval, second is auto-approved (24h)
   - Change one character → new hash, requires re-approval
   - Always-trust → survives restarts

### Debugging

**Enable verbose logging:**
```bash
DEBUG=* npm start
```

**Check Docker sandbox logs:**
```bash
docker ps -a  # Find recent containers
docker logs <container_id>
```

**Inspect database:**
```bash
sqlite3 proxy.db
.tables
SELECT * FROM executions ORDER BY created_at DESC LIMIT 10;
```

**Test cron wake manually:**
```bash
openclaw cron wake --text "Test notification" --mode now
```

## Security Model

### Threat Model

**What we protect against:**
- ✅ Agent stealing secrets directly (secrets stored encrypted, injected at runtime)
- ✅ Agent running untrusted code without approval (human in the loop)
- ✅ Agent accessing network resources not explicitly allowed (Docker network restrictions)
- ✅ Agent consuming excessive resources (memory/CPU/time limits)
- ✅ Replay attacks (code hash verification, time-limited trust)

**What we DON'T protect against:**
- ❌ Agent social engineering the human into approving malicious code (always review!)
- ❌ Compromised Docker daemon (proxy needs Docker socket access = root equivalent)
- ❌ Side-channel attacks (not a TEE, just process isolation)
- ❌ Secrets leaked in execution output (agent sees stdout/stderr)

### Isolation Boundaries

1. **Agent ↔ Proxy**: Network boundary (VM to host). Agent cannot access proxy's filesystem or SQLite DB.
2. **Proxy ↔ Sandbox**: Docker container with no volume mounts (except code), restricted network, read-only filesystem (when possible).
3. **Sandbox ↔ External APIs**: Network allow-list enforced via Docker DNS + iptables.

### Trust Assumptions

- **You trust the proxy**: It runs on your host with Docker access (root equivalent).
- **You trust your Telegram account**: Anyone with access can approve executions.
- **You trust the code you approve**: Always review before clicking "Run Once" or "Always Trust".
- **You trust Docker isolation**: This is standard Linux container isolation, not hardware TEE.

## Future: BotMaker Pattern for LLM APIs

The current implementation focuses on general code execution. A future version will support the **BotMaker pattern** for LLM API proxying:

**How it works:**
1. Agent sends request to proxy with: `Authorization: Bearer bot_proxy_token`
2. Proxy validates token (SHA256 lookup in DB)
3. Proxy decrypts real API key
4. Proxy **removes** agent's Authorization header
5. Proxy **adds** real header: `Authorization: Bearer sk-real-openai-key`
6. Proxy forwards to upstream API
7. Agent receives response (never sees real key)

**Benefits:**
- Works for 22+ LLM providers (OpenAI, Anthropic, Google, Groq, DeepSeek, Mistral, etc.)
- No code execution needed (just HTTP header rewriting)
- Agent can make multiple API calls with one approval
- Upstream API never knows it's an agent (no special integration required)

See `docs/BOTMAKER-ANALYSIS.md` for full details.

## Contributing

Contributions welcome! Please:
1. Read the code of conduct (coming soon)
2. Check existing issues and discussions
3. Open an issue before major changes
4. Include tests with PRs
5. Follow existing code style

## License

MIT - see LICENSE file

## Credits

- **BotMaker pattern**: Inspired by [@jgarzik/botmaker](https://github.com/jgarzik/botmaker)
- **OpenClaw**: Built for the [OpenClaw](https://openclaw.ai) agent framework
- **OAuth3 concept**: Extending OAuth principles to agent authorization

---

Built with ☕ by AI agents, for AI agents (with human supervision).
