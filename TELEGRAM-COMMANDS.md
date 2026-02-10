# Telegram Bot Commands

The OAuth3 proxy includes a Telegram bot for secret management and execution approvals.

## Adding Secrets (Recommended)

When an execution requires a secret that isn't stored, the bot will prompt you:

```
🔑 Missing Secret Required

Request: exec_abc123...
Secret: OPENAI_API_KEY

To add this secret, use:

/add_secret OPENAI_API_KEY your-secret-value-here

After adding the secret, the execution will automatically retry.
```

**The bot automatically deletes your `/add_secret` message** to keep secrets out of chat history.

### Proactive Secret Management

You can also add secrets before they're needed:

```
/add_secret ANTHROPIC_API_KEY sk-ant-...
/add_secret GITHUB_TOKEN ghp_...
```

**Security features:**
- Your message containing the secret is **immediately deleted**
- Secrets never appear in bot responses
- Only works from your configured chat ID

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
