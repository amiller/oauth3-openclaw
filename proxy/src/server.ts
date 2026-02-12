/**
 * HTTP API Server for Execution Proxy
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import { ProxyDatabase } from './database.js';
import { executeSkill, hashCode, parseMetadata, EXECUTOR_MODE } from './executor.js';
import { randomBytes } from 'crypto';

const app = express();
app.use(express.json());

// Config from environment
const PORT = parseInt(process.env.PORT || '3737');
const DB_PATH = process.env.DB_PATH || './proxy.db';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Initialize database
const db = new ProxyDatabase(DB_PATH);

import { TelegramApprovalBot } from './telegram.js';

interface SecretStore {
  [key: string]: string;
}

// In-memory secret store (will be replaced with encrypted storage)
const secrets: SecretStore = {};

// Telegram bot
let telegramBot: TelegramApprovalBot | null = null;

if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  telegramBot = new TelegramApprovalBot(
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    db,
    secrets,
    // On approval
    async (requestId, level) => {
      const request = db.getRequest(requestId);
      if (!request) return;

      // Add to approvals if 24h or forever or trust_code
      if (level === '24h' || level === 'forever') {
        db.addApproval(request.skill_url, request.code_hash, level);
      } else if (level === 'trust_code') {
        // trust_code means trust the code permanently (already handled in telegram.ts)
        // No need to add again here
      }

      // Approve and execute
      db.updateRequestStatus(requestId, 'approved');
      
      // Fetch code and execute
      const codeResponse = await fetch(request.skill_url);
      const code = await codeResponse.text();
      const metadata = parseMetadata(code);
      const requiredSecrets = JSON.parse(request.secrets);
      
      executeInBackground(requestId, code, metadata!, requiredSecrets);
    },
    // On denial
    (requestId) => {
      db.updateRequestStatus(requestId, 'denied');
    }
  );
  
  console.log('✅ Telegram bot initialized');
}

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok',
    telegram_configured: !!TELEGRAM_BOT_TOKEN,
    timestamp: Date.now()
  });
});

// Add secret (admin only - will add auth later)
app.post('/secrets', (req: Request, res: Response) => {
  const { name, value } = req.body;
  
  if (!name || !value) {
    return res.status(400).json({ error: 'Missing name or value' });
  }

  secrets[name] = value;
  res.json({ success: true, name });
});

// List secrets (names only)
app.get('/secrets', (req: Request, res: Response) => {
  res.json({ secrets: Object.keys(secrets) });
});

// Request execution
app.post('/execute', async (req: Request, res: Response) => {
  try {
    const { skill_id, skill_url, secrets: requiredSecrets, args } = req.body;

    if (!skill_id || !skill_url) {
      return res.status(400).json({ error: 'Missing skill_id or skill_url' });
    }

    // Fetch skill code from URL
    const codeResponse = await fetch(skill_url);
    if (!codeResponse.ok) {
      return res.status(400).json({ error: 'Failed to fetch skill code' });
    }

    const code = await codeResponse.text();
    const codeHash = hashCode(code);

    // Parse metadata
    const metadata = parseMetadata(code);
    if (!metadata) {
      return res.status(400).json({ error: 'Invalid skill format - missing metadata' });
    }

    // Generate request ID
    const requestId = `exec_${randomBytes(8).toString('hex')}`;

    // Normalize secrets to string[] (accept array or object)
    const secretsList = Array.isArray(requiredSecrets) ? requiredSecrets
      : requiredSecrets && typeof requiredSecrets === 'object' ? Object.keys(requiredSecrets) : [];

    // Create request record
    db.createRequest(requestId, skill_id, skill_url, codeHash, secretsList, args);

    // Always send approval request (Option A: separate code trust from invocation approval)
    // Even if code is trusted, human still approves each invocation
    
    // Send Telegram approval request
    if (telegramBot) {
      const messageId = await telegramBot.sendApprovalRequest(
        requestId,
        skill_id,
        skill_url,
        metadata,
        codeHash,
        args
      );
      db.updateRequestStatus(requestId, 'pending', messageId);
    } else {
      console.warn('Telegram not configured - approval request cannot be sent');
    }

    res.json({
      request_id: requestId,
      status: 'pending',
      message: 'Awaiting approval'
    });

  } catch (error: any) {
    console.error('Execute error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get execution status
app.get('/execute/:id/status', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const request = db.getRequest(id);
  
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  const response: any = {
    request_id: request.id,
    status: request.status,
    created_at: request.created_at
  };

  if (request.approved_at) response.approved_at = request.approved_at;
  if (request.executed_at) response.executed_at = request.executed_at;
  if (request.result) response.result = JSON.parse(request.result);
  if (request.error) response.error = request.error;

  res.json(response);
});

// Helper: Format approval message
function formatApprovalMessage(skillId: string, skillUrl: string, metadata: any): string {
  return `🔐 Execution Request

Skill: ${skillId}
Secrets: ${metadata.secrets.join(', ')}
Network: ${metadata.network.join(', ')}

📄 View Code
${skillUrl}

Description: ${metadata.description}`;
}

// Helper: Execute skill in background
async function executeInBackground(
  requestId: string,
  code: string,
  metadata: any,
  requiredSecrets: string[]
) {
  console.log(`\n🚀 Starting background execution for ${requestId}`);
  console.log(`  Metadata:`, metadata);
  console.log(`  Required secrets:`, requiredSecrets);
  
  try {
    db.updateRequestStatus(requestId, 'executing');
    console.log(`  Status updated to 'executing'`);

    // Get request from database to retrieve args
    const dbRequest = db.getRequest(requestId);
    const args = dbRequest?.args ? JSON.parse(dbRequest.args) : {};

    // Build secrets object
    const secretValues: Record<string, string> = {};
    const missingSecrets: string[] = [];
    
    for (const secretName of requiredSecrets) {
      if (!secrets[secretName]) {
        missingSecrets.push(secretName);
      } else {
        secretValues[secretName] = secrets[secretName];
      }
    }
    
    // If secrets are missing, request them from the user
    if (missingSecrets.length > 0) {
      console.log(`  Missing secrets: ${missingSecrets.join(', ')}`);
      db.updateRequestStatus(requestId, 'awaiting_secrets');
      
      // Request each missing secret
      for (const secretName of missingSecrets) {
        if (telegramBot) {
          await telegramBot.requestSecret(requestId, secretName);
        }
      }
      
      console.log(`  ⏸️ Execution paused - waiting for secrets from user`);
      return; // Don't throw error, just wait for secrets
    }

    // Execute
    console.log(`  Calling executeSkill...`);
    const result = await executeSkill({
      code,
      secrets: secretValues,
      args,
      timeout: metadata.timeout || 30,
      allowedNetworks: metadata.network || []
    });
    console.log(`  Execution complete:`, result.success ? '✅' : '❌');

    // Store result
    db.updateRequestResult(requestId, {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      duration: result.duration
    }, result.success ? undefined : result.stderr);

    // Update Telegram message
    const request = db.getRequest(requestId);
    if (request?.telegram_message_id && telegramBot) {
      try {
        console.log(`  Updating Telegram message ${request.telegram_message_id}...`);
        await telegramBot.updateExecution(request.telegram_message_id, requestId, {
          success: result.success,
          stdout: result.stdout,
          error: result.stderr,
          duration: result.duration
        });
        console.log(`  ✅ Telegram message updated`);
      } catch (updateError: any) {
        console.error(`  ⚠️ Failed to update Telegram message:`, updateError.message);
      }
    } else {
      console.log(`  ⚠️ No Telegram message to update (message_id: ${request?.telegram_message_id})`);
    }

  } catch (error: any) {
    console.error(`❌ Execution failed for ${requestId}:`, error.message);
    console.error(`  Stack:`, error.stack);
    db.updateRequestResult(requestId, null, error.message);
    
    // Try to update Telegram even on crash
    try {
      const request = db.getRequest(requestId);
      if (request?.telegram_message_id && telegramBot) {
        await telegramBot.updateExecution(request.telegram_message_id, requestId, {
          success: false,
          stdout: '',
          error: error.message,
          duration: 0
        });
      }
    } catch (updateError) {
      console.error(`  Failed to notify user of crash:`, updateError);
    }
  }
}

// Cleanup expired approvals periodically
setInterval(() => {
  db.cleanupExpired();
}, 60 * 60 * 1000); // Every hour

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Execution Proxy running on port ${PORT}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log(`⚙️  Executor: ${EXECUTOR_MODE} mode`);
  console.log(`🤖 Telegram: ${TELEGRAM_BOT_TOKEN ? 'Configured' : 'Not configured'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});
