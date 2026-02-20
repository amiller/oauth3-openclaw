import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
let pool: pg.Pool | null = null

export function getPg(): pg.Pool | null {
  if (!DATABASE_URL) return null
  if (!pool) {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 })
    pool.on('error', (err) => console.error('Postgres pool error:', err.message))
    initSchema(pool)
  }
  return pool
}

async function initSchema(p: pg.Pool) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS execution_log (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      skill_id TEXT NOT NULL,
      skill_url TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      error TEXT,
      CONSTRAINT fk_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS sessions_log (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_activity TIMESTAMPTZ NOT NULL DEFAULT now(),
      description TEXT,
      CONSTRAINT fk_tenant2 FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS scope_grants_log (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      tenant_id TEXT,
      description TEXT,
      constraints JSONB,
      networks JSONB,
      approved_at TIMESTAMPTZ,
      CONSTRAINT fk_session FOREIGN KEY (session_id) REFERENCES sessions_log(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_exec_tenant ON execution_log(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_exec_created ON execution_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions_log(tenant_id);
  `)
  console.log('📊 Postgres schema initialized')
}

// Fire-and-forget writes — never block the main flow
function bg(fn: () => Promise<any>) {
  fn().catch(err => console.error('Postgres write error:', err.message))
}

export function logExecution(id: string, tenantId: string, skillId: string, skillUrl: string, codeHash: string) {
  const p = getPg()
  if (!p) return
  bg(() => p.query(
    `INSERT INTO execution_log (id, tenant_id, skill_id, skill_url, code_hash, status) VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT DO NOTHING`,
    [id, tenantId, skillId, skillUrl, codeHash]
  ))
}

export function updateExecutionStatus(id: string, status: string) {
  const p = getPg()
  if (!p) return
  const col = status === 'approved' ? 'approved_at' : status === 'executing' ? 'executed_at' : status === 'completed' || status === 'failed' ? 'completed_at' : null
  if (col) {
    bg(() => p.query(`UPDATE execution_log SET status=$1, ${col}=now() WHERE id=$2`, [status, id]))
  } else {
    bg(() => p.query(`UPDATE execution_log SET status=$1 WHERE id=$2`, [status, id]))
  }
}

export function updateExecutionResult(id: string, status: string, error?: string) {
  const p = getPg()
  if (!p) return
  bg(() => p.query(`UPDATE execution_log SET status=$1, error=$2, completed_at=now() WHERE id=$3`, [status, error || null, id]))
}

export function logSession(sessionId: string, tenantId: string, description?: string) {
  const p = getPg()
  if (!p) return
  bg(() => p.query(
    `INSERT INTO sessions_log (session_id, tenant_id, description) VALUES ($1,$2,$3) ON CONFLICT (session_id) DO UPDATE SET last_activity=now()`,
    [sessionId, tenantId, description || null]
  ))
}

export function logScopeGrant(sessionId: string, tenantId: string, description?: string, constraints?: any[], networks?: string[]) {
  const p = getPg()
  if (!p) return
  bg(() => p.query(
    `INSERT INTO scope_grants_log (session_id, tenant_id, description, constraints, networks, approved_at) VALUES ($1,$2,$3,$4,$5,now())`,
    [sessionId, tenantId, description || null, JSON.stringify(constraints || []), JSON.stringify(networks || [])]
  ))
}

export function touchSession(sessionId: string) {
  const p = getPg()
  if (!p) return
  bg(() => p.query(`UPDATE sessions_log SET last_activity=now() WHERE session_id=$1`, [sessionId]))
}

export function ensureTenant(tenantId: string, plan = 'free') {
  const p = getPg()
  if (!p) return
  bg(() => p.query(
    `INSERT INTO tenants (tenant_id, plan) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [tenantId, plan]
  ))
}
