/**
 * Deno Action Executor
 * Runs actions in isolated Deno sandbox with network restrictions
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

/** Prepend `const args = {...}` so action code can use `args.key` directly */
function injectArgsPreamble(code: string, args?: Record<string, any>): string {
  const obj = args && Object.keys(args).length ? JSON.stringify(args) : '{}'
  return `const args: Record<string, any> = ${obj};\n${code}`
}

export const EXECUTOR_MODE = process.env.EXECUTOR_MODE || 'docker';

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

export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Execute action — dispatches to Docker or direct mode */
export async function execute(request: ExecutionRequest): Promise<ExecutionResult> {
  if (EXECUTOR_MODE === 'direct') return executeDirect(request);
  return executeDocker(request);
}

function buildDenoPermArgs(request: ExecutionRequest): { denoArgs: string[], argKeys: string[] } {
  const networks = request.allowedNetworks || [];
  const denoArgs = ['run', '--no-prompt', '--quiet'];

  if (networks.length > 0) denoArgs.push(`--allow-net=${networks.join(',')}`);
  const argKeys = Object.keys(request.args || {});
  const allowedEnvVars = [...Object.keys(request.secrets), ...argKeys];
  if (allowedEnvVars.length > 0) denoArgs.push(`--allow-env=${allowedEnvVars.join(',')}`);
  return { denoArgs, argKeys };
}

function buildActionEnv(request: ExecutionRequest): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.secrets)) env[key] = value;
  if (request.args) {
    for (const [key, value] of Object.entries(request.args)) env[key] = String(value);
  }
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

async function executeDirect(request: ExecutionRequest): Promise<ExecutionResult> {
  const startTime = Date.now();
  const codeHash = hashCode(request.code);
  const tmpFile = join(tmpdir(), `action-${codeHash}.ts`);
  await writeFile(tmpFile, injectArgsPreamble(request.code, request.args), 'utf8');

  try {
    const timeout = request.timeout || 30;
    const { denoArgs } = buildDenoPermArgs(request);
    denoArgs.push(tmpFile);
    const env = buildActionEnv(request);

    const { stdout, stderr } = await execFileAsync('deno', denoArgs, {
      timeout: timeout * 1000, maxBuffer: 1024 * 1024, env
    });

    return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, duration: Date.now() - startTime, codeHash };
  } catch (error: any) {
    return { success: false, stdout: error.stdout || '', stderr: error.stderr || error.message, exitCode: error.code || 1, duration: Date.now() - startTime, codeHash };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

async function executeDocker(request: ExecutionRequest): Promise<ExecutionResult> {
  const startTime = Date.now();
  const codeHash = hashCode(request.code);
  const tmpFile = join(tmpdir(), `action-${codeHash}.ts`);
  await writeFile(tmpFile, injectArgsPreamble(request.code, request.args), 'utf8');

  try {
    const timeout = request.timeout || 30;
    const networks = request.allowedNetworks || [];

    const dockerArgs = [
      'run', '--rm', '--read-only',
      '--network', networks.length > 0 ? 'bridge' : 'none',
      '--memory', '256m', '--cpus', '0.5',
      '-v', `${tmpFile}:/app/script.ts:ro`
    ];

    for (const [key, value] of Object.entries(request.secrets)) dockerArgs.push('-e', `${key}=${value}`);
    if (request.args) {
      for (const [key, value] of Object.entries(request.args)) dockerArgs.push('-e', `${key}=${String(value)}`);
    }

    dockerArgs.push('denoland/deno:latest');
    const { denoArgs } = buildDenoPermArgs(request);
    dockerArgs.push(...denoArgs, '/app/script.ts');

    const { stdout, stderr } = await execFileAsync('docker', dockerArgs, {
      timeout: timeout * 1000, maxBuffer: 1024 * 1024
    });

    return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, duration: Date.now() - startTime, codeHash };
  } catch (error: any) {
    return { success: false, stdout: error.stdout || '', stderr: error.stderr || error.message, exitCode: error.code || 1, duration: Date.now() - startTime, codeHash };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

export async function checkDeno(): Promise<boolean> {
  try {
    if (EXECUTOR_MODE === 'direct') await execFileAsync('deno', ['--version']);
    else await execFileAsync('docker', ['--version']);
    return true;
  } catch { return false; }
}
