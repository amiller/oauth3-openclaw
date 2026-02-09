# Telegram Bot API Reference

**Source:** https://core.telegram.org/bots/api  
**Fetched:** 2026-02-09

## Key Methods for Our Use Case

### Sending Messages with Inline Keyboards

```bash
POST https://api.telegram.org/bot<TOKEN>/sendMessage
```

**Parameters:**
- `chat_id`: Integer or String (user ID or @username)
- `text`: String (message text, 1-4096 characters)
- `reply_markup`: InlineKeyboardMarkup (inline buttons)

### Inline Keyboard Structure

```json
{
  "inline_keyboard": [[
    {"text": "✅ Approve", "callback_data": "approve:request_id"},
    {"text": "❌ Deny", "callback_data": "deny:request_id"}
  ]]
}
```

### Handling Callback Queries

When user clicks button, bot receives:

```json
{
  "update_id": 123456,
  "callback_query": {
    "id": "query_id",
    "from": {...},
    "message": {...},
    "data": "approve:request_id"
  }
}
```

**Response required:**
```bash
POST /answerCallbackQuery
{
  "callback_query_id": "query_id",
  "text": "✅ Approved! Secret expires in 5 minutes.",
  "show_alert": false
}
```

### Getting Updates (Two methods)

**Long Polling (for development):**
```bash
GET /getUpdates?offset=<last_update_id+1>&timeout=30
```

**Webhook (for production):**
```bash
POST /setWebhook
{
  "url": "https://your-server.com/webhook",
  "secret_token": "your_secret"
}
```

## Bot Token

Format: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`

Create via [@BotFather](https://t.me/botfather):
1. Send `/newbot`
2. Choose name and username (must end in 'bot')
3. Receive token

## Important Notes

- All requests must use HTTPS (except local testing)
- Token must be kept secret
- Rate limits apply (avoid spam)
- Responses always contain `{"ok": true/false, "result": ...}`
