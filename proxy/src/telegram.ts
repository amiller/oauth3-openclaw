/**
 * Telegram Bot Integration
 */

import TelegramBot from 'node-telegram-bot-api';
import { ProxyDatabase } from './database.js';
import { appendFile } from 'fs/promises';

interface PendingApproval {
  requestId: string;
  level: 'once' | '24h' | 'forever' | 'trust_code';
  messageId: number;
  requiredSecrets: string[];
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
    this.publicUrl = publicUrl;

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
        const data = query.data || '';
        const parts = data.split(':');
        const action = parts[0];

        if (action === 'add_secret') {
          // Handle "Add SECRET_NAME" button
          const secretName = parts[1];
          const relatedRequestId = parts[2]; // Optional - if this secret is for a pending approval
          
          await this.bot.answerCallbackQuery(query.id, {
            text: `Reply to this message with the value for ${secretName}`
          });
          
          // Send a force_reply message
          const sent = await this.bot.sendMessage(
            query.message!.chat.id,
            `🔑 Add Secret: ${secretName}\n\nReply to this message with the secret value.\n\n⚠️ The message will be deleted immediately for security.`,
            {
              reply_markup: {
                force_reply: true,
                selective: true
              }
            }
          );
          
          // Store metadata so we know which request this secret is for
          if (relatedRequestId) {
            (sent as any)._relatedRequestId = relatedRequestId;
          }
          
          return;
        }

        const requestId = parts[1];
        const level = parts[2];

        if (action === 'approve') {
          console.log(`👆 [${new Date().toISOString()}] Approval button clicked for ${requestId}`);
          const approvalLevel = (level as 'once' | 'trust_code' | '24h' | 'forever') || 'once';
          
          // If trust_code, mark code as trusted permanently
          if (approvalLevel === 'trust_code') {
            const request = this.db.getRequest(requestId);
            if (request) {
              this.db.addApproval(request.skill_url, request.code_hash, 'forever');
              console.log(`🔒 Code trusted: ${request.code_hash.substring(0, 16)}...`);
            }
          }
          
          // Mark original message as approved (keep it visible)
          try {
            await this.bot.editMessageReplyMarkup(
              { inline_keyboard: [] }, // Remove buttons
              {
                chat_id: query.message!.chat.id,
                message_id: query.message!.message_id
              }
            );
          } catch (e) {
            // Editing failed, that's okay
          }
          
          // Check if any required secrets are missing
          const requiredSecrets = this.requestMetadata.get(requestId) || [];
          const missingSecrets = requiredSecrets.filter(name => !this.secretStore[name]);
          
          if (missingSecrets.length > 0) {
            // Send new message prompting for secret
            const secretName = missingSecrets[0];
            const keyboard = {
              inline_keyboard: [
                [
                  { text: `🔑 Add ${secretName}`, callback_data: `add_secret:${secretName}:${requestId}` }
                ]
              ]
            };
            
            const sent = await this.bot.sendMessage(
              query.message!.chat.id,
              `✅ Approved (${approvalLevel})\n\n🔑 Secret Required: ${secretName}\n\nRequest: ${requestId}\n\nClick below to add it, then execution will proceed automatically.`,
              {
                reply_markup: keyboard
              }
            );
            
            // Store pending approval with the new message ID
            this.pendingApprovals.set(requestId, {
              requestId,
              level: approvalLevel,
              messageId: sent.message_id,
              requiredSecrets: missingSecrets
            });
            
            await this.bot.answerCallbackQuery(query.id, {
              text: `Approved - secret ${secretName} required`
            });
            return;
          }
          
          // All secrets available - proceed with execution
          this.onApproval(requestId, approvalLevel);
          
          await this.bot.sendMessage(
            query.message!.chat.id,
            `✅ Approved (${approvalLevel})\n\nRequest: ${requestId}\nExecuting...`
          );
          
          await this.bot.answerCallbackQuery(query.id, {
            text: `Approved - executing`
          });
          
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
            if (pending.requiredSecrets.includes(secretName)) {
              // Remove buttons from the secret prompt message
              try {
                await this.bot.editMessageReplyMarkup(
                  { inline_keyboard: [] },
                  {
                    chat_id: msg.chat.id,
                    message_id: pending.messageId
                  }
                );
              } catch (e) {
                // Editing failed, that's okay
              }
              
              // Check if all secrets are now available
              const stillMissing = pending.requiredSecrets.filter(name => !this.secretStore[name]);
              
              if (stillMissing.length === 0) {
                // All secrets available - execute!
                this.pendingApprovals.delete(requestId);
                this.onApproval(requestId, pending.level);
                
                await this.bot.sendMessage(
                  msg.chat.id,
                  `✅ Secret added: ${secretName}\n\nRequest: ${requestId}\nExecuting...`
                );
                
                await this.notifyAgent(`Execution approved (${pending.level}): ${requestId}`);
                executedAny = true;
              } else {
                // Still missing other secrets - send new prompt
                const nextSecret = stillMissing[0];
                const keyboard = {
                  inline_keyboard: [
                    [
                      { text: `🔑 Add ${nextSecret}`, callback_data: `add_secret:${nextSecret}:${requestId}` }
                    ]
                  ]
                };
                
                const sent = await this.bot.sendMessage(
                  msg.chat.id,
                  `✅ Added: ${secretName}\n\n🔑 Still need: ${nextSecret}\n\nRequest: ${requestId}\n\nClick below to add it.`,
                  {
                    reply_markup: keyboard
                  }
                );
                
                // Update pending approval with new message ID
                pending.messageId = sent.message_id;
              }
            }
          }
          
          if (!executedAny) {
            // No pending approvals - just confirm
            await this.bot.sendMessage(
              msg.chat.id,
              `✅ Secret added: ${secretName}\n\nYou can now approve execution requests that need it.`
            );
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
    codeHash: string,
    args?: Record<string, any>
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
      
      // Get original message to preserve context
      let originalMessage = '';
      try {
        const msg = await this.bot.getChat(this.chatId);
        // Can't easily get message text, so we'll send a separate result message instead
      } catch (e) {
        // Fallback
      }
      
      // Build result section
      let resultSection = `\n\n━━━━━━━━━━━━━━━━━━━━\n${status}\nDuration: ${duration}`;
      
      if (result.success && result.stdout) {
        const output = result.stdout.substring(0, 400);
        resultSection += `\n\nOutput:\n${output}`;
        if (result.stdout.length > 400) {
          resultSection += `\n... (truncated)`;
        }
      } else if (result.error) {
        // Shorten error for readability
        const shortError = result.error.length > 200 
          ? result.error.substring(0, 200) + '...' 
          : result.error;
        resultSection += `\n\nError:\n${shortError}`;
      }
      
      // Send as new message to preserve context
      await this.bot.sendMessage(this.chatId, resultSection, {
        reply_to_message_id: messageId
      });
      
      // Notify agent of completion
      const notificationText = result.success 
        ? `Execution completed successfully: ${requestId} (${duration})`
        : `Execution failed: ${requestId} - ${result.error || 'Unknown error'}`;
      await this.notifyAgent(notificationText);
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
        `📋 Stored secrets (${secretNames.length}):\n\n${list}\n\n✅ Persisted to database`
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

Click the button below to add this secret securely.

After adding the secret, the execution will automatically retry.`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: `🔑 Add ${secretName}`, callback_data: `add_secret:${secretName}` }
          ]
        ]
      };

      await this.bot.sendMessage(this.chatId, message, {
        reply_markup: keyboard
      });
      
      console.log(`📨 Requested secret ${secretName} for ${requestId}`);
    } catch (error) {
      console.error('Error requesting secret:', error);
    }
  }

  stop(): void {
    this.bot.stopPolling();
  }
}
