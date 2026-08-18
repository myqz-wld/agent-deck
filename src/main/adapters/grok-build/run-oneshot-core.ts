import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  buildGrokHeadlessArgs,
  type GrokOneshotResult,
  type RunGrokOneshotOptions,
} from '@main/session/oneshot-llm/grok-runner';
import { raceWithTimeout } from '@main/session/oneshot-llm/race-with-timeout';

const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;
const STOP_TIMEOUT_MS = 2_000;
const DELETE_TIMEOUT_MS = 3_000;

interface GrokHeadlessEnvelope {
  text?: unknown;
  structuredOutput?: unknown;
  error?: unknown;
  stopReason?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

export interface GrokOneshotCoreHost {
  readonly environment: Readonly<Record<string, string>>;
  readonly temporaryRoot: string;
  resolveBinary(configuredPath: string | null): Promise<string>;
}

/** Server-owned resolution never falls back to desktop bundle/cache discovery. */
export async function resolveExplicitGrokOneshotBinary(
  configuredPath: string | null,
): Promise<string> {
  const candidate = configuredPath?.trim();
  if (!candidate || !isAbsolute(candidate)) {
    throw new Error('Server Core Grok Build binary path must be absolute');
  }
  await access(candidate, constants.X_OK);
  return candidate;
}

function childEnvironment(host: GrokOneshotCoreHost): NodeJS.ProcessEnv {
  return {
    ...host.environment,
    AGENT_DECK_ORIGIN: 'sdk',
    GROK_CLAUDE_HOOKS_ENABLED: '0',
    GROK_CURSOR_HOOKS_ENABLED: '0',
    GROK_DISABLE_AUTOUPDATER: '1',
  };
}

/**
 * Run a Grok headless turn using only the environment and temporary root owned by the caller.
 * Server Core uses this boundary so Relay/Full never rediscover desktop process state.
 */
export async function runGrokOneshotWithHost(
  options: RunGrokOneshotOptions,
  host: GrokOneshotCoreHost,
): Promise<GrokOneshotResult> {
  mkdirSync(host.temporaryRoot, { recursive: true, mode: 0o700 });
  const isolatedCwd = mkdtempSync(join(host.temporaryRoot, 'agent-deck-grok-oneshot-'));
  const promptFile = join(isolatedCwd, 'prompt.txt');
  const sessionId = randomUUID();
  let binary: string | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    writeFileSync(promptFile, options.prompt, { encoding: 'utf8', mode: 0o600 });
    binary = await host.resolveBinary(options.binaryPath ?? null);
    const args = buildGrokHeadlessArgs({
      promptFile,
      sessionId,
      systemPrompt: options.systemPrompt,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    });
    child = spawn(binary, args, {
      cwd: isolatedCwd,
      env: childEnvironment(host),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const runningChild = child;
    const work = captureHeadlessResult(runningChild, options.maxOutputBytes);
    return await raceWithTimeout({
      work,
      timeoutMs: options.timeoutMs,
      errorMessage: options.timeoutErrorMessage,
      onTimeout: () => runningChild.kill('SIGTERM'),
      signal: options.signal,
      onAbort: () => runningChild.kill('SIGTERM'),
    });
  } finally {
    if (child) await stopChild(child);
    if (binary && child) await deleteEphemeralSession(binary, sessionId, host);
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

async function captureHeadlessResult(
  child: ChildProcessWithoutNullStreams,
  maxOutputBytes?: number,
): Promise<GrokOneshotResult> {
  let output = '';
  let diagnostics = '';
  let overflow = false;
  child.stdout.on('data', (chunk: Buffer | string) => {
    if (overflow) return;
    output += chunk.toString();
    if (Buffer.byteLength(output, 'utf8') > OUTPUT_LIMIT_BYTES) {
      overflow = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    diagnostics = `${diagnostics}${chunk.toString()}`.slice(-DIAGNOSTIC_LIMIT_BYTES);
  });
  const { code, signal } = await childResult(child);
  if (overflow) throw new Error(`Grok Build 单次运行输出超过 ${OUTPUT_LIMIT_BYTES} 字节上限。`);

  let parsed: GrokHeadlessEnvelope;
  try {
    parsed = JSON.parse(output.trim()) as GrokHeadlessEnvelope;
  } catch (error) {
    const detail = diagnostics.trim();
    throw new Error(`Grok Build 单次运行返回无效 JSON${detail ? `: ${detail}` : '。'}`, {
      cause: error,
    });
  }
  if (code !== 0 || parsed.error) {
    throw new Error(`Grok Build 单次运行失败：${headlessErrorDetail(
      parsed,
      diagnostics,
      code,
      signal,
    )}`);
  }
  const value = parsed.structuredOutput ?? parsed.text;
  if (value === undefined) {
    throw new Error('Grok Build 单次运行响应缺少 text 或 structuredOutput。');
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (maxOutputBytes && Buffer.byteLength(text, 'utf8') > maxOutputBytes) {
    throw new Error(`Grok Build 单次运行响应超过 ${maxOutputBytes} 字节上限。`);
  }
  return {
    text,
    inputTokens: usageNumber(parsed.usage?.input_tokens),
    outputTokens: usageNumber(parsed.usage?.output_tokens),
    contextWindowTokens: null,
    stopReason: typeof parsed.stopReason === 'string' ? parsed.stopReason : null,
  };
}

function headlessErrorDetail(
  parsed: GrokHeadlessEnvelope,
  diagnostics: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (typeof parsed.error === 'string') return parsed.error;
  if (parsed.error) return JSON.stringify(parsed.error);
  return diagnostics.trim() || `process exited with ${signal ?? code ?? 'unknown status'}`;
}

function usageNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function childResult(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForChildClose(child, STOP_TIMEOUT_MS)) return;
  child.kill('SIGKILL');
  await waitForChildClose(child, STOP_TIMEOUT_MS);
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function deleteEphemeralSession(
  binary: string,
  sessionId: string,
  host: GrokOneshotCoreHost,
): Promise<void> {
  const child = spawn(binary, ['sessions', 'delete', sessionId], {
    cwd: host.temporaryRoot,
    env: childEnvironment(host),
    stdio: 'ignore',
  });
  child.once('error', () => undefined);
  if (!await waitForChildClose(child, DELETE_TIMEOUT_MS)) await stopChild(child);
}
