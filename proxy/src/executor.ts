/**
 * Deno Skill Executor
 * Runs skills in isolated Deno sandbox with network restrictions
 * Supports two modes:
 *   - "docker": runs in Docker container (default, requires Docker)
 *   - "direct": runs Deno directly (for TEE/dstack where the TEE is the sandbox)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export const EXECUTOR_MODE = process.env.EXECUTOR_MODE || 'docker';

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
  args?: Record<string, any>;
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
 * Execute skill — dispatches to Docker or direct mode
 */
export async function executeSkill(request: ExecutionRequest): Promise<ExecutionResult> {
  if (EXECUTOR_MODE === 'direct') return executeSkillDirect(request);
  return executeSkillDocker(request);
}

/**
 * Build Deno permission args (shared between modes)
 */
function buildDenoPermArgs(request: ExecutionRequest): { denoArgs: string[], argKeys: string[] } {
  const networks = request.allowedNetworks || [];
  const denoArgs = ['run', '--no-prompt', '--quiet'];

  if (networks.length > 0) {
    denoArgs.push(`--allow-net=${networks.join(',')}`);
  }

  const argKeys: string[] = [];
  if (request.args) {
    for (const key of Object.keys(request.args)) argKeys.push(key);
  }

  const allowedEnvVars = [...Object.keys(request.secrets), ...argKeys];
  if (allowedEnvVars.length > 0) {
    denoArgs.push(`--allow-env=${allowedEnvVars.join(',')}`);
  }

  return { denoArgs, argKeys };
}

/**
 * Build env object for skill execution (only allowed vars, NOT process.env)
 */
function buildSkillEnv(request: ExecutionRequest, argKeys: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.secrets)) env[key] = value;
  if (request.args) {
    for (const [key, value] of Object.entries(request.args)) env[key] = String(value);
  }
  // Deno needs HOME and PATH to run, but nothing else from process.env
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

/**
 * Execute skill directly via Deno (no Docker — TEE provides isolation)
 */
async function executeSkillDirect(request: ExecutionRequest): Promise<ExecutionResult> {
  const startTime = Date.now();
  const codeHash = hashCode(request.code);
  const tmpFile = join(tmpdir(), `skill-${codeHash}.ts`);
  await writeFile(tmpFile, request.code, 'utf8');

  try {
    const timeout = request.timeout || 30;
    const { denoArgs, argKeys } = buildDenoPermArgs(request);
    denoArgs.push(tmpFile);

    const env = buildSkillEnv(request, argKeys);

    const { stdout, stderr } = await execFileAsync('deno', denoArgs, {
      timeout: timeout * 1000,
      maxBuffer: 1024 * 1024,
      env
    });

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      duration: Date.now() - startTime,
      codeHash
    };
  } catch (error: any) {
    return {
      success: false,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      exitCode: error.code || 1,
      duration: Date.now() - startTime,
      codeHash
    };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Execute skill in Docker container
 */
async function executeSkillDocker(request: ExecutionRequest): Promise<ExecutionResult> {
  const startTime = Date.now();
  const codeHash = hashCode(request.code);
  const tmpFile = join(tmpdir(), `skill-${codeHash}.ts`);
  await writeFile(tmpFile, request.code, 'utf8');

  try {
    const timeout = request.timeout || 30;
    const networks = request.allowedNetworks || [];

    const dockerArgs = [
      'run', '--rm', '--read-only',
      '--network', networks.length > 0 ? 'bridge' : 'none',
      '--memory', '256m', '--cpus', '0.5',
      '-v', `${tmpFile}:/app/script.ts:ro`
    ];

    for (const [key, value] of Object.entries(request.secrets)) {
      dockerArgs.push('-e', `${key}=${value}`);
    }

    const argKeys: string[] = [];
    if (request.args) {
      for (const [key, value] of Object.entries(request.args)) {
        dockerArgs.push('-e', `${key}=${String(value)}`);
        argKeys.push(key);
      }
    }

    dockerArgs.push('denoland/deno:latest');

    const { denoArgs } = buildDenoPermArgs(request);
    dockerArgs.push(...denoArgs, '/app/script.ts');

    const { stdout, stderr } = await execFileAsync('docker', dockerArgs, {
      timeout: timeout * 1000,
      maxBuffer: 1024 * 1024
    });

    return {
      success: true, stdout: stdout.trim(), stderr: stderr.trim(),
      exitCode: 0, duration: Date.now() - startTime, codeHash
    };
  } catch (error: any) {
    return {
      success: false, stdout: error.stdout || '', stderr: error.stderr || error.message,
      exitCode: error.code || 1, duration: Date.now() - startTime, codeHash
    };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Test if runtime is available (Docker or Deno depending on mode)
 */
export async function checkDeno(): Promise<boolean> {
  try {
    if (EXECUTOR_MODE === 'direct') {
      await execFileAsync('deno', ['--version']);
    } else {
      await execFileAsync('docker', ['--version']);
    }
    return true;
  } catch {
    return false;
  }
}
