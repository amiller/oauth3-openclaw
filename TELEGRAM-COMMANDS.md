# Telegram Bot Commands

The OAuth3 proxy includes a Telegram bot that supports both manual secret management and automatic prompting when secrets are needed.

## Automatic Secret Prompts (Recommended)

When an execution requires a secret that isn't stored, the bot will automatically prompt you:

```
🔑 Missing Secret Required

Request: exec_abc123...
Secret: OPENAI_API_KEY

Please reply to this message with the value for OPENAI_API_KEY.

Your message will be automatically deleted for security.
```

**To provide the secret:**
1. Tap "Reply" on the bot's message
2. Type or paste the secret value
3. Send

The bot will:
- Store the secret
- Delete your message for security
- Retry the execution automatically

This is the easiest way to add secrets - no need to remember command syntax!

## Manual Secret Management (Optional)

### `/add_secret SECRET_NAME secret_value`

Add a new secret to the proxy's in-memory store.

**Usage:**
```
/add_secret OPENAI_API_KEY sk-proj-abcd1234...
```

**Security:**
- Your message is **immediately deleted** after the secret is stored
- The bot never shows the secret value in its response
- Only works in private chat with the configured chat ID

**Example:**
```
/add_secret ANTHROPIC_API_KEY sk-ant-api03-xyz...
```

Bot response:
```
✅ Secret added: ANTHROPIC_API_KEY

⚠️ Note: Secrets are stored in memory and will be lost on restart.
For production, use encrypted persistent storage.
```

### `/list_secrets`

List all stored secret names (not values).

**Usage:**
```
/list_secrets
```

**Example response:**
```
📋 Stored secrets (2):

• OPENAI_API_KEY
• ANTHROPIC_API_KEY

⚠️ In-memory only (lost on restart)
```

## Bot Info

### `/start` or `/id`

Get your Telegram chat ID and confirm the bot is running.

**Usage:**
```
/start
```

**Response:**
```
Your chat ID: 703331076

Bot is ready to receive execution requests.
```

## Execution Approvals

When you receive an execution request, the bot sends a message with inline buttons:

- **✅ Run Once** - Approve this execution only
- **❌ Deny** - Reject the execution
- **✅ Trust 24h** - Auto-approve this code for 24 hours
- **✅ Always Trust** - Auto-approve this code forever (by hash)

After approval, the bot updates the message with execution results.

## Security Notes

1. **Chat ID restriction:** The bot only responds to messages from the configured `TELEGRAM_CHAT_ID`
2. **Message deletion:** `/add_secret` messages are deleted immediately after processing
3. **No secret exposure:** Secrets are never shown in bot responses
4. **In-memory storage:** Current implementation stores secrets in memory only (lost on restart)

## Future Enhancements

- Encrypted persistent storage for secrets
- `/remove_secret` command to delete secrets
- Multi-user support with role-based access
- Secret rotation reminders
- Audit log of secret access
