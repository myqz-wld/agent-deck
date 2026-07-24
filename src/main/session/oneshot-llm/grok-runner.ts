import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import {
  buildGrokChildEnv,
  buildGrokLaunchSpec,
} from '@main/adapters/grok-build/launch-child';
import { resolveGrokBinary } from '@main/adapters/grok-build/resolve-grok-binary';
import type { GrokThinkingLevel } from '@shared/session-metadata';
import { raceWithTimeout } from './race-with-timeout';

const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;
const STOP_TIMEOUT_MS = 2_000;
const DELETE_TIMEOUT_MS = 3_000;

interface GrokHeadlessEnvelope {
  /** Current Grok Build JSON headless response fields. */
  content?: unknown;
  structuredOutput?: unknown;
  error?: unknown;
  /** Compatibility with older/test response shapes. */
  text?: unknown;
  type?: unknown;
  message?: unknown;
  stopReason?: unknown;
  usage?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    contextWindowTokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  modelUsage?: unknown;
}

export interface GrokOneshotResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  contextWindowTokens: number | null;
  stopReason: string | null;
}

interface GrokTestCommand {
  binary: string;
  argsPrefix?: string[];
}

export interface RunGrokOneshotOptions {
  prompt: string;
  systemPrompt: string;
  model?: string;
  effort?: GrokThinkingLevel;
  /** Configured Grok CLI path; null/blank delegates to the login shell PATH. */
  binaryPath?: string | null;
  outputSchema?: Record<string, unknown>;
  maxOutputBytes?: number;
  timeoutMs: number;
  timeoutErrorMessage: string;
  signal?: AbortSignal;
  /** Deterministic process seam; production always resolves the configured Grok CLI. */
  testCommand?: GrokTestCommand;
  /** Test-only environment overlay for a deterministic fixture. */
  envOverride?: Readonly<Record<string, string>>;
}

export function buildGrokHeadlessArgs(input: {
  promptFile: string;
  sessionId: string;
  systemPrompt: string;
  model?: string;
  effort?: GrokThinkingLevel;
  outputSchema?: Record<string, unknown>;
}): string[] {
  return [
    '--prompt-file',
    input.promptFile,
    '--session-id',
    input.sessionId,
    '--output-format',
    'json',
    '--verbatim',
    '--tools',
    '',
    '--no-subagents',
    '--no-memory',
    '--disable-web-search',
    '--no-auto-update',
    '--no-leader',
    '--max-turns',
    '1',
    '--permission-mode',
    'dontAsk',
    '--deny',
    'Bash',
    '--deny',
    'Edit',
    '--deny',
    'Write',
    '--deny',
    'Read',
    '--deny',
    'Grep',
    '--deny',
    'WebFetch',
    '--deny',
    'MCPTool',
    '--sandbox',
    'strict',
    '--system-prompt-override',
    input.systemPrompt,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--reasoning-effort', input.effort] : []),
    ...(input.outputSchema
      ? ['--json-schema', JSON.stringify(input.outputSchema)]
      : []),
  ];
}

/**
 * Run one isolated Grok Build headless turn.
 *
 * Grok's headless surface is used instead of a visible Agent Deck session because it can enforce
 * the generator boundary directly: a strict temporary cwd, empty built-in tool allowlist, explicit
 * deny rules for executable/MCP tools, no Agent Deck MCP injection, no memory/subagents/web search,
 * and one turn. Grok does not attest its final model-visible registry, so continuation classifies
 * this boundary as hardened-unattested. The CLI still reads the user's own Grok config and
 * authentication, including custom model definitions.
 */
export async function runGrokOneshot(
  options: RunGrokOneshotOptions,
): Promise<GrokOneshotResult> {
  const isolatedCwd = mkdtempSync(join(tmpdir(), 'agent-deck-grok-oneshot-'));
  const promptFile = join(isolatedCwd, 'prompt.txt');
  const sessionId = randomUUID();
  let binary: string | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    writeFileSync(promptFile, options.prompt, { encoding: 'utf8', mode: 0o600 });
    binary =
      options.testCommand?.binary ??
      await resolveGrokBinary(options.binaryPath ?? null);
    const args = buildGrokHeadlessArgs({
      promptFile,
      sessionId,
      systemPrompt: options.systemPrompt,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    });
    const command = options.testCommand
      ? {
          command: binary,
          args: [...(options.testCommand.argsPrefix ?? []), ...args],
          dedicatedOutput: false,
        }
      : (() => {
          const spec = buildGrokLaunchSpec(binary!, args);
          return {
            command: spec.command,
            args: spec.args,
            dedicatedOutput: spec.useLoginShell,
          };
        })();

    child = spawn(command.command, command.args, {
      cwd: isolatedCwd,
      env: buildGrokChildEnv({
        GROK_DISABLE_AUTOUPDATER: '1',
        ...(options.envOverride ?? {}),
      }),
      stdio: command.dedicatedOutput
        ? ['pipe', 'pipe', 'pipe', 'pipe']
        : ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const runningChild = child;
    const work = captureHeadlessResult(runningChild, {
      outputStream: command.dedicatedOutput
        ? (runningChild.stdio[3] as Readable)
        : runningChild.stdout,
      startupStream: command.dedicatedOutput ? runningChild.stdout : null,
      maxOutputBytes: options.maxOutputBytes,
    });
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
    if (binary && child) {
      await deleteEphemeralSession(
        binary,
        sessionId,
        options.testCommand,
        options.envOverride,
      );
    }
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

async function captureHeadlessResult(
  child: ChildProcessWithoutNullStreams,
  options: {
    outputStream: Readable;
    startupStream: Readable | null;
    maxOutputBytes?: number;
  },
): Promise<GrokOneshotResult> {
  let output = '';
  let diagnostics = '';
  let outputOverflow = false;
  const appendOutput = (chunk: Buffer | string): void => {
    if (outputOverflow) return;
    output += chunk.toString();
    if (Buffer.byteLength(output, 'utf8') > OUTPUT_LIMIT_BYTES) {
      outputOverflow = true;
      child.kill('SIGTERM');
    }
  };
  const appendDiagnostics = (chunk: Buffer | string): void => {
    diagnostics = `${diagnostics}${chunk.toString()}`.slice(-DIAGNOSTIC_LIMIT_BYTES);
  };
  options.outputStream.on('data', appendOutput);
  child.stderr.on('data', appendDiagnostics);
  options.startupStream?.on('data', appendDiagnostics);

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (outputOverflow) {
    throw new Error(`Grok oneshot output exceeded ${OUTPUT_LIMIT_BYTES} bytes.`);
  }

  let parsed: GrokHeadlessEnvelope;
  try {
    parsed = JSON.parse(output.trim()) as GrokHeadlessEnvelope;
  } catch (error) {
    throw new Error(
      `Grok oneshot returned invalid JSON${diagnostics.trim() ? `: ${diagnostics.trim()}` : '.'}`,
      { cause: error },
    );
  }
  if (code !== 0 || parsed.type === 'error' || parsed.error) {
    const detail = headlessErrorDetail(parsed, diagnostics, code, signal);
    throw new Error(`Grok oneshot failed: ${detail}`);
  }

  const value =
    parsed.structuredOutput ??
    parsed.content ??
    parsed.text;
  const text =
    typeof value === 'string'
      ? value
      : value === undefined
        ? JSON.stringify(parsed)
        : JSON.stringify(value);
  if (options.maxOutputBytes && Buffer.byteLength(text, 'utf8') > options.maxOutputBytes) {
    throw new Error(`Grok oneshot response exceeded ${options.maxOutputBytes} bytes.`);
  }
  return {
    text,
    inputTokens: usageNumber(
      parsed.usage?.inputTokens ?? parsed.usage?.input_tokens,
    ),
    outputTokens: usageNumber(
      parsed.usage?.outputTokens ?? parsed.usage?.output_tokens,
    ),
    contextWindowTokens:
      usageNumber(parsed.usage?.contextWindowTokens) ??
      contextWindow(parsed.modelUsage),
    stopReason: typeof parsed.stopReason === 'string' ? parsed.stopReason : null,
  };
}

function headlessErrorDetail(
  parsed: GrokHeadlessEnvelope,
  diagnostics: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (typeof parsed.message === 'string') return parsed.message;
  if (typeof parsed.error === 'string') return parsed.error;
  if (parsed.error) return JSON.stringify(parsed.error);
  return diagnostics.trim() || `process exited with ${signal ?? code ?? 'unknown status'}`;
}

function usageNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function contextWindow(modelUsage: unknown): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const values = Object.values(modelUsage as Record<string, unknown>)
    .map((entry) =>
      entry && typeof entry === 'object'
        ? usageNumber(
            (entry as Record<string, unknown>).contextWindow ??
              (entry as Record<string, unknown>).contextWindowTokens,
          )
        : null,
    )
    .filter((entry): entry is number => entry !== null);
  return values.length ? Math.min(...values) : null;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await waitForChildClose(child, STOP_TIMEOUT_MS);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForChildClose(child, STOP_TIMEOUT_MS);
}

async function waitForChildClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
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
  testCommand?: GrokTestCommand,
  envOverride?: Readonly<Record<string, string>>,
): Promise<void> {
  const command = testCommand
    ? {
        command: binary,
        args: [...(testCommand.argsPrefix ?? []), 'sessions', 'delete', sessionId],
        dedicatedOutput: false,
      }
    : (() => {
        const spec = buildGrokLaunchSpec(binary, ['sessions', 'delete', sessionId]);
        return {
          command: spec.command,
          args: spec.args,
          dedicatedOutput: spec.useLoginShell,
        };
      })();
  const child = spawn(command.command, command.args, {
    env: buildGrokChildEnv(envOverride),
    stdio: command.dedicatedOutput
      ? ['ignore', 'ignore', 'ignore', 'ignore']
      : 'ignore',
  });
  child.once('error', () => undefined);
  const closed = await waitForChildClose(child, DELETE_TIMEOUT_MS);
  if (!closed) await stopChild(child);
}
