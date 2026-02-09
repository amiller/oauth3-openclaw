# BotMaker Architecture Analysis

**Source:** https://github.com/jgarzik/botmaker  
**Relevance:** Solves the EXACT problem Andrew identified with our original plan

---

## 🎯 **The Problem Andrew Identified**

**Our original plan:**
- Secret manager runs as same user (node)
- Agent can access SQLite DB file
- Agent can read master passphrase from .env
- Agent could decrypt secrets without approval

**Andrew's question:**
> "Does anything actually prevent you from being able to look at them?"

**Answer:** No. Even with different user, I have Docker access = root equivalent.

---

## 🔐 **BotMaker's Solution: Keyring-Proxy**

### **Architecture**

```
┌────────────────────────────────────────────────────┐
│           Docker Network: bm-internal              │
│                                                    │
│  ┌───────────────┐        ┌──────────────────┐    │
│  │   Agent Bot   │        │  keyring-proxy   │    │
│  │               │───────▶│                  │    │
│  │ Has: proxy    │ HTTP   │ Has: master key  │    │
│  │      token    │        │      real API    │    │
│  │               │        │      keys        │    │
│  │ NO access to  │        │                  │    │
│  │ real keys     │        │ (separate        │    │
│  └───────────────┘        │  container)      │    │
│                           └──────────────────┘    │
│                                    │              │
│                                    ▼              │
│                           ┌──────────────────┐    │
│                           │  Upstream API    │    │
│                           │  (OpenAI, etc.)  │    │
│                           └──────────────────┘    │
└────────────────────────────────────────────────────┘

Host filesystem:
  ./secrets/master_key  (read-only mount)
  ./secrets/admin_token
```

### **Key Insight**

**Agent container physically cannot access the keyring-proxy database or master key.**

Even with Docker access on the host, the agent:
1. Cannot read keyring-proxy's memory
2. Cannot access its database file (in different volume)
3. Must go through HTTP API with proxy token
4. Proxy validates token, injects real API key upstream

---

## 🏗️ **BotMaker Components**

### **1. Keyring-Proxy Container**

**Port 9100:** Admin API (add/remove keys, manage bots)  
**Port 9101:** Data API (bots make requests here)

**Database:** `/data/proxy.db` (in `proxy-data` volume)

```sql
CREATE TABLE provider_keys (
    id TEXT PRIMARY KEY,
    vendor TEXT NOT NULL,
    secret_encrypted BLOB NOT NULL,  -- AES-256-GCM
    label TEXT,
    tag TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,  -- SHA256 of proxy token
    tags TEXT,  -- JSON array for key routing
    created_at INTEGER NOT NULL
);
```

**Master Key:** Read from `/secrets/master_key` (host-mounted, read-only)

**Encryption:** AES-256-GCM (IV + AuthTag + Ciphertext)

### **2. Bot Container**

**Config:**
```json
{
  "ai": {
    "provider": "openai-proxy",
    "baseURL": "http://keyring-proxy:9101/v1/openai",
    "apiKey": "bot_a1b2c3d4e5f6..."  // Proxy token, not real key
  }
}
```

**Network access:** Can only reach keyring-proxy, not internet directly

### **3. Request Flow**

```bash
# Bot makes request
POST http://keyring-proxy:9101/v1/openai/chat/completions
Authorization: Bearer bot_a1b2c3d4e5f6...

# Proxy receives request
1. Extracts bot token from Authorization header
2. SHA256(token) → lookup in bots table
3. If valid bot, select real API key for vendor
4. Decrypt API key using master key
5. Forward request to upstream with REAL key
6. Return response to bot

# Bot never sees real API key
```

---

## 🔒 **Security Properties**

### **What Agent Can Do**

✅ Make HTTP requests to keyring-proxy  
✅ Use its assigned proxy token  
✅ Access only the vendors it's configured for  

### **What Agent CANNOT Do**

❌ Read keyring-proxy database (different volume)  
❌ Access master key file (different container)  
❌ Decrypt secrets (no master key)  
❌ Read other bots' proxy tokens  
❌ Bypass proxy to access upstream directly (network isolation)  

### **Even with Docker Root Access**

Agent can:
- Read host files via `docker run -v /:/host`
- BUT keyring-proxy DB is in a **Docker volume**, not host filesystem
- Volumes are in `/var/lib/docker/volumes/` with random hashes
- Agent would need to:
  1. Find correct volume hash
  2. Read DB file
  3. Steal master key from `/secrets/master_key`
  4. Decrypt keys
  
**But:** This requires intentional malicious code, not accidental leak

---

## 🤔 **How This Applies to Our Secret Manager**

### **Option 1: Full BotMaker Pattern** (Maximum Security)

```
┌──────────────────────────────────────────────────┐
│  Agent (OpenClaw)                                │
│  - Requests secret via HTTP                      │
│  - Gets: proxy token for secret                  │
│  - Uses token to access upstream                 │
└───────────────┬──────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────┐
│  Secret-Proxy (separate container)              │
│  - Stores encrypted secrets                     │
│  - Has master key                                │
│  - Validates proxy tokens                       │
│  - Injects real secrets on behalf of agent      │
└───────────────┬──────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────┐
│  Telegram Bot                                    │
│  - Sends approval request                       │
│  - You approve/deny                              │
└──────────────────────────────────────────────────┘
```

**Agent gets:**
- Proxy token: `proxy_tok_abc123`
- Endpoint: `http://secret-proxy:9101/api/openai`

**Agent uses:**
```bash
curl -H "Authorization: Bearer proxy_tok_abc123" \
  http://secret-proxy:9101/api/openai/chat/completions
```

**Proxy does:**
1. Validates `proxy_tok_abc123`
2. Checks if approved + not expired
3. Injects real `OPENAI_API_KEY`
4. Forwards to OpenAI
5. Returns response

**Agent never sees real API key**

### **Option 2: Simplified Pattern** (Good Enough)

```
┌──────────────────────────────────────────────────┐
│  Agent (OpenClaw)                                │
│  - Requests secret                               │
│  - Waits for approval                            │
│  - Gets time-limited secret value                │
└───────────────┬──────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────┐
│  Secret Manager (separate container)            │
│  - Stores encrypted secrets (Docker volume)     │
│  - Has master key                                │
│  - Requires Telegram approval                   │
│  - Returns plaintext secret if approved         │
└───────────────┬──────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────┐
│  Telegram Bot                                    │
│  - Sends approval request                       │
│  - You approve/deny                              │
└──────────────────────────────────────────────────┘
```

**Difference from original plan:**
- ✅ Runs in separate container
- ✅ Database in Docker volume (not host filesystem)
- ✅ Master key in separate mount
- ✅ Agent cannot read DB directly

**Still vulnerable to:**
- ⚠️ Agent can request secrets and self-approve (if it has HTTP access)
- ⚠️ Agent sees plaintext secret (for 5 minutes)

**But prevents:**
- ✅ Accidental leaks (secrets in logs)
- ✅ Prompt injection stealing all secrets
- ✅ Agent reading DB without approval

---

## 📋 **Recommendations**

### **For API Keys (OpenAI, Anthropic, etc.):**

Use **BotMaker's proxy pattern**:

1. Secret manager stores encrypted keys
2. Agent gets proxy token
3. All API requests go through proxy
4. Proxy injects real key
5. Agent never sees real key

**Benefits:**
- Agent literally cannot leak API key
- Audit trail shows all requests
- Can revoke proxy token anytime
- Rate limiting per bot

### **For Generic Secrets (passwords, crypto keys):**

Use **simplified pattern with Telegram approval**:

1. Secrets in separate container + volume
2. Agent requests via HTTP
3. You approve via Telegram
4. Secret returned (expires in 5min)
5. Plaintext secret in agent's memory briefly

**Benefits:**
- Works for any secret type
- Simpler to build
- Still prevents DB access
- Human approval required

---

## 🚀 **Implementation Plan (Revised)**

### **Phase 1: Secret Manager Container** (BotMaker-style)

```yaml
# docker-compose.yml
services:
  secret-manager:
    build: ./secret-manager
    container_name: secret-manager
    environment:
      - PORT=3737
      - DB_PATH=/data/secrets.db
      - MASTER_KEY_FILE=/secrets/master_key
      - TELEGRAM_BOT_TOKEN_FILE=/secrets/telegram_token
      - TELEGRAM_CHAT_ID_FILE=/secrets/telegram_chat_id
    volumes:
      - secret-data:/data
      - ./secrets:/secrets:ro
    networks:
      - agent-network
    restart: unless-stopped

  openclaw-agent:
    # Your existing OpenClaw container
    environment:
      - SECRET_MANAGER_URL=http://secret-manager:3737
    networks:
      - agent-network
    # NO access to secret-data volume
    # NO master key access

networks:
  agent-network:

volumes:
  secret-data:  # Only secret-manager can access
```

### **Phase 2: Two API Modes**

**Mode A: Proxy (for API keys)**
```typescript
// Agent requests
POST /proxy/openai
{
  "secret_name": "OPENAI_API_KEY",
  "reason": "Chat completion",
  "upstream_url": "https://api.openai.com/v1/chat/completions",
  "request_body": {...}
}

// Returns: response from OpenAI
// Agent never sees API key
```

**Mode B: Direct (for generic secrets)**
```typescript
// Agent requests
POST /request
{
  "secret_name": "DATABASE_PASSWORD",
  "reason": "Connect to database"
}

// Returns: request_id

// Poll status, wait for Telegram approval

// Get secret
GET /secret/:request_id
// Returns: plaintext secret (if approved)
```

---

## ✅ **Security Comparison**

| Attack Vector | Original Plan | Separate Container | BotMaker Proxy |
|--------------|---------------|-------------------|----------------|
| Agent reads DB file | ❌ Possible | ✅ Prevented | ✅ Prevented |
| Agent steals master key | ❌ Possible | ⚠️ Requires effort | ✅ Never exposed |
| Prompt injection leaks key | ❌ High risk | ⚠️ Time-limited | ✅ Never in memory |
| Agent self-approves | ❌ Possible | ⚠️ Possible | ✅ No approval needed |
| Accidental logs | ❌ High risk | ⚠️ 5min window | ✅ Never logged |

---

## 🎯 **Final Recommendation**

**Build:** BotMaker-style proxy for API keys + Telegram approval for other secrets

**Why:**
1. Maximum security for API keys (agent never sees them)
2. Flexibility for generic secrets (passwords, tokens)
3. Telegram approval as safety net
4. Docker isolation prevents DB access
5. Works with your existing Docker setup

**Next step:** Implement Phase 1, test with real Telegram approval, then add proxy mode.
