/**
 * Telegram Bot Integration
 */

import TelegramBot from 'node-telegram-bot-api';
import { ProxyDatabase } from './database.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class TelegramApprovalBot {
  private bot: TelegramBot;
  private chatId: string;
  private db: ProxyDatabase;
  private onApproval: (requestId: string, level: 'once' | '24h' | 'forever') => void;
  private onDenial: (requestId: string) => void;

  constructor(
    token: string,
    chatId: string,
    db: ProxyDatabase,
    onApproval: (requestId: string, level: 'once' | '24h' | 'forever') => void,
    onDenial: (requestId: string) => void
  ) {
    this.bot = new TelegramBot(token, { polling: true });
    this.chatId = chatId;
    this.db = db;
    this.onApproval = onApproval;
    this.onDenial = onDenial;

    this.setupHandlers();
  }

  private async notifyAgent(message: string): Promise<void> {
    try {
      // Trigger OpenClaw cron wake event to notify the agent
      await execAsync(`openclaw cron wake --text "${message.replace(/"/g, '\\"')}" --mode now`);
      console.log('✅ Agent notified via cron wake');
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

    // Handle text messages (for getting chat ID)
    this.bot.on('message', (msg) => {
      console.log(`📨 Message from ${msg.from?.username || 'unknown'} (ID: ${msg.chat.id}): ${msg.text}`);
      
      if (msg.text === '/start' || msg.text === '/id') {
        this.bot.sendMessage(
          msg.chat.id,
          `Your chat ID: ${msg.chat.id}\n\nBot is ready to receive execution requests.`
        );
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

    return sent.message_id;
  }

  async updateExecution(messageId: number, requestId: string, result: any): Promise<void> {
    try {
      const status = result.success ? '✅ Success' : '❌ Failed';
      const duration = result.duration ? `${result.duration}ms` : 'N/A';
      
      let message = `${status}\n\nRequest: ${requestId}\nDuration: ${duration}`;
      
      if (result.success && result.stdout) {
        const output = result.stdout.substring(0, 500);
        message += `\n\nOutput:\n\`\`\`\n${output}\n\`\`\``;
      } else if (result.error) {
        message += `\n\nError: ${result.error}`;
      }

      await this.bot.editMessageText(message, {
        chat_id: this.chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      console.error('Failed to update message:', error);
    }
  }

  stop(): void {
    this.bot.stopPolling();
  }
}
