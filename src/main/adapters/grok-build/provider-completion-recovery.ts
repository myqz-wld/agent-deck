import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import log from '@main/utils/logger';
import type { AgentEvent } from '@shared/types';

import {
  grokExtensionTimestampMs,
  isGrokExtensionUpdateMethod,
  notificationPromptId,
  parseGrokExtensionNotification,
  type GrokExtensionNotification,
} from './extension';
import type { GrokRuntime } from './runtime-types';
import {
  clearGrokTurnLiveRate,
  completeGrokTurnLiveRate,
  flushGrokTextUpdates,
  translateGrokTurnUsage,
} from './translate';

const logger = log.scope('grok-provider-completion');
const HISTORY_TAIL_BYTES = 128 * 1024;
const HISTORY_COMPLETED_TURN_BYTES = 8 * 1024 * 1024;
export const DEFAULT_GROK_PROVIDER_COMPLETION_POLL_MS = 1_500;

export interface RecoveredGrokTurn {
  assistantText: string;
  agentResult: string | null;
  completion: GrokExtensionNotification;
  promptId: string;
  stopReason: string;
}

export type GrokProviderCompletionOutcome<T> =
  | { kind: 'live'; value: T }
  | { kind: 'native-history'; turn: RecoveredGrokTurn };

export interface GrokProviderCompletionRecoveryOptions {
  root?: string;
  pollMs?: number;
  readCompletedTurn?: typeof readCompletedGrokNativeTurn;
}

export function applyRecoveredGrokTurn(
  runtime: GrokRuntime,
  turn: RecoveredGrokTurn,
  options: {
    emit: (event: AgentEvent) => void;
    emitEvent: (sessionId: string, kind: AgentEvent['kind'], payload: unknown) => void;
  },
): void {
  for (const event of flushGrokTextUpdates(
    runtime.applicationSessionId,
    runtime.translation,
  )) options.emit(event);

  const missingText = missingRecoveredAssistantText(
    runtime.translation.currentAssistantText,
    turn.assistantText,
  );
  if (missingText) {
    options.emitEvent(runtime.applicationSessionId, 'message', {
      text: missingText,
      role: 'assistant',
      recoveredFrom: 'grok-native-history',
    });
  } else if (!runtime.translation.assistantObservedForCurrentTurn) {
    const terminalText = recoveredTerminalText(turn);
    if (terminalText) {
      options.emitEvent(runtime.applicationSessionId, 'message', {
        text: terminalText,
        role: 'assistant',
        error: true,
        recoveredFrom: 'grok-native-history',
      });
    }
  }

  const usageEvent = translateGrokTurnUsage(
    runtime.applicationSessionId,
    runtime.model,
    turn.completion,
    runtime.translation,
  );
  if (usageEvent) {
    options.emit(usageEvent);
    const payload = usageEvent.payload as { outputTokens?: unknown };
    completeGrokTurnLiveRate(
      runtime.translation,
      typeof payload.outputTokens === 'number' ? payload.outputTokens : 0,
    );
  }
  clearGrokTurnLiveRate(runtime.translation);
  options.emitEvent(runtime.applicationSessionId, 'finished', {
    ok: turn.stopReason === 'end_turn',
    subtype: turn.stopReason,
    recoveredFrom: 'grok-native-history',
  });
}

interface ActiveRecovery {
  readErrorLogged: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Grok durably appends the completed turn before its ACP response is guaranteed to reach Electron.
 * Keep live ACP authoritative, but race it with the exact native session/turn terminal so a lost
 * stream cannot strand an already-finished answer.
 */
export class GrokProviderCompletionRecovery {
  private readonly active = new WeakMap<GrokRuntime, ActiveRecovery>();
  private readonly pollMs: number;
  private readonly root: string;
  private readonly readCompletedTurn: typeof readCompletedGrokNativeTurn;

  constructor(options: GrokProviderCompletionRecoveryOptions = {}) {
    this.pollMs = options.pollMs ?? DEFAULT_GROK_PROVIDER_COMPLETION_POLL_MS;
    this.root = options.root ?? join(homedir(), '.grok', 'sessions');
    this.readCompletedTurn = options.readCompletedTurn ?? readCompletedGrokNativeTurn;
  }

  async run<T>(
    runtime: GrokRuntime,
    request: () => Promise<T>,
  ): Promise<GrokProviderCompletionOutcome<T>> {
    this.clear(runtime);
    const turnId = runtime.translation.currentTurnUsageId;
    const startedAt = runtime.translation.currentTurnStartedAt;
    const nativeSessionId = runtime.nativeSessionId;
    if (!turnId || startedAt === null || !nativeSessionId) {
      return { kind: 'live', value: await request() };
    }

    const active: ActiveRecovery = { readErrorLogged: false, timer: null };
    this.active.set(runtime, active);
    const recovered = new Promise<GrokProviderCompletionOutcome<T>>((resolve) => {
      const poll = async (): Promise<void> => {
        if (!this.isActive(runtime, active)) return;
        try {
          const turn = await this.readCompletedTurn({
            root: this.root,
            cwd: runtime.cwd,
            nativeSessionId,
            startedAt,
          });
          if (!this.isActive(runtime, active)) return;
          if (turn) {
            logger.warn('[grok-provider-completion] recovered completed native turn', {
              event: 'grok_provider_completion_recovery',
              sessionId: runtime.applicationSessionId,
              nativeSessionId,
              promptId: turn.promptId,
              stopReason: turn.stopReason,
            });
            resolve({ kind: 'native-history', turn });
            return;
          }
        } catch (error) {
          if (!active.readErrorLogged) {
            active.readErrorLogged = true;
            logger.warn('[grok-provider-completion] native history read failed', {
              event: 'grok_provider_completion_read_failed',
              sessionId: runtime.applicationSessionId,
              nativeSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!this.isActive(runtime, active)) return;
        active.timer = setTimeout(() => void poll(), this.pollMs);
        active.timer.unref?.();
      };
      void poll();
    });

    try {
      const live = Promise.resolve()
        .then(request)
        .then((value) => ({ kind: 'live' as const, value }));
      return await Promise.race([live, recovered]);
    } finally {
      this.clear(runtime);
    }
  }

  clear(runtime: GrokRuntime): void {
    const active = this.active.get(runtime);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    this.active.delete(runtime);
  }

  private isActive(runtime: GrokRuntime, active: ActiveRecovery): boolean {
    return this.active.get(runtime) === active
      && !runtime.closed;
  }
}

export async function readCompletedGrokNativeTurn(options: {
  root: string;
  cwd: string;
  nativeSessionId: string;
  startedAt: number;
}): Promise<RecoveredGrokTurn | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(options.nativeSessionId)) return null;
  const file = join(
    options.root,
    encodeURIComponent(options.cwd),
    options.nativeSessionId,
    'updates.jsonl',
  );
  let tail: string;
  try {
    tail = await readTail(file, HISTORY_TAIL_BYTES);
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
  const completion = findCompletion(
    tail,
    options.nativeSessionId,
    options.startedAt,
  );
  if (!completion) return null;

  const contents = await readTail(file, HISTORY_COMPLETED_TURN_BYTES);
  const assistantText = assistantTextForPrompt(contents, completion.promptId);
  return { ...completion, assistantText };
}

async function readTail(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    const text = buffer.toString('utf8');
    return stats.size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

function findCompletion(
  contents: string,
  nativeSessionId: string,
  startedAt: number,
): Omit<RecoveredGrokTurn, 'assistantText'> | null {
  for (const line of contents.split(/\r?\n/)) {
    const envelope = parseEnvelope(line);
    if (!envelope || !isGrokExtensionUpdateMethod(envelope.method)) continue;
    const completion = parseGrokExtensionNotification(envelope.params);
    if (
      completion.sessionId !== nativeSessionId
      || completion.update?.sessionUpdate !== 'turn_completed'
    ) continue;
    const completedAt = grokExtensionTimestampMs(completion, 0);
    if (completedAt < startedAt) continue;
    const promptId = notificationPromptId(completion);
    if (!promptId) continue;
    const stopReason = nonEmptyString(completion.update.stop_reason) ?? 'end_turn';
    const agentResult =
      nonEmptyString(completion.update.agent_result)
      ?? nonEmptyString(completion.update.agentResult);
    return { agentResult, completion, promptId, stopReason };
  }
  return null;
}

function assistantTextForPrompt(contents: string, promptId: string): string {
  const chunks: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const envelope = parseEnvelope(line);
    if (!envelope || envelope.method !== 'session/update') continue;
    const params = envelope.params;
    const update = isRecord(params.update) ? params.update : null;
    if (
      promptIdFromEnvelope(params, update) !== promptId
      || update?.sessionUpdate !== 'agent_message_chunk'
    ) continue;
    const content = isRecord(update.content) ? update.content : null;
    if (content?.type === 'text' && typeof content.text === 'string') {
      chunks.push(content.text);
    }
  }
  return chunks.join('');
}

function promptIdFromEnvelope(
  params: Record<string, unknown>,
  update: Record<string, unknown> | null,
): string | null {
  const paramsMeta = isRecord(params._meta) ? params._meta : null;
  const updateMeta = update && isRecord(update._meta) ? update._meta : null;
  return nonEmptyString(paramsMeta?.promptId) ?? nonEmptyString(updateMeta?.promptId);
}

function parseEnvelope(line: string): {
  method: string;
  params: Record<string, unknown>;
} | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || typeof value.method !== 'string' || !isRecord(value.params)) {
      return null;
    }
    return { method: value.method, params: value.params };
  } catch {
    return null;
  }
}

function missingRecoveredAssistantText(observed: string, recovered: string): string {
  if (!recovered) return '';
  if (!observed) return recovered;
  if (recovered.startsWith(observed)) return recovered.slice(observed.length);
  if (observed.includes(recovered)) return '';
  const maxOverlap = Math.min(observed.length, recovered.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (observed.endsWith(recovered.slice(0, size))) return recovered.slice(size);
  }
  return recovered;
}

function recoveredTerminalText(turn: RecoveredGrokTurn): string | null {
  if (turn.agentResult) return turn.agentResult;
  return turn.stopReason === 'rate_limit'
    ? 'Grok Build 请求触发速率限制，请稍后重试。'
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
