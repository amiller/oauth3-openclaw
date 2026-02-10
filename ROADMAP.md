# OAuth3-OpenClaw Roadmap

## Current Status (v0.1 - MVP)

✅ Self-hosted deployment model
- Each user creates their own Telegram bot via @BotFather
- Runs proxy server on their own host
- Secrets stored in their own instance
- Full control and privacy

## Future Features

### 🔐 Hosted TEE Service (v0.5 - Planned)

**Goal:** Lower barrier to entry - users don't need to set up their own bot or server.

**Architecture:**
- **Shared public bot** (@OAuth3Bot or similar)
- **Runs in dstack TEE** (Intel TDX/SGX)
- **Provably secure** - users can verify:
  - Exact code running via attestation
  - Their secrets isolated in TEE memory
  - Multi-tenant isolation guarantees
  - No operator access to plaintext secrets

**User flow:**
1. Message @OAuth3Bot
2. Bot provides attestation quote
3. User verifies code hash matches published source
4. User adds secrets via Telegram (encrypted in transit, isolated in TEE)
5. Agent submits execution requests to `https://oauth3.dstack.app/execute`
6. User approves via Telegram
7. Code executes in isolated TEE container

**Benefits over self-hosted:**
- ✅ No BotFather setup
- ✅ No server deployment
- ✅ Just works™
- ✅ Still provably secure (TEE attestation)
- ✅ Pay-as-you-go pricing (per execution)

**Revenue model:**
- Free tier: 100 executions/month
- Pro: $10/mo for 1000 executions
- Enterprise: Custom limits + SLA

**Technical requirements:**
- dstack deployment with public endpoint
- Attestation quote API for verification
- Per-user secret isolation in TEE memory
- Execution metering/billing
- GitHub Actions for reproducible builds

**Security guarantees:**
- **TEE isolation:** Each user's secrets in separate memory pages
- **Code verification:** Attestation proves exact source
- **Audit trail:** All executions logged immutably
- **Key rotation:** Secrets re-encrypted on TEE restart
- **No admin access:** Even operators can't read secrets

**Implementation notes:**
- Use dstack DevProof pattern for trust
- Publish reproducible build instructions
- Provide verification CLI tool
- Document threat model clearly
- Regular third-party security audits

### 📊 Analytics & Monitoring (v0.3)

- Execution history dashboard
- Secret usage analytics
- Cost tracking per secret/skill
- Anomaly detection (unusual execution patterns)

### 🔑 Advanced Secret Management (v0.2)

- Persistent encrypted storage (SQLite + libsodium)
- Secret expiration/rotation
- Secret scoping (per-skill, per-domain)
- Import/export secrets (encrypted backup)
- Secret sharing between agents (with approval)

### 🛡️ Enhanced Security (v0.4)

- 2FA for approval flow
- IP whitelisting for execution requests
- Rate limiting per agent
- Anomaly detection
- Audit logs with signatures

### 🎨 Better UX (v0.2)

- Web dashboard for secret management
- Mobile app for approvals
- Browser extension for one-click approval
- Slack/Discord integration

### 🏗️ Verified Skills Program (v0.3)

**Problem:** Users can't audit code themselves.

**Solution 1: "Discuss with Claude" links**
- Add to every Gist/skill page
- Pre-load code into Claude chat
- Users ask: "Is this safe? What does it do?"
- AI-assisted code review for non-technical users

**Solution 2: Verified Skills Repository**
- `oauth3-verified-skills` - curated, security-reviewed scripts
- Hash-based trust tracking
- Bot shows "✅ Verified by OAuth3 Team" badge
- Users trust the script, approve the USE
- Security reviews by experts
- Community contribution model

**Implementation:**
- Repository: https://github.com/oauth3/verified-skills (TBD)
- API: `GET /api/v1/skills/{hash}` returns verification metadata
- Bot checks hash on every execution
- Annual re-reviews for security

See [USER-JOURNEY.md](./docs/USER-JOURNEY.md) for full details.

## Contributing

Have ideas for the roadmap? Open an issue or PR!

**Priority:** TEE-hosted service is the most impactful feature - combines security with ease of use.
