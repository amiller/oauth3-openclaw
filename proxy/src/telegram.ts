/**
 * Telegram Bot Integration
 */

import TelegramBot from 'node-telegram-bot-api';
import { ProxyDatabase, SessionPolicy } from './database.js';
import { appendFile } from 'fs/promises';

interface PendingApproval {
  requestId: string;
  level: 'once' | '24h' | 'forever' | 'trust_code';
  messageId: number;
  requiredSecrets: string[];
}

interface RequestMessage {
  messageId: number;
  baseText: string; // original message text (HTML)
}

export class TelegramApprovalBot {
  private bot: TelegramBot;
  private chatId: string;
  private db: ProxyDatabase;
  private onApproval: (requestId: string, level: 'once' | '24h' | 'forever' | 'trust_code') => void;
  private onDenial: (requestId: string) => void;
  private secretStore: Record<string, string>;
  private pendingApprovals: Map<string, PendingApproval>;
  private requestMetadata: Map<string, string[]>; // requestId -> required secrets
  private requestMessages: Map<string, RequestMessage>; // requestId -> original message info
  private publicUrl: string;

  constructor(
    token: string,
    chatId: string,
    db: ProxyDatabase,
    secretStore: Record<string, string>,
    onApproval: (requestId: string, level: 'once' | '24h' | 'forever' | 'trust_code') => void,
    onDenial: (requestId: string) => void,
    publicUrl: string = ''
  ) {
    this.bot = new TelegramBot(token, { polling: true });
    this.chatId = chatId;
    this.db = db;
    this.secretStore = secretStore;
    this.onApproval = onApproval;
    this.onDenial = onDenial;
    this.pendingApprovals = new Map();
    this.requestMetadata = new Map();
    this.requestMessages = new Map();
    this.publicUrl = publicUrl;

    this.setupHandlers();
  }

  private async notifyAgent(message: string): Promise<void> {
    try {
      // Write to file (backup)
      const timestamp = new Date().toISOString();
      const notif = `${timestamp} ${message}\n`;
      await appendFile('/tmp/oauth3-notifications.log', notif);
      
      // POST to agent notification endpoint
      const notifyUrl = process.env.AGENT_NOTIFY_URL || 'http://127.0.0.1:18790/notify';
      try {
        const response = await fetch(notifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
          signal: AbortSignal.timeout(2000) // 2 second timeout
        });
        if (response.ok) {
          console.log('✅ Agent notified immediately via HTTP');
        } else {
          console.warn(`⚠️ Notification endpoint returned ${response.status}`);
        }
      } catch (httpError: any) {
        console.warn(`⚠️ Notification endpoint unavailable:`, httpError.message);
        console.log('  Using file-based fallback (will be read on next heartbeat)');
      }
      
      console.log('✅ Agent notification logged:', message);
    } catch (error) {
      console.error('Failed to notify agent:', error);
    }
  }

  private setupHandlers(): void {
    // Handle callback queries (button clicks)
    this.bot.on('callback_query', async (query) => {
      try {
        if (query.message?.chat.id.toString() !== this.chatId) return;
        const data = query.data || '';
        const parts = data.split(':');
        const action = parts[0];

        if (action === 'add_secret') {
          const secretName = parts[1];
          const relatedRequestId = parts[2];
          await this.bot.answerCallbackQuery(query.id, {
            text: `Reply to this message with the value for ${secretName}`
          });
          await this.bot.sendMessage(
            query.message!.chat.id,
            `🔑 Add Secret: ${secretName}\n\nReply to this message with the secret value.\n\n⚠️ The message will be deleted immediately for security.`,
            { reply_markup: { force_reply: true, selective: true } }
          );
          return;
        }

        if (action === 'delete_secret') {
          const secretName = parts[1];
          if (!this.secretStore[secretName]) {
            await this.bot.answerCallbackQuery(query.id, { text: `Not found: ${secretName}` });
            return;
          }
          delete this.secretStore[secretName];
          this.db.deleteSecret(secretName);
          await this.bot.answerCallbackQuery(query.id, { text: `Deleted: ${secretName}` });
          console.log(`🗑 Secret deleted via menu: ${secretName}`);
          await this.refreshSecretsMenu(query.message!);
          return;
        }

        if (action === 'replace_secret') {
          const secretName = parts[1];
          await this.bot.answerCallbackQuery(query.id, {
            text: `Reply with the new value for ${secretName}`
          });
          await this.bot.sendMessage(
            query.message!.chat.id,
            `🔑 Add Secret: ${secretName}\n\nReply to this message with the secret value.\n\n⚠️ The message will be deleted immediately for security.`,
            { reply_markup: { force_reply: true, selective: true } }
          );
          return;
        }

        if (action === 'add_new_secret') {
          await this.bot.answerCallbackQuery(query.id);
          await this.bot.sendMessage(
            query.message!.chat.id,
            '➕ Add a new secret:\n\n/add_secret SECRET_NAME secret_value'
          );
          return;
        }

        const requestId = parts[1];
        const level = parts[2];

        if (action === 'approve') {
          console.log(`👆 [${new Date().toISOString()}] Approval button clicked for ${requestId}`);
          const approvalLevel = (level as 'once' | 'trust_code' | '24h' | 'forever') || 'once';

          if (approvalLevel === 'trust_code') {
            const request = this.db.getRequest(requestId);
            if (request) {
              this.db.addApproval(request.skill_url, request.code_hash, 'forever');
              console.log(`🔒 Code trusted: ${request.code_hash.substring(0, 16)}...`);
            }
          }

          const reqMsg = this.requestMessages.get(requestId);
          const msgId = query.message!.message_id;
          const chatId = query.message!.chat.id;

          // Check if any required secrets are missing
          const requiredSecrets = this.requestMetadata.get(requestId) || [];
          const missingSecrets = requiredSecrets.filter(name => !this.secretStore[name]);

          if (missingSecrets.length > 0) {
            const secretName = missingSecrets[0];
            // Edit original message to show approval + secret prompt
            await this.editRequestMessage(requestId, `\n\n✅ Approved (${approvalLevel})\n🔑 Need secret: ${secretName}`, {
              inline_keyboard: [[
                { text: `🔑 Add ${secretName}`, callback_data: `add_secret:${secretName}:${requestId}` }
              ]]
            });

            this.pendingApprovals.set(requestId, {
              requestId, level: approvalLevel, messageId: msgId, requiredSecrets: missingSecrets
            });

            await this.bot.answerCallbackQuery(query.id, { text: `Need secret: ${secretName}` });
            return;
          }

          // All secrets available - edit to show executing, then proceed
          await this.editRequestMessage(requestId, `\n\n✅ Approved (${approvalLevel}) — executing...`);
          this.onApproval(requestId, approvalLevel);
          await this.bot.answerCallbackQuery(query.id, { text: `Executing` });
          await this.notifyAgent(`Execution approved (${approvalLevel}): ${requestId}`);
        } else if (action === 'deny') {
          this.onDenial(requestId);
          
          await this.bot.editMessageText(
            `❌ Denied\n\nRequest: ${requestId}`,
            {
              chat_id: query.message!.chat.id,
              message_id: query.message!.message_id
            }
          );
          
          // Notify agent via cron wake
          await this.notifyAgent(`Execution denied: ${requestId}`);
        }

        await this.bot.answerCallbackQuery(query.id);
      } catch (error) {
        console.error('Callback error:', error);
      }
    });

    // Handle text messages
    this.bot.on('message', async (msg) => {
      console.log(`📨 Message from ${msg.from?.username || 'unknown'} (ID: ${msg.chat.id}): ${msg.text?.substring(0, 50)}...`);
      
      // Only respond to messages from the configured chat
      if (msg.chat.id.toString() !== this.chatId) {
        return;
      }
      
      // Check if this is a reply to a "Add Secret" prompt
      if (msg.reply_to_message && msg.reply_to_message.text?.startsWith('🔑 Add Secret:')) {
        const match = msg.reply_to_message.text.match(/🔑 Add Secret: (\w+)/);
        if (match && msg.text) {
          const secretName = match[1];
          const secretValue = msg.text;
          
          // Store the secret (memory + DB)
          this.secretStore[secretName] = secretValue;
          this.db.setSecret(secretName, secretValue);

          // Delete both messages immediately (security!)
          try {
            await this.bot.deleteMessage(msg.chat.id, msg.message_id);
            await this.bot.deleteMessage(msg.chat.id, msg.reply_to_message.message_id);
          } catch (deleteError) {
            console.warn('Could not delete messages:', deleteError);
          }

          console.log(`🔐 Secret added via reply: ${secretName} (length: ${secretValue.length})`);
          
          // Check if there are pending approvals waiting for this secret
          let executedAny = false;
          for (const [requestId, pending] of this.pendingApprovals.entries()) {
            if (!pending.requiredSecrets.includes(secretName)) continue;

            const stillMissing = pending.requiredSecrets.filter(name => !this.secretStore[name]);

            if (stillMissing.length === 0) {
              this.pendingApprovals.delete(requestId);
              await this.editRequestMessage(requestId, `\n\n✅ Approved (${pending.level}) — executing...`);
              this.onApproval(requestId, pending.level);
              await this.notifyAgent(`Execution approved (${pending.level}): ${requestId}`);
              executedAny = true;
            } else {
              const nextSecret = stillMissing[0];
              await this.editRequestMessage(requestId, `\n\n✅ Approved (${pending.level})\n🔑 Need secret: ${nextSecret}`, {
                inline_keyboard: [[
                  { text: `🔑 Add ${nextSecret}`, callback_data: `add_secret:${nextSecret}:${requestId}` }
                ]]
              });
            }
          }

          if (!executedAny && this.pendingApprovals.size === 0) {
            await this.bot.sendMessage(msg.chat.id, `✅ Secret added: ${secretName}`);
          }
        }
        return;
      }
      
      if (msg.text === '/start' || msg.text === '/id') {
        await this.bot.sendMessage(
          msg.chat.id,
          `Your chat ID: ${msg.chat.id}\n\nBot is ready to receive execution requests.`
        );
      } else if (msg.text?.startsWith('/add_secret ')) {
        await this.handleAddSecret(msg);
      } else if (msg.text === '/list_secrets' || msg.text === '/secrets') {
        await this.handleSecretsMenu(msg);
      } else if (msg.text?.startsWith('/delete_secret ')) {
        await this.handleDeleteSecret(msg);
      } else if (msg.text?.startsWith('/end_session')) {
        await this.handleEndSession(msg);
      }
    });
  }

  async sendApprovalRequest(
    requestId: string,
    skillId: string,
    skillUrl: string,
    metadata: {
      description: string;
      secrets: string[];
      network: string[];
      timeout: number;
    },
    codeHash: string,
    args?: Record<string, any>,
    analysis?: string
  ): Promise<number> {
    console.log(`📤 [${new Date().toISOString()}] Sending Telegram approval request for ${requestId}`);
    
    // Store required secrets for this request
    this.requestMetadata.set(requestId, metadata.secrets);
    
    // Check which secrets are missing
    const missingSecrets = metadata.secrets.filter(name => !this.secretStore[name]);
    const secretStatus = missingSecrets.length > 0 
      ? `⚠️ Missing: ${missingSecrets.join(', ')}\n(You'll be prompted to add after approval)`
      : `✅ Available`;
    
    // Check if code is already trusted
    const codeTrusted = this.db.getApproval(skillUrl, codeHash);
    const trustStatus = codeTrusted ? `✅ Trusted` : `🔍 New Code`;
    
    // Format invocation parameters
    let invocationDetails = '';
    if (args && Object.keys(args).length > 0) {
      const argsList = Object.entries(args).map(([k, v]) => `  ${k}: ${v}`).join('\n');
      invocationDetails = `\n\n🎯 This Invocation:\n${argsList}`;
    }
    
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // Prefer public /view/:id URL so Telegram users can actually see the code
    const viewUrl = this.publicUrl ? `${this.publicUrl}/view/${requestId}` : skillUrl;

    // Create Claude discussion link using the public view URL
    const claudePrompt = encodeURIComponent(`Review this OAuth3 execution request and help me decide if it's safe to approve:\n\nSkill: ${skillId}\nDescription: ${metadata.description}\nSecrets requested: ${metadata.secrets.join(', ')}\nNetwork access: ${metadata.network.join(', ')}\n\nCode: ${viewUrl}`);
    const claudeLink = `https://claude.ai/new?q=${claudePrompt}`;
    const codeLink = skillUrl.startsWith('data:')
      ? `📄 Code: <i>inline data URI</i>`
      : `📄 <a href="${escHtml(viewUrl)}">View Code</a>`;

    const message = `🔐 Execution Request

Skill: ${skillId}
Code: ${trustStatus}
Secrets: ${metadata.secrets.join(', ') || 'none'} ${secretStatus}
Network: ${metadata.network.join(', ') || 'none'}
Timeout: ${metadata.timeout}s${invocationDetails}

${codeLink}
💬 <a href="${escHtml(claudeLink)}">Discuss in Claude</a>

Description: ${metadata.description}
${analysis ? `\n🤖 <b>Haiku Analysis:</b>\n<pre>${escHtml(analysis)}</pre>` : ''}
Hash: ${codeHash.substring(0, 16)}...`;

    // Check if code is already trusted (for keyboard)
    const codeIsTrusted = this.db.getApproval(skillUrl, codeHash);
    
    const keyboard = codeIsTrusted ? {
      // Code is trusted - lightweight invocation approval
      inline_keyboard: [
        [
          { text: '✅ Run', callback_data: `approve:${requestId}:once` },
          { text: '❌ Skip', callback_data: `deny:${requestId}` }
        ]
      ]
    } : {
      // New code - full review needed
      inline_keyboard: [
        [
          { text: '✅ Run Once', callback_data: `approve:${requestId}:once` },
          { text: '❌ Deny', callback_data: `deny:${requestId}` }
        ],
        [
          { text: '🔒 Trust Code', callback_data: `approve:${requestId}:trust_code` }
        ]
      ]
    };

    const sent = await this.bot.sendMessage(this.chatId, message, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    this.requestMessages.set(requestId, { messageId: sent.message_id, baseText: message });
    console.log(`✅ [${new Date().toISOString()}] Telegram message sent (message_id: ${sent.message_id})`);
    return sent.message_id;
  }

  async updateExecution(messageId: number, requestId: string, result: any): Promise<void> {
    try {
      const status = result.success ? '✅ Success' : '❌ Failed';
      const duration = result.duration ? `${result.duration}ms` : 'N/A';

      let suffix = `\n\n${status} (${duration})`;
      if (result.success && result.stdout) {
        const output = result.stdout.substring(0, 300);
        suffix += `\n<pre>${this.esc(output)}${result.stdout.length > 300 ? '\n...' : ''}</pre>`;
      } else if (result.error) {
        const short = result.error.substring(0, 200);
        suffix += `\n<pre>${this.esc(short)}${result.error.length > 200 ? '...' : ''}</pre>`;
      }

      await this.editRequestMessage(requestId, suffix);

      const notif = result.success
        ? `Execution completed: ${requestId} (${duration})`
        : `Execution failed: ${requestId} - ${result.error || 'Unknown error'}`;
      await this.notifyAgent(notif);
    } catch (error) {
      console.error('Failed to update message:', error);
    }
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private async editRequestMessage(requestId: string, appendText: string, replyMarkup?: any): Promise<void> {
    const reqMsg = this.requestMessages.get(requestId);
    if (!reqMsg) return;

    reqMsg.baseText += appendText;
    try {
      await this.bot.editMessageText(reqMsg.baseText, {
        chat_id: this.chatId,
        message_id: reqMsg.messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup || { inline_keyboard: [] }
      });
    } catch (e) {
      console.error('Failed to edit message:', e);
    }
  }

  private async handleAddSecret(msg: TelegramBot.Message): Promise<void> {
    try {
      const text = msg.text || '';
      const parts = text.split(' ');
      
      if (parts.length < 3) {
        await this.bot.sendMessage(
          msg.chat.id,
          '❌ Usage: /add_secret SECRET_NAME secret_value\n\nExample:\n/add_secret OPENAI_API_KEY sk-...'
        );
        return;
      }
      
      const secretName = parts[1];
      const secretValue = parts.slice(2).join(' ');
      
      // Store the secret (memory + DB)
      this.secretStore[secretName] = secretValue;
      this.db.setSecret(secretName, secretValue);

      // Delete the user's message immediately (security!)
      try {
        await this.bot.deleteMessage(msg.chat.id, msg.message_id);
      } catch (deleteError) {
        console.warn('Could not delete message:', deleteError);
      }

      // Send confirmation (without showing the secret)
      await this.bot.sendMessage(
        msg.chat.id,
        `✅ Secret added: ${secretName}\n\nPersisted to database — survives restarts.`
      );
      
      console.log(`🔐 Secret added via Telegram: ${secretName} (length: ${secretValue.length})`);
    } catch (error) {
      console.error('Error adding secret:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ Failed to add secret');
    }
  }

  private secretsMenuKeyboard(): TelegramBot.InlineKeyboardMarkup {
    const secretNames = Object.keys(this.secretStore);
    const rows = secretNames.map(name => [
      { text: `🔄 ${name}`, callback_data: `replace_secret:${name}` },
      { text: `🗑`, callback_data: `delete_secret:${name}` }
    ]);
    rows.push([{ text: '➕ Add New', callback_data: 'add_new_secret:' }]);
    return { inline_keyboard: rows };
  }

  private async handleSecretsMenu(msg: TelegramBot.Message): Promise<void> {
    const secretNames = Object.keys(this.secretStore);
    if (secretNames.length === 0) {
      await this.bot.sendMessage(msg.chat.id, '📋 No secrets stored.\n\n/add_secret SECRET_NAME value');
      return;
    }
    await this.bot.sendMessage(msg.chat.id,
      `📋 Secrets (${secretNames.length}):`, {
      reply_markup: this.secretsMenuKeyboard()
    });
  }

  private async refreshSecretsMenu(msg: TelegramBot.Message): Promise<void> {
    const secretNames = Object.keys(this.secretStore);
    const text = secretNames.length === 0
      ? '📋 No secrets stored.'
      : `📋 Secrets (${secretNames.length}):`;
    try {
      await this.bot.editMessageText(text, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: secretNames.length > 0 ? this.secretsMenuKeyboard() : undefined
      });
    } catch (e) {
      console.error('Failed to refresh secrets menu:', e);
    }
  }

  private async handleDeleteSecret(msg: TelegramBot.Message): Promise<void> {
    const name = (msg.text || '').split(' ')[1];
    if (!name) {
      await this.bot.sendMessage(msg.chat.id, '❌ Usage: /delete_secret SECRET_NAME');
      return;
    }
    if (!this.secretStore[name]) {
      await this.bot.sendMessage(msg.chat.id, `❌ Secret not found: ${name}`);
      return;
    }
    delete this.secretStore[name];
    this.db.deleteSecret(name);
    await this.bot.sendMessage(msg.chat.id, `🗑 Deleted: ${name}`);
    console.log(`🗑 Secret deleted via Telegram: ${name}`);
  }

  async requestSecret(requestId: string, secretName: string, allMissing?: string[]): Promise<void> {
    const missing = allMissing || [secretName];
    // Edit original message inline + register pending so secret addition resumes execution
    await this.editRequestMessage(requestId, `\n\n🔑 Need secret: ${secretName}`, {
      inline_keyboard: [[
        { text: `🔑 Add ${secretName}`, callback_data: `add_secret:${secretName}:${requestId}` }
      ]]
    });

    // Register as pending so secret-add handler can resume execution
    const reqMsg = this.requestMessages.get(requestId);
    if (reqMsg) {
      this.pendingApprovals.set(requestId, {
        requestId, level: 'once', messageId: reqMsg.messageId, requiredSecrets: missing
      });
    }

    console.log(`📨 Requested secret ${secretName} for ${requestId}`);
  }

  async sendApprovalLink(
    requestId: string,
    skillId: string,
    metadata: { description: string; secrets: string[]; network: string[]; timeout: number },
    approvalUrl: string,
    analysis?: string
  ): Promise<number> {
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const message = `🔐 Approval needed

Skill: ${skillId}
Secrets: ${metadata.secrets.join(', ') || 'none'}
Network: ${metadata.network.join(', ') || 'none'}
${analysis ? `\n🤖 ${escHtml(analysis).substring(0, 200)}` : ''}

👉 <a href="${escHtml(approvalUrl)}">Review &amp; Approve</a>`;

    const sent = await this.bot.sendMessage(this.chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    this.requestMessages.set(requestId, { messageId: sent.message_id, baseText: message });
    this.requestMetadata.set(requestId, metadata.secrets);
    return sent.message_id;
  }

  async sendSessionStartNotification(sessionId: string, policy: SessionPolicy): Promise<void> {
    const msg = `📋 Session started: ${sessionId.substring(0, 16)}...

Auto-approving similar skills for 2h:
• Secrets: ${policy.allowedSecrets.join(', ') || 'none'}
• Network: ${policy.allowedNetworks.join(', ') || 'none'}
• Mutating: ${policy.allowMutating ? 'yes' : 'no'}
• Max risk: ${policy.maxRiskLevel}

/end_session ${sessionId} to stop`;

    await this.bot.sendMessage(this.chatId, msg, { disable_notification: true });
  }

  async sendSessionAutoApproveNotification(
    requestId: string, skillId: string, metadata: any, codeHash: string,
    sessionId: string, analysis: any
  ): Promise<number> {
    const msg = `⚡ Auto-approved (session)

Skill: ${skillId}
Hash: ${codeHash.substring(0, 16)}...
Session: ${sessionId.substring(0, 16)}...
Risk: ${analysis.riskLevel}

${metadata.description || ''}`;

    const sent = await this.bot.sendMessage(this.chatId, msg, {
      disable_notification: true,
      disable_web_page_preview: true
    });
    this.requestMessages.set(requestId, { messageId: sent.message_id, baseText: msg });
    return sent.message_id;
  }

  private async handleEndSession(msg: TelegramBot.Message): Promise<void> {
    const sessionId = (msg.text || '').split(' ')[1];
    if (!sessionId) {
      await this.bot.sendMessage(msg.chat.id, '❌ Usage: /end_session SESSION_ID');
      return;
    }
    const session = this.db.getSession(sessionId);
    if (!session) {
      await this.bot.sendMessage(msg.chat.id, `❌ Session not found or expired: ${sessionId.substring(0, 16)}...`);
      return;
    }
    this.db.deleteSession(sessionId);
    await this.bot.sendMessage(msg.chat.id, `🛑 Session ended: ${sessionId.substring(0, 16)}...`);
  }

  async sendAutoApproveNotification(requestId: string, skillId: string, metadata: any, codeHash: string): Promise<number> {
    const msg = `⚡ Auto-approved (trusted)

Skill: ${skillId}
Hash: ${codeHash.substring(0, 16)}...
Secrets: ${metadata.secrets?.join(', ') || 'none'}
Network: ${metadata.network?.join(', ') || 'none'}

${metadata.description || ''}`;

    const sent = await this.bot.sendMessage(this.chatId, msg, {
      disable_notification: true,
      disable_web_page_preview: true
    });
    this.requestMessages.set(requestId, { messageId: sent.message_id, baseText: msg });
    return sent.message_id;
  }

  stop(): void {
    this.bot.stopPolling();
  }
}
