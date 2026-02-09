# Telegram Secret Manager - Implementation Plan

**Goal:** Build a local secret manager with Telegram approval workflow for AI agents

**Status:** Planning complete, ready for implementation

---

## Architecture Overview

```
┌──────────────────────────────────┐
│    Agent (OpenClaw/any agent)    │
│                                   │
│  get_secret("OPENAI_API_KEY")    │
└───────────────┬──────────────────┘
                │ HTTP POST /request
                ▼
┌──────────────────────────────────┐
│   Secret Manager Service         │
│   (Local, port 3737)             │
│                                   │
│   • SQLite database              │
│   • AES-256 encryption           │
│   • HTTP API                     │
│   • Telegram bot integration     │
└───────────────┬──────────────────┘
                │ Send approval request
                ▼
┌──────────────────────────────────┐
│   Telegram Bot API               │
│                                   │
│   Sends message to your Telegram │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│   Your Telegram Client           │
│                                   │
│   🔑 Agent requests:             │
│   OPENAI_API_KEY                 │
│   Reason: Complete task #123     │
│   Requested: 2m ago              │
│                                   │
│   [✅ Approve (5min)]            │
│   [❌ Deny]                      │
└───────────────┬──────────────────┘
                │ Click button
                ▼
┌──────────────────────────────────┐
│   Callback via Telegram Bot API  │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│   Secret Manager Updates DB      │
│                                   │
│   Status: APPROVED               │
│   Expires: NOW + 5 min           │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│   Agent polls /status endpoint   │
│   Gets secret (expires in 5min)  │
└──────────────────────────────────┘
```

---

## Component Breakdown

### 1. Storage Layer (SQLite + Encryption)

**Schema:**

```sql
-- Secrets table (encrypted values)
CREATE TABLE secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    encrypted_value BLOB NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Approval requests
CREATE TABLE approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    secret_name TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL, -- PENDING, APPROVED, DENIED, EXPIRED
    requested_at INTEGER NOT NULL,
    responded_at INTEGER,
    expires_at INTEGER,
    telegram_message_id INTEGER,
    FOREIGN KEY (secret_name) REFERENCES secrets(name)
);

-- Audit log
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    secret_name TEXT NOT NULL,
    action TEXT NOT NULL, -- REQUEST, APPROVE, DENY, ACCESS, EXPIRE
    timestamp INTEGER NOT NULL,
    details TEXT
);
```

**Encryption:**
- AES-256-GCM
- Master key from passphrase (PBKDF2, 100k iterations)
- Salt stored with encrypted value

### 2. HTTP API (Express.js)

**Endpoints:**

```typescript
// Secret management (protected, local only)
POST   /secrets              # Add new secret
GET    /secrets              # List all secret names
DELETE /secrets/:name        # Delete secret

// Agent API (used by agents)
POST   /request              # Request secret approval
GET    /status/:request_id   # Check approval status
GET    /secret/:request_id   # Get approved secret (if valid)

// Telegram webhook
POST   /webhook              # Receive Telegram updates

// Admin
GET    /audit               # View audit log
GET    /health              # Health check
```

**Request Secret Flow:**

```bash
POST /request
{
  "secret_name": "OPENAI_API_KEY",
  "reason": "Complete user task: summarize document",
  "duration_minutes": 5  // optional, default 5
}

Response:
{
  "request_id": "req_abc123",
  "status": "pending",
  "message": "Approval request sent to Telegram"
}
```

**Check Status:**

```bash
GET /status/req_abc123

Response (pending):
{
  "status": "pending",
  "requested_at": "2026-02-09T14:42:00Z"
}

Response (approved):
{
  "status": "approved",
  "expires_at": "2026-02-09T14:47:00Z",
  "time_remaining_seconds": 180
}
```

**Get Secret:**

```bash
GET /secret/req_abc123

Response (if approved and not expired):
{
  "secret_value": "sk-proj-abc123...",
  "expires_at": "2026-02-09T14:47:00Z"
}

Response (if expired):
{
  "error": "Secret access expired",
  "status": "expired"
}
```

### 3. Telegram Bot Integration

**Bot Setup:**
1. Create bot via @BotFather
2. Get bot token
3. Set webhook OR use long polling

**Approval Message Format:**

```
🔑 Secret Request

Name: OPENAI_API_KEY
Requested by: Agent
Reason: Complete user task: summarize document
Time: 2 minutes ago

[✅ Approve (5min)] [❌ Deny]
```

**Callback Handling:**

```typescript
interface CallbackData {
  action: 'approve' | 'deny',
  request_id: string
}

// Callback format: "approve:req_abc123" or "deny:req_abc123"
```

**Response to User:**

```
✅ Approved!
Secret: OPENAI_API_KEY
Valid for: 5 minutes
Expires: 14:47:00 EST
```

---

## Security Features

1. **Encrypted Storage**
   - AES-256-GCM encryption
   - Keys never stored in plaintext
   - Master passphrase required on startup

2. **Time-Limited Access**
   - Secrets expire after N minutes (default 5)
   - Automatic cleanup of expired requests

3. **Approval Required**
   - Every secret request needs human approval
   - No automatic approvals

4. **Audit Trail**
   - All actions logged
   - Timestamps + reasons recorded

5. **Local Only**
   - HTTP API binds to 127.0.0.1 only
   - No external access
   - Secrets never leave the machine (except via Telegram for approval UI)

6. **Single Use Tokens**
   - Each request_id is single-use
   - After retrieval, marked as "accessed"

---

## File Structure

```
telegram-secret-manager/
├── src/
│   ├── server.ts           # Main HTTP server
│   ├── telegram.ts         # Telegram bot integration
│   ├── storage.ts          # SQLite + encryption
│   ├── crypto.ts           # Encryption utilities
│   └── types.ts            # TypeScript interfaces
├── tests/
│   ├── integration.test.ts # Full workflow tests
│   ├── storage.test.ts     # Storage layer tests
│   └── crypto.test.ts      # Encryption tests
├── scripts/
│   ├── setup.sh            # Initial setup
│   ├── add-secret.sh       # CLI to add secrets
│   └── test-flow.sh        # End-to-end test script
├── docs/
│   ├── telegram-bot-api-reference.md
│   └── TESTING.md
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "node-telegram-bot-api": "^0.64.0",
    "better-sqlite3": "^9.2.2",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@types/express": "^4.17.21",
    "@types/better-sqlite3": "^7.6.8",
    "typescript": "^5.3.3",
    "vitest": "^1.1.0"
  }
}
```

**Using Node.js built-in crypto** (no external crypto libs needed)

---

## Testing Strategy

### Phase 1: Unit Tests (Local)
- Encryption/decryption correctness
- Database operations
- Request/response parsing

### Phase 2: Integration Tests (Mock Telegram)
- Full approval workflow with mocked Telegram API
- Timeout handling
- Expiration logic

### Phase 3: Live Testing (Real Telegram)
- Real bot with Andrew's Telegram
- Test approval/deny flows
- Measure latency

### Phase 4: Agent Integration
- OpenClaw agent requesting secrets
- Verify secrets work in real API calls
- Test error handling

---

## Implementation Phases

### Phase 1: Core Storage (1 hour)
- [x] Project structure
- [ ] SQLite schema
- [ ] Encryption utilities
- [ ] Storage layer with tests

### Phase 2: HTTP API (1 hour)
- [ ] Express server
- [ ] Request/status/secret endpoints
- [ ] Basic error handling
- [ ] Health check

### Phase 3: Telegram Integration (1.5 hours)
- [ ] Telegram bot setup
- [ ] Approval message sending
- [ ] Callback handling
- [ ] Message editing on response

### Phase 4: Testing & Polish (1 hour)
- [ ] Integration test suite
- [ ] CLI tools (add-secret.sh)
- [ ] Documentation
- [ ] Example OpenClaw integration

---

## Configuration

```bash
# .env
BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_user_id
MASTER_PASSPHRASE=your_strong_passphrase
PORT=3737
DATABASE_PATH=./secrets.db
DEFAULT_APPROVAL_DURATION_MINUTES=5
```

---

## Deployment Options (Updated Feb 9, 15:05)

### Option A: Proxy on Host (Docker/Systemd)
**Isolation:** Multipass VM boundary  
**Setup:** Docker compose on host machine  
**Security:** Agent cannot access host filesystem/DB  
**Complexity:** Low  
**Best for:** Production use  

### Option B: Nested VM
**Isolation:** Agent creates VM, host takes ownership  
**Setup:** QEMU nested VM with ownership transfer  
**Security:** Agent cannot access VM internals after transfer  
**Complexity:** Medium  
**Best for:** Maximum isolation without TEE hardware  
**See:** `docs/NESTED-VM-ISOLATION.md`

### Option C: Asymmetric Encryption
**Isolation:** Cryptographic (age/GPG)  
**Setup:** Agent has public key only  
**Security:** Agent cannot decrypt (no private key)  
**Complexity:** Low  
**Best for:** Simple deployment, cryptographic guarantee  

---

## Proxy Modes

### Mode 1: Direct Secret Retrieval
```
Agent requests secret → Telegram approval → Gets plaintext (5min expiry)
```
**Use for:** Passwords, tokens, generic secrets

### Mode 2: API Key Injection (BotMaker pattern)
```
Agent: POST /proxy/openai/chat/completions
Proxy: Validates, injects real API key, forwards
Agent: Never sees API key
```
**Use for:** OpenAI, Anthropic, etc. (prevents leaks)  
**See:** `docs/BOTMAKER-ANALYSIS.md`

---

## Next Steps

1. **Decide deployment option** (A, B, or C)
2. **Get bot token from Andrew**
3. **Build proxy** (2-3 hours)
   - Storage layer + encryption
   - HTTP API
   - Telegram bot integration
4. **Test locally** (Docker on host)
5. **Deploy chosen option**
6. **Live test with Andrew**
7. **Integrate with OpenClaw agent**

---

## Success Criteria

✅ Agent can request secret  
✅ Andrew receives Telegram notification  
✅ Andrew can approve/deny via buttons  
✅ Agent retrieves approved secret  
✅ Secret expires after 5 minutes  
✅ All actions logged to audit trail  
✅ Secrets encrypted at rest  
✅ Works with any secret (API keys, passwords, crypto keys)  
✅ **Agent cannot access secrets without approval** (enforced by chosen isolation method)
