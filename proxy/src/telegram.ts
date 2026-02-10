/**
 * Telegram Bot Integration
 */

import TelegramBot from 'node-telegram-bot-api';
import { ProxyDatabase } from './database.js';
import { appendFile } from 'fs/promises';

export class TelegramApprovalBot {
  private bot: TelegramBot;
  private chatId: string;
  private db: ProxyDatabase;
  private onApproval: (requestId: string, level: 'once' | '24h' | 'forever') => void;
  private onDenial: (requestId: string) => void;
  private secretStore: Record<string, string>;

  constructor(
    token: string,
    chatId: string,
    db: ProxyDatabase,
    secretStore: Record<string, string>,
    onApproval: (requestId: string, level: 'once' | '24h' | 'forever') => void,
    onDenial: (requestId: string) => void
  ) {
    this.bot = new TelegramBot(token, { polling: true });
    this.chatId = chatId;
    this.db = db;
    this.secretStore = secretStore;
    this.onApproval = onApproval;
    this.onDenial = onDenial;

    this.setupHandlers();
  }

  private async notifyAgent(message: string): Promise<void> {
    try {
      // Write to file (backup)
      const timestamp = new Date().toISOString();
      const notif = `${timestamp} ${message}\n`;
      await appendFile('/tmp/oauth3-notifications.log', notif);
      
      // Also try to POST to local notification endpoint (if available)
      try {
        const response = await fetch('http://127.0.0.1:18790/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        if (response.ok) {
          console.log('✅ Agent notified immediately via HTTP');
        }
      } catch (httpError) {
        // Notification endpoint not running, file-based fallback only
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
        const data = query.data || '';
        const [action, requestId, level] = data.split(':');

        if (action === 'approve') {
          console.log(`👆 [${new Date().toISOString()}] Approval button clicked for ${requestId}`);
          const approvalLevel = (level as 'once' | '24h' | 'forever') || 'once';
          this.onApproval(requestId, approvalLevel);
          
          await this.bot.editMessageText(
            `✅ Approved (${approvalLevel})\n\nRequest: ${requestId}\nExecuting...`,
            {
              chat_id: query.message!.chat.id,
              message_id: query.message!.message_id
            }
          );
          
          // Notify agent via cron wake
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
      
      if (msg.text === '/start' || msg.text === '/id') {
        await this.bot.sendMessage(
          msg.chat.id,
          `Your chat ID: ${msg.chat.id}\n\nBot is ready to receive execution requests.`
        );
      } else if (msg.text?.startsWith('/add_secret ')) {
        await this.handleAddSecret(msg);
      } else if (msg.text === '/list_secrets') {
        await this.handleListSecrets(msg);
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
    codeHash: string
  ): Promise<number> {
    console.log(`📤 [${new Date().toISOString()}] Sending Telegram approval request for ${requestId}`);
    
    const message = `🔐 Execution Request

Skill: ${skillId}
Secrets: ${metadata.secrets.join(', ')}
Network: ${metadata.network.join(', ')}
Timeout: ${metadata.timeout}s

📄 View Code on GitHub
${skillUrl}

Description: ${metadata.description}

Hash: ${codeHash.substring(0, 16)}...`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Run Once', callback_data: `approve:${requestId}:once` },
          { text: '❌ Deny', callback_data: `deny:${requestId}` }
        ],
        [
          { text: '✅ Trust 24h', callback_data: `approve:${requestId}:24h` },
          { text: '✅ Always Trust', callback_data: `approve:${requestId}:forever` }
        ]
      ]
    };

    const sent = await this.bot.sendMessage(this.chatId, message, {
      reply_markup: keyboard,
      disable_web_page_preview: false
    });

    console.log(`✅ [${new Date().toISOString()}] Telegram message sent (message_id: ${sent.message_id})`);
    return sent.message_id;
  }

  async updateExecution(messageId: number, requestId: string, result: any): Promise<void> {
    try {
      const status = result.success ? '✅ Success' : '❌ Failed';
      const duration = result.duration ? `${result.duration}ms` : 'N/A';
      
      // Log execution result to console
      console.log('\n📊 Execution Result:');
      console.log(`  Status: ${status}`);
      console.log(`  Duration: ${duration}`);
      if (result.stdout) console.log(`  Stdout: ${result.stdout}`);
      if (result.stderr) console.log(`  Stderr: ${result.stderr}`);
      if (result.error) console.log(`  Error: ${result.error}`);
      
      let message = `${status}\n\nRequest: ${requestId}\nDuration: ${duration}`;
      
      if (result.success && result.stdout) {
        const output = result.stdout.substring(0, 500);
        message += `\n\nOutput:\n${output}`;
      } else if (result.error) {
        message += `\n\nError: ${result.error}`;
      }

      await this.bot.editMessageText(message, {
        chat_id: this.chatId,
        message_id: messageId
        // No parse_mode - plain text to avoid markdown escaping issues
      });
    } catch (error) {
      console.error('Failed to update message:', error);
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
      
      // Store the secret
      this.secretStore[secretName] = secretValue;
      
      // Delete the user's message immediately (security!)
      try {
        await this.bot.deleteMessage(msg.chat.id, msg.message_id);
      } catch (deleteError) {
        console.warn('Could not delete message:', deleteError);
      }
      
      // Send confirmation (without showing the secret)
      await this.bot.sendMessage(
        msg.chat.id,
        `✅ Secret added: ${secretName}\n\nYou can now submit execution requests that need this secret.\n\n⚠️ Note: Secrets are stored in memory and will be lost on restart.`
      );
      
      console.log(`🔐 Secret added via Telegram: ${secretName} (length: ${secretValue.length})`);
    } catch (error) {
      console.error('Error adding secret:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ Failed to add secret');
    }
  }

  private async handleListSecrets(msg: TelegramBot.Message): Promise<void> {
    try {
      const secretNames = Object.keys(this.secretStore);
      
      if (secretNames.length === 0) {
        await this.bot.sendMessage(
          msg.chat.id,
          '📋 No secrets stored.\n\nAdd one with:\n/add_secret SECRET_NAME secret_value'
        );
        return;
      }
      
      const list = secretNames.map(name => `• ${name}`).join('\n');
      await this.bot.sendMessage(
        msg.chat.id,
        `📋 Stored secrets (${secretNames.length}):\n\n${list}\n\n⚠️ In-memory only (lost on restart)`
      );
    } catch (error) {
      console.error('Error listing secrets:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ Failed to list secrets');
    }
  }

  async requestSecret(requestId: string, secretName: string): Promise<void> {
    try {
      const message = `🔑 Missing Secret Required

Request: ${requestId}
Secret: ${secretName}

To add this secret, use:

/add_secret ${secretName} your-secret-value-here

After adding the secret, the execution will automatically retry.`;

      await this.bot.sendMessage(this.chatId, message);
      
      console.log(`📨 Requested secret ${secretName} for ${requestId}`);
    } catch (error) {
      console.error('Error requesting secret:', error);
    }
  }

  stop(): void {
    this.bot.stopPolling();
  }
}
