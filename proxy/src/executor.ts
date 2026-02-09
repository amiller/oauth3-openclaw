/**
 * Deno Skill Executor
 * Runs skills in isolated Deno sandbox with network restrictions
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export interface SkillMetadata {
  skill: string;
  description: string;
  secrets: string[];
  network: string[];
  timeout: number;
}

export interface ExecutionRequest {
  code: string;
  secrets: Record<string, string>;
  timeout?: number;
  allowedNetworks?: string[];
}

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  codeHash: string;
}

/**
 * Calculate SHA256 hash of code
 */
export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Parse skill metadata from code comments
 */
export function parseMetadata(code: string): SkillMetadata | null {
  const lines = code.split('\n');
  const metadata: Partial<SkillMetadata> = {
    secrets: [],
    network: [],
    timeout: 30
  };

  for (const line of lines) {
    const match = line.match(/@(\w+)\s+(.+)/);
    if (match) {
      const [, key, value] = match;
      if (key === 'skill') metadata.skill = value.trim();
      else if (key === 'description') metadata.description = value.trim();
      else if (key === 'secrets') metadata.secrets!.push(value.trim());
      else if (key === 'network') metadata.network!.push(value.trim());
      else if (key === 'timeout') metadata.timeout = parseInt(value.trim());
    }
  }

  if (!metadata.skill) return null;
  return metadata as SkillMetadata;
}

/**
 * Execute skill in Deno sandbox
 */
export async function executeSkill(request: ExecutionRequest): Promise<ExecutionResult> {
  const startTime = Date.now();
  const codeHash = hashCode(request.code);
  
  // Write code to temp file
  const tmpFile = join(tmpdir(), `skill-${codeHash}.ts`);
  await writeFile(tmpFile, request.code, 'utf8');

  try {
    const timeout = request.timeout || 30;
    const networks = request.allowedNetworks || [];
    
    // Build Deno command
    const denoArgs = [
      'run',
      '--no-prompt',
      '--quiet'
    ];

    // Add network permissions
    if (networks.length > 0) {
      denoArgs.push(`--allow-net=${networks.join(',')}`);
    }

    // Add env permissions for secrets
    if (Object.keys(request.secrets).length > 0) {
      denoArgs.push(`--allow-env=${Object.keys(request.secrets).join(',')}`);
    }

    denoArgs.push(tmpFile);

    // Execute with timeout
    const { stdout, stderr } = await execFileAsync('deno', denoArgs, {
      timeout: timeout * 1000,
      env: {
        ...process.env,
        ...request.secrets,
      },
      maxBuffer: 1024 * 1024 // 1MB
    });

    const duration = Date.now() - startTime;

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      duration,
      codeHash
    };

  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    return {
      success: false,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      exitCode: error.code || 1,
      duration,
      codeHash
    };
  } finally {
    // Cleanup temp file
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Test if Deno is available
 */
export async function checkDeno(): Promise<boolean> {
  try {
    await execFileAsync('deno', ['--version']);
    return true;
  } catch {
    return false;
  }
}
