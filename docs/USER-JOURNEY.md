# OAuth3-OpenClaw User Journey

## Current Flow (MVP)

1. Agent needs API key
2. Execution request sent to proxy
3. User receives Telegram message:
   ```
   🔐 Execution Request
   
   Skill: send-openai-request
   Secrets: OPENAI_API_KEY
   
   📄 View Code on GitHub
   https://gist.github.com/user/abc123
   ```
4. User clicks link → sees raw TypeScript code
5. **Problem:** Most users can't audit code themselves
6. User approves based on trust/intuition
7. Code executes

## Improved Flow - "Discuss with Claude"

### On the Gist Page

Add a prominent link/button on the Gist:

```
🤖 Not sure if this is safe?
Discuss this code with Claude →
```

**Link format:**
```
https://claude.ai/new?q=Review%20this%20code%20for%20security%20issues%3A%0A%0A{GIST_RAW_URL}
```

Or even better, use Claude Projects with a security reviewer preset:
```
https://claude.ai/chat?project=security-review&context={GIST_URL}
```

**What users can ask Claude:**
- "What does this code do in simple terms?"
- "Are there any security concerns?"
- "Could this steal my API key?"
- "Does this only do what the description says?"

**Benefits:**
- ✅ Non-technical users can verify code
- ✅ AI-assisted security review
- ✅ Educational (users learn what the code does)
- ✅ No barrier - just click a link

**Implementation:**
- Add to Gist description/README
- Or: Browser extension that adds button to any Gist page
- Or: Skill template includes this link in comments

## Verified Scripts Program

### Concept: Trust the Script, Approve the Use

**Problem:** Users shouldn't need to review code every time.

**Solution:** Maintain a curated repository of verified scripts.

### Repository: `oauth3-verified-skills`

**Structure:**
```
oauth3-verified-skills/
├── skills/
│   ├── openai-chat/
│   │   ├── skill.ts
│   │   ├── metadata.json
│   │   ├── REVIEW.md
│   │   └── README.md
│   ├── send-email/
│   │   ├── skill.ts
│   │   ├── metadata.json
│   │   ├── REVIEW.md
│   │   └── README.md
├── VERIFICATION.md
└── TRUST-MODEL.md
```

**metadata.json:**
```json
{
  "skill_id": "openai-chat",
  "version": "1.0.0",
  "hash": "a3f5...",
  "description": "Send a chat completion request to OpenAI",
  "secrets": ["OPENAI_API_KEY"],
  "network": ["api.openai.com"],
  "verified_by": "oauth3-team",
  "verified_at": "2026-02-09",
  "trust_level": "verified"
}
```

**REVIEW.md:**
```markdown
# Security Review: openai-chat

**Reviewer:** @security-team
**Date:** 2026-02-09

## What it does
- Sends HTTP POST to api.openai.com/v1/chat/completions
- Includes OPENAI_API_KEY in Authorization header
- Returns response JSON

## Security analysis
✅ Only contacts api.openai.com
✅ Does not exfiltrate key elsewhere
✅ Does not write to disk
✅ Read-only operations

## Approved for
- Sending chat completion requests
- No file system access
- No other network calls
```

### Approval Flow with Verified Scripts

**When using a verified script:**

```
✅ Verified Script

Skill: openai-chat (v1.0.0)
Description: Send a chat completion request to OpenAI
Verified by: OAuth3 Team

This script has been security reviewed and does exactly what the 
description says. You still need to approve THIS USE:

Sending to: api.openai.com
With secret: OPENAI_API_KEY
Request: "Summarize this text..."

[View Code] [View Review] [Approve Once] [Always Trust]
```

**Benefits:**
- ✅ Trust the script (one-time review by experts)
- ✅ Approve the use (what it's being used for)
- ✅ Separation of concerns
- ✅ Community-maintained trust

### Trust Levels

**1. Verified (✅)**
- Reviewed by OAuth3 security team
- Committed to official repo
- Hash tracked
- Regular re-reviews

**2. Community Verified (🌟)**
- Multiple independent reviews
- GitHub Actions attestation
- Sigstore signatures
- Transparency log

**3. Self-Published (📝)**
- Anyone can publish
- Show warning
- Require manual review each time

**4. Unknown/Modified (⚠️)**
- Hash doesn't match
- Strong warning
- Recommend using verified version

### Implementation

**Bot detection:**
```typescript
const skillHash = hashCode(code);
const verified = await fetchVerifiedSkill(skillHash);

if (verified) {
  message = `✅ Verified Script: ${verified.skill_id}
  
Description: ${verified.description}
Verified by: ${verified.verified_by}

[View Code] [View Review]

Do you approve THIS USE?
Secrets: ${secrets.join(', ')}
Network: ${network.join(', ')}`;
} else {
  message = `⚠️ Unverified Script
  
This code has not been reviewed. 
Please inspect carefully or discuss with Claude:

🤖 Discuss with Claude →
${claudeReviewUrl}

[View Code] [Approve] [Deny]`;
}
```

**Verified skills registry API:**
```
GET https://oauth3.verified.sh/api/v1/skills/{hash}
→ Returns metadata + review if verified
→ 404 if unknown
```

**Publishing process:**
1. Submit PR to oauth3-verified-skills repo
2. Security team reviews
3. Automated tests run
4. If approved, merged + hash published
5. Bot fetches registry on startup

### User Journey Comparison

**Before (current):**
```
Execution request
→ View Gist
→ Stare at TypeScript (can't understand)
→ Approve based on gut feeling
→ Hope for the best
```

**After (with Claude link):**
```
Execution request
→ View Gist
→ Click "Discuss with Claude"
→ Ask: "Is this safe?"
→ Claude explains in plain English
→ Informed decision
```

**After (with verified scripts):**
```
Execution request
→ See "✅ Verified: openai-chat"
→ Read simple description
→ Approve the USE (not the code)
→ Confident it's safe
```

### Governance

**Who can verify scripts?**
- OAuth3 core team (initial set)
- Community reviewers (with reputation system)
- Security auditors (paid reviews)

**What gets verified?**
- Common patterns (API calls, data transforms)
- Frequently requested skills
- High-impact operations (payment, email, posting)

**Re-verification:**
- Annual security review
- When dependencies update
- If vulnerabilities discovered

**Removal:**
- Security issue discovered → immediate removal
- Notice sent to all users who trusted it
- Recommend switching to new version

## Next Steps

1. **Phase 1:** Add "Discuss with Claude" links to skill template
2. **Phase 2:** Create oauth3-verified-skills repository
3. **Phase 3:** Implement bot hash verification
4. **Phase 4:** Build community review system

**Priority:** Start with verified scripts repo - biggest trust improvement.
