/**
 * Database for execution requests and permits
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as pgLog from './postgres.js';

export interface ExecutionRecord {
  id: string;
  action_id: string;
  skill_url: string; // kept for backward compat reads, always 'inline' or 'scope' now
  code_hash: string;
  secrets: string;
  args: string | null;
  status: string;
  created_at: number;
  approved_at: number | null;
  executed_at: number | null;
  result: string | null;
  error: string | null;
  approval_token: string | null;
}

export class ProxyDatabase {
  private db: Database.Database;
  tenantId = 'default';

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
        code TEXT,
        secrets TEXT NOT NULL,
        args TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        approved_at INTEGER,
        executed_at INTEGER,
        result TEXT,
        error TEXT,
        telegram_message_id INTEGER,
        approval_token TEXT
      );

      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        policy TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS scope_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        description TEXT,
        constraints TEXT,
        secrets TEXT,
        networks TEXT,
        approved_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS capabilities (
        spec_hash TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spec TEXT NOT NULL,
        code TEXT NOT NULL,
        doc_domain TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_requests_status ON execution_requests(status);
      CREATE INDEX IF NOT EXISTS idx_requests_created ON execution_requests(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scope_grants_session ON scope_grants(session_id);
    `);
    this.migrate();
  }

  private migrate(): void {
    const cols = (table: string) => {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      return new Set(rows.map(r => r.name));
    };
    const secretCols = cols('secrets');
    if (!secretCols.has('owner_id')) {
      this.db.exec(`ALTER TABLE secrets ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'legacy'`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_secrets_owner ON secrets(owner_id)`);
      // Drop old primary key constraint — recreate table with composite key
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS secrets_v2 (
          name TEXT NOT NULL, value TEXT NOT NULL, owner_id TEXT NOT NULL DEFAULT 'legacy',
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (name, owner_id)
        );
        INSERT OR IGNORE INTO secrets_v2 SELECT name, value, owner_id, created_at, updated_at FROM secrets;
        DROP TABLE secrets;
        ALTER TABLE secrets_v2 RENAME TO secrets;
        CREATE INDEX IF NOT EXISTS idx_secrets_owner ON secrets(owner_id);
      `);
    }
    const capCols = cols('capabilities');
    if (!capCols.has('signature')) {
      this.db.exec(`ALTER TABLE capabilities ADD COLUMN signature TEXT`);
    }
    const sessionCols = cols('sessions');
    if (!sessionCols.has('owner_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN owner_id TEXT`);
      this.db.exec(`ALTER TABLE sessions ADD COLUMN agent_id TEXT`);
    }
  }

  // Execution Requests

  createRequest(
    id: string,
    actionId: string,
    skillUrl: string,
    codeHash: string,
    secrets: string[],
    args?: Record<string, any>,
    approvalToken?: string
  ): void {
    this.db.prepare(`
      INSERT INTO execution_requests (id, skill_id, skill_url, code_hash, secrets, args, status, created_at, approval_token)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, actionId, skillUrl, codeHash, JSON.stringify(secrets), args ? JSON.stringify(args) : null, Date.now(), approvalToken || null);
    pgLog.logExecution(id, this.tenantId, actionId, skillUrl, codeHash);
  }

  getRequest(id: string): ExecutionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM execution_requests WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    // Map old column name to new interface
    return { ...row, action_id: row.skill_id } as ExecutionRecord;
  }

  updateRequestStatus(id: string, status: string): void {
    const updates: string[] = ['status = ?'];
    const params: any[] = [status, id];
    if (status === 'approved') { updates.push('approved_at = ?'); params.splice(1, 0, Date.now()); }
    if (status === 'executing') { updates.push('executed_at = ?'); params.splice(1, 0, Date.now()); }
    this.db.prepare(`UPDATE execution_requests SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    pgLog.updateExecutionStatus(id, status);
  }

  updateRequestResult(id: string, result: any, error?: string): void {
    this.db.prepare('UPDATE execution_requests SET status = ?, result = ?, error = ? WHERE id = ?')
      .run(error ? 'failed' : 'completed', result ? JSON.stringify(result) : null, error || null, id);
    pgLog.updateExecutionResult(id, error ? 'failed' : 'completed', error);
  }

  // Cleanup (no more skill_approvals to clean)
  cleanupExpired(): void {}

  // Secrets

  setSecret(name: string, value: string, ownerId: string): void {
    const now = Date.now();
    this.db.prepare('INSERT INTO secrets (name, value, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name, owner_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(name, value, ownerId, now, now);
  }

  getSecretsByOwner(ownerId: string): Record<string, string> {
    const rows = this.db.prepare('SELECT name, value FROM secrets WHERE owner_id = ?').all(ownerId) as { name: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.name] = r.value;
    return out;
  }

  getSecretNamesByOwner(ownerId: string): string[] {
    const rows = this.db.prepare('SELECT name FROM secrets WHERE owner_id = ?').all(ownerId) as { name: string }[];
    return rows.map(r => r.name);
  }

  deleteSecret(name: string, ownerId: string): void {
    this.db.prepare('DELETE FROM secrets WHERE name = ? AND owner_id = ?').run(name, ownerId);
  }

  // Code storage

  storeCode(requestId: string, code: string): void {
    this.db.prepare('UPDATE execution_requests SET code = ? WHERE id = ?').run(code, requestId);
  }

  getCode(requestId: string): string | null {
    const row = this.db.prepare('SELECT code FROM execution_requests WHERE id = ?').get(requestId) as { code: string | null } | undefined;
    return row?.code ?? null;
  }

  // Sessions (permits)

  createSession(sessionId: string, policy: SessionPolicy, agentId?: string, ownerId?: string): void {
    const now = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO sessions (session_id, created_at, last_activity, policy, agent_id, owner_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, now, now, JSON.stringify(policy), agentId || null, ownerId || null);
    pgLog.logSession(sessionId, this.tenantId, policy.description);
  }

  getSession(sessionId: string): { session_id: string; created_at: number; last_activity: number; policy: SessionPolicy; agent_id: string | null; owner_id: string | null } | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as any;
    if (!row) return undefined;
    if (Date.now() - row.last_activity > 2 * 60 * 60 * 1000) {
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
      return undefined;
    }
    return { ...row, policy: JSON.parse(row.policy) };
  }

  touchSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET last_activity = ? WHERE session_id = ?').run(Date.now(), sessionId);
    pgLog.touchSession(sessionId);
  }

  updateSessionPolicy(sessionId: string, policy: SessionPolicy): void {
    this.db.prepare('UPDATE sessions SET policy = ?, last_activity = ? WHERE session_id = ?')
      .run(JSON.stringify(policy), Date.now(), sessionId);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM scope_grants WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  }

  listSessions(): Array<{ session_id: string; created_at: number; last_activity: number; policy: SessionPolicy; agent_id: string | null; owner_id: string | null }> {
    const now = Date.now();
    const expired = this.db.prepare('SELECT session_id FROM sessions WHERE ? - last_activity > ?').all(now, 2 * 60 * 60 * 1000) as { session_id: string }[];
    for (const e of expired) {
      this.db.prepare('DELETE FROM scope_grants WHERE session_id = ?').run(e.session_id);
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(e.session_id);
    }
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY last_activity DESC').all() as any[];
    return rows.map(r => ({ ...r, policy: JSON.parse(r.policy) }));
  }

  // Scope Grants

  addScopeGrant(sessionId: string, description: string | undefined, constraints: PolicyConstraint[], scopeSecrets: string[], networks: string[]): void {
    this.db.prepare('INSERT INTO scope_grants (session_id, description, constraints, secrets, networks, approved_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, description || null, JSON.stringify(constraints), JSON.stringify(scopeSecrets), JSON.stringify(networks), Date.now());
    pgLog.logScopeGrant(sessionId, this.tenantId, description, constraints, networks);
  }

  getScopeGrants(sessionId: string): Array<{ id: number; description: string | null; constraints: PolicyConstraint[]; secrets: string[]; networks: string[]; approved_at: number }> {
    const rows = this.db.prepare('SELECT * FROM scope_grants WHERE session_id = ? ORDER BY approved_at').all(sessionId) as any[];
    return rows.map(r => ({
      id: r.id, description: r.description,
      constraints: JSON.parse(r.constraints || '[]'), secrets: JSON.parse(r.secrets || '[]'),
      networks: JSON.parse(r.networks || '[]'), approved_at: r.approved_at
    }));
  }

  // Capability cache

  getCachedCapability(specHash: string): { code: string; name: string; signature: string | null } | undefined {
    return this.db.prepare('SELECT name, code, signature FROM capabilities WHERE spec_hash = ?').get(specHash) as { name: string; code: string; signature: string | null } | undefined;
  }

  cacheCapability(specHash: string, name: string, spec: any, code: string, docDomain: string, signature?: string): void {
    this.db.prepare('INSERT OR REPLACE INTO capabilities (spec_hash, name, spec, code, doc_domain, created_at, signature) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(specHash, name, JSON.stringify(spec), code, docDomain, Date.now(), signature || null);
  }

  listRecentRequests(limit = 20): ExecutionRecord[] {
    return this.db.prepare('SELECT * FROM execution_requests ORDER BY created_at DESC LIMIT ?').all(limit) as ExecutionRecord[];
  }

  close(): void {
    this.db.close();
  }
}

import { PolicyConstraint } from './capability.js';
import { CapabilityFunction } from './capability.js';

export interface SessionPolicy {
  allowedSecrets: string[];
  allowedNetworks: string[];
  description?: string;
  capabilities?: CapabilityFunction[];
}
