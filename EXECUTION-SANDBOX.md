# Execution Sandbox Implementation Plan

**Goal:** General execution sandbox with Telegram approval

**Updated:** 2026-02-09 15:15 EST

---

## Architecture

```
Agent → Proxy (host) → Telegram → You review GitHub → Approve → Deno sandbox executes
```

---

## Phase 1: Basic Execution (2 hours)

### Components

**1. Proxy Service (on host)**
- HTTP API for execution requests
- Telegram bot integration
- Deno sandbox executor
- Approval state management

**2. Skill Repository (GitHub)**
- https://github.com/clawTEEdah/skills/
- TypeScript skills
- Self-documented
- Versioned via git

**3. Deno Sandbox**
- Docker-based isolation
- Network restrictions
- Secrets via env vars
- Timeout enforcement

---

## API Design

### POST /execute

```typescript
{
  "skill_id": "check-balance",
  "skill_url": "https://github.com/clawTEEdah/skills/blob/main/openai/check-balance.ts",
  "secrets": ["OPENAI_API_KEY"],
  "args": {}  // Optional arguments to skill
}
```

**Response (immediate):**
```typescript
{
  "request_id": "exec_abc123",
  "status": "pending_approval",
  "approval_url": "https://t.me/..."
}
```

**Poll for result:**
```
GET /execute/exec_abc123/status
```

**Response (after approval):**
```typescript
{
  "request_id": "exec_abc123",
  "status": "approved|denied|executed|failed",
  "result": { /* execution output */ },
  "executed_at": 1234567890,
  "duration_ms": 1234
}
```

---

## Telegram Message Format

```
🔐 Execution Request

Skill: check-balance
Secrets: OPENAI_API_KEY
Network: api.openai.com

📄 View Code on GitHub
https://github.com/clawTEEdah/skills/blob/main/openai/check-balance.ts

[✅ Run Once]
[✅ Trust 24h]
[✅ Always Trust]
[❌ Deny]
```

**Callback data:**
```
approve_once:exec_abc123
approve_24h:exec_abc123:sha256_hash
approve_forever:exec_abc123:sha256_hash
deny:exec_abc123
```

---

## Deno Execution

### Security Sandbox

```bash
# Fetch skill from GitHub
curl -L https://raw.githubusercontent.com/clawTEEdah/skills/main/openai/check-balance.ts > /tmp/skill.ts

# Calculate hash
HASH=$(sha256sum /tmp/skill.ts | cut -d' ' -f1)

# Verify hash matches approval
if [ "$HASH" != "$APPROVED_HASH" ]; then
  echo "Code changed! Requires re-approval"
  exit 1
fi

# Execute in sandbox
docker run --rm \
  --network=restricted \
  --memory=256m \
  --cpus=0.5 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=10m \
  --env OPENAI_API_KEY="$SECRET_VALUE" \
  denoland/deno:latest \
  run \
    --allow-net=api.openai.com \
    --allow-env=OPENAI_API_KEY \
    --no-prompt \
  /tmp/skill.ts
```

**Deno permissions:**
- `--allow-net=<domain>` - Whitelist network access
- `--allow-env=<var>` - Whitelist env vars
- `--no-prompt` - No interactive prompts
- Filesystem is read-only (except /tmp)

---

## Database Schema

```sql
CREATE TABLE execution_requests (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    skill_url TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    secrets TEXT NOT NULL,  -- JSON array
    status TEXT NOT NULL,   -- pending|approved|denied|executed|failed
    requested_at INTEGER NOT NULL,
    approved_at INTEGER,
    executed_at INTEGER,
    result TEXT,  -- JSON result
    telegram_message_id INTEGER
);

CREATE TABLE skill_approvals (
    skill_url TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    approval_level TEXT NOT NULL,  -- once|24h|forever
    approved_at INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (skill_url, code_hash)
);
```

---

## Skill Format

### Standard Header

```typescript
/**
 * @skill check-balance
 * @description Check OpenAI API credits
 * @secrets OPENAI_API_KEY
 * @network api.openai.com
 * @timeout 30
 */
```

### Execution

```typescript
// Secrets available as env vars
const API_KEY = Deno.env.get('OPENAI_API_KEY');

// Return data via console.log (JSON)
const result = await fetch(...);
console.log(JSON.stringify(await result.json()));
```

### Error Handling

```typescript
// Throw errors with clear messages
if (!API_KEY) {
  throw new Error('Missing OPENAI_API_KEY');
}

// Proxy captures stderr for debugging
console.error('Debug info...');
```

---

## Execution Flow

```
1. Agent requests execution
   POST /execute { skill_id, skill_url, secrets }

2. Proxy checks approvals
   IF hash approved forever → execute immediately
   ELIF hash approved 24h + not expired → execute
   ELSE → send Telegram approval request

3. User reviews on GitHub
   Click link → see full code
   Approve or deny

4. Proxy receives callback
   Update DB, fetch skill from GitHub

5. Proxy executes in Deno sandbox
   - Inject secrets as env
   - Network restrictions
   - Capture stdout/stderr
   - Timeout after 30s

6. Proxy stores result
   Status → executed
   Result → captured output

7. Agent polls /execute/{id}/status
   Gets result
```

---

## Security Checklist

- [x] Secrets never in code (env vars only)
- [x] Code hash verified before execution
- [x] Network whitelist enforced
- [x] Memory/CPU limits
- [x] Timeout enforced
- [x] Read-only filesystem
- [x] Container destroyed after execution
- [x] Full audit trail
- [x] Human approval required (unless pre-approved)

---

## Example Skills

### check-balance.ts

```typescript
/**
 * @skill check-balance
 * @description Check OpenAI API credits
 * @secrets OPENAI_API_KEY
 * @network api.openai.com
 */

const response = await fetch(
  'https://api.openai.com/v1/dashboard/billing/credit_grants',
  { headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}` } }
);

console.log(JSON.stringify(await response.json()));
```

### create-issue.ts

```typescript
/**
 * @skill create-issue
 * @description Create GitHub issue
 * @secrets GITHUB_TOKEN
 * @network api.github.com
 */

interface Args {
  repo: string;
  title: string;
  body: string;
}

const args: Args = JSON.parse(Deno.env.get('SKILL_ARGS') || '{}');

const response = await fetch(
  `https://api.github.com/repos/${args.repo}/issues`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('GITHUB_TOKEN')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: args.title,
      body: args.body
    })
  }
);

console.log(JSON.stringify(await response.json()));
```

---

## Testing Plan

### Unit Tests

- Skill fetching from GitHub
- Hash calculation/verification
- Approval state management
- Deno execution

### Integration Tests

- Full approval workflow (mocked Telegram)
- Skill execution with secrets
- Timeout enforcement
- Network restrictions

### Live Tests

- Real Telegram bot
- Real GitHub repo
- Real Deno execution
- Actual API calls

---

## Files to Create

**Proxy (TypeScript):**
- `src/executor.ts` - Deno sandbox executor
- `src/skills.ts` - Skill fetching/hashing
- `src/approvals.ts` - Approval state management
- `src/telegram-executor.ts` - Telegram approval flow

**Skills (TypeScript):**
- `openai/check-balance.ts`
- `openai/list-models.ts`
- `github/create-issue.ts`

**Deployment:**
- `docker-compose.yml` - Proxy + Deno runtime
- `Dockerfile` - Proxy image
- `README.md` - Setup guide

---

## Next Steps

1. Create GitHub repo: `clawTEEdah/skills`
2. Write 2-3 example skills
3. Build proxy executor
4. Test with mock Telegram
5. Deploy on host
6. Live test with real Telegram + GitHub

---

## Open Questions

- [ ] Skill arguments format? (env var? stdin? args?)
- [ ] Skill versioning? (git tags? branches?)
- [ ] Rate limiting? (max 10 executions/hour?)
- [ ] Cost tracking? (execution time billing?)
