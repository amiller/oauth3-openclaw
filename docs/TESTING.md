# Testing Strategy - Telegram Secret Manager

## Testing Philosophy

**Goal:** Fast feedback loop with confidence at each layer

**Approach:**
1. **Unit tests** - Pure logic, no I/O
2. **Integration tests** - Components together (mock Telegram)
3. **Live tests** - Real Telegram bot with human interaction
4. **End-to-end** - Full agent workflow

---

## Test Pyramid

```
        /\
       /  \  E2E (Agent → Telegram → Human)
      /    \
     /──────\  Integration (Mock Telegram API)
    /        \
   /──────────\  Unit (Crypto, Storage, Logic)
  /____________\
```

---

## Phase 1: Unit Tests (Fast, Automated)

**What:** Individual functions with no dependencies

**Tools:** Vitest

**Tests:**

```typescript
// crypto.test.ts
describe('Encryption', () => {
  it('should encrypt and decrypt correctly', () => {
    const plaintext = 'sk-proj-abc123';
    const passphrase = 'test-passphrase';
    const encrypted = encrypt(plaintext, passphrase);
    const decrypted = decrypt(encrypted, passphrase);
    expect(decrypted).toBe(plaintext);
  });

  it('should fail with wrong passphrase', () => {
    const encrypted = encrypt('secret', 'pass1');
    expect(() => decrypt(encrypted, 'pass2')).toThrow();
  });
});

// storage.test.ts
describe('Storage', () => {
  it('should store and retrieve secret', () => {
    const storage = new SecretStorage(':memory:');
    storage.addSecret('TEST_KEY', 'value123', 'Test key');
    const secret = storage.getSecret('TEST_KEY');
    expect(secret).toBeDefined();
  });

  it('should create approval request', () => {
    const storage = new SecretStorage(':memory:');
    const request = storage.createRequest('API_KEY', 'test reason');
    expect(request.status).toBe('PENDING');
  });
});
```

**Run:**
```bash
npm test
```

**Expected:** <1 second, all green

---

## Phase 2: Integration Tests (Mock Telegram)

**What:** Full workflow without real Telegram API

**Tools:** Vitest + Mock Telegram responses

**Mock Strategy:**

```typescript
// Mock Telegram API
class MockTelegramBot {
  sentMessages: any[] = [];
  
  async sendMessage(chatId: string, text: string, options: any) {
    const messageId = this.sentMessages.length + 1;
    this.sentMessages.push({ chatId, text, options, messageId });
    return { message_id: messageId };
  }

  // Simulate user clicking button
  async simulateCallback(callbackData: string) {
    return this.handleCallback({ data: callbackData });
  }
}
```

**Integration Test:**

```typescript
describe('Approval Workflow', () => {
  let service: SecretManagerService;
  let mockBot: MockTelegramBot;

  beforeEach(() => {
    mockBot = new MockTelegramBot();
    service = new SecretManagerService({ bot: mockBot });
  });

  it('should complete full approval flow', async () => {
    // Agent requests secret
    const request = await service.requestSecret('OPENAI_API_KEY', 'test task');
    
    // Verify Telegram message sent
    expect(mockBot.sentMessages).toHaveLength(1);
    expect(mockBot.sentMessages[0].text).toContain('OPENAI_API_KEY');

    // Simulate approval
    await mockBot.simulateCallback(`approve:${request.request_id}`);

    // Check status
    const status = await service.getStatus(request.request_id);
    expect(status.status).toBe('APPROVED');

    // Retrieve secret
    const secret = await service.getSecret(request.request_id);
    expect(secret.secret_value).toBe('sk-...');
  });

  it('should handle denial', async () => {
    const request = await service.requestSecret('API_KEY', 'test');
    await mockBot.simulateCallback(`deny:${request.request_id}`);
    
    const status = await service.getStatus(request.request_id);
    expect(status.status).toBe('DENIED');
    
    await expect(service.getSecret(request.request_id)).rejects.toThrow();
  });

  it('should expire after timeout', async () => {
    const request = await service.requestSecret('API_KEY', 'test', { duration_minutes: 0.01 }); // 600ms
    await sleep(700);
    
    const status = await service.getStatus(request.request_id);
    expect(status.status).toBe('EXPIRED');
  });
});
```

**Run:**
```bash
npm test -- integration
```

**Expected:** <3 seconds, all workflows validated

---

## Phase 3: Live Telegram Testing

**What:** Real Telegram bot, real human approval

**Test Script:** `scripts/test-telegram-live.sh`

```bash
#!/bin/bash
# Live Telegram Integration Test

echo "🧪 Testing Telegram Secret Manager"
echo ""

# 1. Start service
echo "1️⃣ Starting service..."
npm start &
SERVICE_PID=$!
sleep 2

# 2. Request secret
echo "2️⃣ Requesting secret OPENAI_API_KEY..."
REQUEST_ID=$(curl -s -X POST http://localhost:3737/request \
  -H "Content-Type: application/json" \
  -d '{"secret_name":"OPENAI_API_KEY","reason":"Live test"}' \
  | jq -r '.request_id')

echo "Request ID: $REQUEST_ID"
echo ""

# 3. Human step
echo "3️⃣ CHECK YOUR TELEGRAM NOW!"
echo "   You should see an approval request."
echo "   Click either [Approve] or [Deny]"
echo ""
read -p "Press ENTER after you've responded in Telegram..."

# 4. Check status
echo "4️⃣ Checking status..."
STATUS=$(curl -s http://localhost:3737/status/$REQUEST_ID | jq -r '.status')
echo "Status: $STATUS"
echo ""

# 5. Try to retrieve (if approved)
if [ "$STATUS" == "APPROVED" ]; then
  echo "5️⃣ Retrieving secret..."
  SECRET=$(curl -s http://localhost:3737/secret/$REQUEST_ID | jq -r '.secret_value')
  echo "Secret: ${SECRET:0:10}... (truncated)"
  echo "✅ SUCCESS - Full workflow complete!"
else
  echo "5️⃣ Request was denied or expired"
  echo "⚠️  Test incomplete (expected approval)"
fi

# Cleanup
kill $SERVICE_PID
```

**Manual Checklist:**

- [ ] Service starts without errors
- [ ] Telegram message appears within 2 seconds
- [ ] Message format is clear and readable
- [ ] Approve button works
- [ ] Deny button works
- [ ] Approval notification appears
- [ ] Secret retrieval works
- [ ] Expiration works (wait 5+ minutes, try again)

**Run:**
```bash
./scripts/test-telegram-live.sh
```

**Expected:** ~30 seconds (including human response time)

---

## Phase 4: End-to-End with Agent

**What:** OpenClaw agent uses the secret manager

**Test Script:** `scripts/test-agent-integration.sh`

```bash
#!/bin/bash
# Agent Integration Test

echo "🤖 Testing Agent Integration"

# 1. Start secret manager
npm start &
SERVICE_PID=$!
sleep 2

# 2. Run agent task that needs OPENAI_API_KEY
echo "Starting agent task..."
echo "Agent will request OPENAI_API_KEY to complete a task"

# Trigger agent via OpenClaw
# (This would be done via actual agent code)
openclaw run "Use the secret manager to get OPENAI_API_KEY and make a test API call to OpenAI"

# 3. Verify in logs
echo ""
echo "Check audit log:"
curl -s http://localhost:3737/audit | jq '.[] | select(.secret_name=="OPENAI_API_KEY")'

kill $SERVICE_PID
```

**Agent Code Example:**

```javascript
// In agent code
async function getOpenAIKey() {
  // Request secret
  const response = await fetch('http://localhost:3737/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret_name: 'OPENAI_API_KEY',
      reason: 'Make API call to OpenAI for user task'
    })
  });
  
  const { request_id } = await response.json();
  
  // Poll for approval (max 2 minutes)
  for (let i = 0; i < 24; i++) {
    await sleep(5000); // 5 seconds
    
    const status = await fetch(`http://localhost:3737/status/${request_id}`);
    const { status: state } = await status.json();
    
    if (state === 'APPROVED') {
      // Get the secret
      const secret = await fetch(`http://localhost:3737/secret/${request_id}`);
      const { secret_value } = await secret.json();
      return secret_value;
    }
    
    if (state === 'DENIED') {
      throw new Error('Secret request denied by user');
    }
  }
  
  throw new Error('Secret request timed out');
}
```

---

## Continuous Testing

**Pre-commit Hook:**

```bash
#!/bin/bash
# .git/hooks/pre-commit

npm test
if [ $? -ne 0 ]; then
  echo "❌ Tests failed - commit aborted"
  exit 1
fi

echo "✅ Tests passed"
```

**CI (if needed later):**

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '20'
      - run: npm install
      - run: npm test
```

---

## Debugging Tools

**Test Helpers:**

```typescript
// tests/helpers.ts

// Dump full database state
export function dumpDB(storage: SecretStorage) {
  console.log('=== Secrets ===');
  console.log(storage.listSecrets());
  console.log('=== Requests ===');
  console.log(storage.listRequests());
  console.log('=== Audit Log ===');
  console.log(storage.getAuditLog());
}

// Create test secret
export function createTestSecret(storage: SecretStorage) {
  return storage.addSecret(
    'TEST_KEY',
    'test_value_' + Date.now(),
    'Test key for integration tests'
  );
}

// Wait for condition
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000
) {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) {
    await sleep(100);
  }
  if (!condition()) {
    throw new Error('Condition not met within timeout');
  }
}
```

**Logging:**

```typescript
// Add timestamps to all logs
const log = {
  info: (msg: string, data?: any) => 
    console.log(`[${new Date().toISOString()}] INFO: ${msg}`, data || ''),
  error: (msg: string, error?: any) =>
    console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, error || ''),
  debug: (msg: string, data?: any) =>
    process.env.DEBUG && console.log(`[${new Date().toISOString()}] DEBUG: ${msg}`, data || '')
};
```

---

## Performance Benchmarks

**Target Latencies:**

| Operation | Target | Acceptable |
|-----------|--------|------------|
| Request secret | <100ms | <500ms |
| Send Telegram message | <2s | <5s |
| Approve/deny callback | <200ms | <1s |
| Get secret (after approval) | <50ms | <200ms |

**Benchmark Script:**

```bash
#!/bin/bash
# scripts/benchmark.sh

echo "Running performance benchmarks..."

# 100 sequential requests
time for i in {1..100}; do
  curl -s -X POST http://localhost:3737/request \
    -H "Content-Type: application/json" \
    -d '{"secret_name":"BENCH_KEY","reason":"benchmark"}' > /dev/null
done

# Check average time
```

---

## Test Coverage Goals

- **Unit tests:** >90% coverage
- **Integration tests:** All critical paths
- **Live tests:** Manual checklist 100% pass
- **E2E:** At least 1 full agent workflow

---

## Quick Reference

```bash
# Run all tests
npm test

# Run specific test file
npm test storage.test.ts

# Run with coverage
npm test -- --coverage

# Run integration tests only
npm test -- integration

# Live test (requires human)
./scripts/test-telegram-live.sh

# Full E2E with agent
./scripts/test-agent-integration.sh

# Benchmark
./scripts/benchmark.sh
```

---

## Success Metrics

✅ All unit tests pass (<1s)  
✅ All integration tests pass (<3s)  
✅ Live Telegram test completes successfully  
✅ Agent can retrieve and use secrets  
✅ Performance targets met  
✅ No secrets logged in plaintext  
✅ Audit trail captures all actions
