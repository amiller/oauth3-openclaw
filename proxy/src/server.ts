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
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// Initialize database
const db = new ProxyDatabase(DB_PATH);

import { TelegramApprovalBot } from './telegram.js';

// Load secrets from DB into memory (telegram.ts still uses the object reference)
const secrets: Record<string, string> = db.getAllSecrets();
console.log(`🔑 Loaded ${Object.keys(secrets).length} secrets from database`);

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

      if (level === '24h' || level === 'forever') {
        db.addApproval(request.skill_url, request.code_hash, level);
      }

      db.updateRequestStatus(requestId, 'approved');

      // Use stored code if available, otherwise re-fetch
      let code = db.getCode(requestId);
      if (!code) {
        const codeResponse = await fetch(request.skill_url);
        code = await codeResponse.text();
      }
      const metadata = parseMetadata(code);
      const requiredSecrets = JSON.parse(request.secrets);

      executeInBackground(requestId, code, metadata!, requiredSecrets);
    },
    // On denial
    (requestId) => {
      db.updateRequestStatus(requestId, 'denied');
    },
    PUBLIC_URL
  );

  console.log('✅ Telegram bot initialized');
}

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    telegram_configured: !!TELEGRAM_BOT_TOKEN,
    public_url: PUBLIC_URL || null,
    timestamp: Date.now()
  });
});

// Add secret — persists to SQLite
app.post('/secrets', (req: Request, res: Response) => {
  const { name, value } = req.body;
  if (!name || !value) return res.status(400).json({ error: 'Missing name or value' });
  secrets[name] = value;
  db.setSecret(name, value);
  res.json({ success: true, name });
});

// List secrets (names only)
app.get('/secrets', (req: Request, res: Response) => {
  res.json({ secrets: Object.keys(secrets) });
});

// View code for an execution request
app.get('/view/:id', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const code = db.getCode(id);
  if (!code) return res.status(404).send('Not found');

  const request = db.getRequest(id);
  const metadata = parseMetadata(code);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(metadata?.skill || id)}</title>
<style>
body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;margin:0;padding:1em}
pre{background:#181825;padding:1em;border-radius:8px;overflow-x:auto;line-height:1.5}
h1{color:#89b4fa;font-size:1.2em} .meta{color:#6c7086;margin-bottom:1em}
</style></head><body>
<h1>${esc(metadata?.skill || 'Skill')}</h1>
<div class="meta">${esc(metadata?.description || '')}
<br>Hash: ${request?.code_hash?.substring(0, 16) || '?'}...
<br>Secrets: ${esc(metadata?.secrets?.join(', ') || 'none')}
<br>Network: ${esc(metadata?.network?.join(', ') || 'none')}</div>
<pre>${esc(code)}</pre>
</body></html>`);
});

// Request execution
app.post('/execute', async (req: Request, res: Response) => {
  try {
    const { skill_id, skill_url, secrets: requiredSecrets, args } = req.body;
    if (!skill_id || !skill_url) return res.status(400).json({ error: 'Missing skill_id or skill_url' });

    const codeResponse = await fetch(skill_url);
    if (!codeResponse.ok) return res.status(400).json({ error: 'Failed to fetch skill code' });

    const code = await codeResponse.text();
    const codeHash = hashCode(code);
    const metadata = parseMetadata(code);
    if (!metadata) return res.status(400).json({ error: 'Invalid skill format - missing metadata' });

    const requestId = `exec_${randomBytes(8).toString('hex')}`;
    const secretsList = Array.isArray(requiredSecrets) ? requiredSecrets
      : requiredSecrets && typeof requiredSecrets === 'object' ? Object.keys(requiredSecrets) : [];

    db.createRequest(requestId, skill_id, skill_url, codeHash, secretsList, args);
    db.storeCode(requestId, code);

    if (telegramBot) {
      const messageId = await telegramBot.sendApprovalRequest(requestId, skill_id, skill_url, metadata, codeHash, args);
      db.updateRequestStatus(requestId, 'pending', messageId);
    }

    res.json({ request_id: requestId, status: 'pending', message: 'Awaiting approval' });
  } catch (error: any) {
    console.error('Execute error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get execution status
app.get('/execute/:id/status', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const request = db.getRequest(id);
  if (!request) return res.status(404).json({ error: 'Request not found' });

  const response: any = { request_id: request.id, status: request.status, created_at: request.created_at };
  if (request.approved_at) response.approved_at = request.approved_at;
  if (request.executed_at) response.executed_at = request.executed_at;
  if (request.result) response.result = JSON.parse(request.result);
  if (request.error) response.error = request.error;
  res.json(response);
});

// Helper: Execute skill in background
async function executeInBackground(requestId: string, code: string, metadata: any, requiredSecrets: string[]) {
  console.log(`\n🚀 Starting background execution for ${requestId}`);
  try {
    db.updateRequestStatus(requestId, 'executing');
    const dbRequest = db.getRequest(requestId);
    const args = dbRequest?.args ? JSON.parse(dbRequest.args) : {};

    const secretValues: Record<string, string> = {};
    const missingSecrets: string[] = [];
    for (const name of requiredSecrets) {
      if (!secrets[name]) missingSecrets.push(name);
      else secretValues[name] = secrets[name];
    }

    if (missingSecrets.length > 0) {
      console.log(`  Missing secrets: ${missingSecrets.join(', ')}`);
      db.updateRequestStatus(requestId, 'awaiting_secrets');
      for (const name of missingSecrets) {
        if (telegramBot) await telegramBot.requestSecret(requestId, name);
      }
      return;
    }

    const result = await executeSkill({
      code, secrets: secretValues, args,
      timeout: metadata.timeout || 30,
      allowedNetworks: metadata.network || []
    });
    console.log(`  Execution complete:`, result.success ? '✅' : '❌');

    db.updateRequestResult(requestId, {
      success: result.success, stdout: result.stdout,
      stderr: result.stderr, exitCode: result.exitCode, duration: result.duration
    }, result.success ? undefined : result.stderr);

    const request = db.getRequest(requestId);
    if (request?.telegram_message_id && telegramBot) {
      await telegramBot.updateExecution(request.telegram_message_id, requestId, {
        success: result.success, stdout: result.stdout, error: result.stderr, duration: result.duration
      });
    }
  } catch (error: any) {
    console.error(`❌ Execution failed for ${requestId}:`, error.message);
    db.updateRequestResult(requestId, null, error.message);
    try {
      const request = db.getRequest(requestId);
      if (request?.telegram_message_id && telegramBot) {
        await telegramBot.updateExecution(request.telegram_message_id, requestId, {
          success: false, stdout: '', error: error.message, duration: 0
        });
      }
    } catch {}
  }
}

setInterval(() => db.cleanupExpired(), 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Execution Proxy running on port ${PORT}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log(`⚙️  Executor: ${EXECUTOR_MODE} mode`);
  console.log(`🔗 Public URL: ${PUBLIC_URL || '(not set)'}`);
  console.log(`🤖 Telegram: ${TELEGRAM_BOT_TOKEN ? 'Configured' : 'Not configured'}`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
