/**
 * Core types for execution proxy
 */

export interface ExecutionRequest {
  skill_id: string;
  skill_url: string;
  secrets: string[];
  args?: Record<string, any>;
}

export interface ExecutionStatus {
  request_id: string;
  status: 'pending' | 'approved' | 'denied' | 'executing' | 'completed' | 'failed';
  created_at: number;
  approved_at?: number;
  executed_at?: number;
  result?: any;
  error?: string;
  code_hash?: string;
}

export interface SkillApproval {
  skill_url: string;
  code_hash: string;
  approval_level: 'once' | '24h' | 'forever';
  approved_at: number;
  expires_at?: number;
}
