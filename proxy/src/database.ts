/**
 * Database for execution requests and approvals
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';

export interface ExecutionRecord {
  id: string;
  skill_id: string;
  skill_url: string;
  code_hash: string;
  secrets: string; // JSON array
  args: string | null; // JSON object
  status: string;
  created_at: number;
  approved_at: number | null;
  executed_at: number | null;
  result: string | null; // JSON
  error: string | null;
  telegram_message_id: number | null;
}

export interface ApprovalRecord {
  skill_url: string;
  code_hash: string;
  approval_level: string;
  approved_at: number;
  expires_at: number | null;
}

export class ProxyDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_requests (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_url TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        secrets TEXT NOT NULL,
        args TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        approved_at INTEGER,
        executed_at INTEGER,
        result TEXT,
        error TEXT,
        telegram_message_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS skill_approvals (
        skill_url TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        approval_level TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (skill_url, code_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_requests_status ON execution_requests(status);
      CREATE INDEX IF NOT EXISTS idx_requests_created ON execution_requests(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approvals_expires ON skill_approvals(expires_at);
    `);
  }

  // Execution Requests
  
  createRequest(
    id: string,
    skillId: string,
    skillUrl: string,
    codeHash: string,
    secrets: string[],
    args?: Record<string, any>
  ): void {
    this.db.prepare(`
      INSERT INTO execution_requests (id, skill_id, skill_url, code_hash, secrets, args, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id,
      skillId,
      skillUrl,
      codeHash,
      JSON.stringify(secrets),
      args ? JSON.stringify(args) : null,
      Date.now()
    );
  }

  getRequest(id: string): ExecutionRecord | undefined {
    return this.db.prepare(`
      SELECT * FROM execution_requests WHERE id = ?
    `).get(id) as ExecutionRecord | undefined;
  }

  updateRequestStatus(id: string, status: string, telegramMessageId?: number): void {
    const updates: string[] = ['status = ?'];
    const params: any[] = [status, id];

    if (status === 'approved') {
      updates.push('approved_at = ?');
      params.splice(1, 0, Date.now());
    }
    if (status === 'executing') {
      updates.push('executed_at = ?');
      params.splice(1, 0, Date.now());
    }
    if (telegramMessageId) {
      updates.push('telegram_message_id = ?');
      params.splice(1, 0, telegramMessageId);
    }

    this.db.prepare(`
      UPDATE execution_requests SET ${updates.join(', ')} WHERE id = ?
    `).run(...params);
  }

  updateRequestResult(id: string, result: any, error?: string): void {
    this.db.prepare(`
      UPDATE execution_requests 
      SET status = ?, result = ?, error = ?
      WHERE id = ?
    `).run(
      error ? 'failed' : 'completed',
      result ? JSON.stringify(result) : null,
      error || null,
      id
    );
  }

  // Skill Approvals

  addApproval(
    skillUrl: string,
    codeHash: string,
    approvalLevel: 'once' | '24h' | 'forever'
  ): void {
    const expiresAt = approvalLevel === '24h' 
      ? Date.now() + 24 * 60 * 60 * 1000 
      : null;

    this.db.prepare(`
      INSERT OR REPLACE INTO skill_approvals (skill_url, code_hash, approval_level, approved_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(skillUrl, codeHash, approvalLevel, Date.now(), expiresAt);
  }

  getApproval(skillUrl: string, codeHash: string): ApprovalRecord | undefined {
    const approval = this.db.prepare(`
      SELECT * FROM skill_approvals 
      WHERE skill_url = ? AND code_hash = ?
    `).get(skillUrl, codeHash) as ApprovalRecord | undefined;

    // Check if expired
    if (approval && approval.expires_at && approval.expires_at < Date.now()) {
      this.deleteApproval(skillUrl, codeHash);
      return undefined;
    }

    return approval;
  }

  deleteApproval(skillUrl: string, codeHash: string): void {
    this.db.prepare(`
      DELETE FROM skill_approvals WHERE skill_url = ? AND code_hash = ?
    `).run(skillUrl, codeHash);
  }

  // Cleanup expired approvals
  cleanupExpired(): void {
    this.db.prepare(`
      DELETE FROM skill_approvals WHERE expires_at IS NOT NULL AND expires_at < ?
    `).run(Date.now());
  }

  close(): void {
    this.db.close();
  }
}
