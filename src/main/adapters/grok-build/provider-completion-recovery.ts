import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import log from '@main/utils/logger';
import type { AgentEvent } from '@shared/types';

import {
  GROK_EXTENSION_UPDATE_METHOD,
  grokExtensionTimestampMs,
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
  completion: GrokExtensionNotification;
  promptId: string;
  stopReason: string;
}

export type GrokTurnOutcome<T> =
  | { kind: 'response'; response: T; journalTurn: RecoveredGrokTurn | null }
  | { kind: 'recovered'; turn: RecoveredGrokTurn };

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
  const assistantAlreadyObserved = runtime.translation.assistantObservedForCurrentTurn;
  for (const event of flushGrokTextUpdates(
    runtime.applicationSessionId,
    runtime.translation,
  )) options.emit(event);
  if (!assistantAlreadyObserved) {
    options.emitEvent(runtime.applicationSessionId, 'message', {
      text: turn.assistantText,
      role: 'assistant',
      recoveredFrom: 'grok-native-history',
    });
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
  timer: ReturnType<typeof setTimeout> | null;
  turnId: string;
}

/**
 * Current Grok builds persist provider completion before ACP always resolves the matching prompt.
 * Race the normal response with that durable terminal, but recover only when the same native turn
 * contains assistant text. This never replays the user prompt or places a deadline on long turns.
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

  async run<T>(runtime: GrokRuntime, request: () => Promise<T>): Promise<GrokTurnOutcome<T>> {
    this.clear(runtime);
    const turnId = runtime.translation.currentTurnUsageId;
    const startedAt = runtime.translation.currentTurnStartedAt;
    const nativeSessionId = runtime.nativeSessionId;
    if (!turnId || startedAt === null || !nativeSessionId) {
      return {
        kind: 'response',
        response: await request(),
        journalTurn: null,
      };
    }

    const active: ActiveRecovery = { timer: null, turnId };
    this.active.set(runtime, active);
    const recovered = new Promise<GrokTurnOutcome<T>>((resolve) => {
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
            resolve({ kind: 'recovered', turn });
            return;
          }
        } catch {
          // Native history is a best-effort recovery channel; normal ACP remains authoritative.
        }
        if (!this.isActive(runtime, active)) return;
        active.timer = setTimeout(() => void poll(), this.pollMs);
        active.timer.unref?.();
      };
      active.timer = setTimeout(() => void poll(), this.pollMs);
      active.timer.unref?.();
    });

    try {
      return await Promise.race([
        request().then(async (response) => {
          let journalTurn: RecoveredGrokTurn | null = null;
          try {
            // Grok 0.2.114 returns usage=null from session/prompt and persists its exact
            // turn_completed usage only in updates.jsonl. Reconcile it even when ACP completes
            // normally; the journal is the provider's sole source for reasoning/cache dimensions.
            journalTurn = await this.readCompletedTurn({
              root: this.root,
              cwd: runtime.cwd,
              nativeSessionId,
              startedAt,
            });
          } catch {
            // The normal ACP response remains sufficient for lifecycle and text delivery.
          }
          return { kind: 'response', response, journalTurn } as const;
        }),
        recovered,
      ]);
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
      && runtime.running
      && !runtime.closed
      && runtime.translation.currentTurnUsageId === active.turnId;
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
  const tail = await readTail(file, HISTORY_TAIL_BYTES);
  const completion = findCompletion(tail, options.startedAt);
  if (!completion) return null;

  const contents = await readTail(file, HISTORY_COMPLETED_TURN_BYTES);
  const assistantText = assistantTextForPrompt(contents, completion.promptId);
  return assistantText ? { ...completion, assistantText } : null;
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
  startedAt: number,
): Omit<RecoveredGrokTurn, 'assistantText'> | null {
  for (const line of contents.split(/\r?\n/)) {
    const envelope = parseEnvelope(line);
    if (!envelope || envelope.method !== GROK_EXTENSION_UPDATE_METHOD) continue;
    const completion = parseGrokExtensionNotification(envelope.params);
    if (completion.update?.sessionUpdate !== 'turn_completed') continue;
    const completedAt = grokExtensionTimestampMs(completion, 0);
    if (completedAt < startedAt) continue;
    const promptId = notificationPromptId(completion);
    if (!promptId) continue;
    const stopReason = typeof completion.update.stop_reason === 'string'
      ? completion.update.stop_reason
      : 'end_turn';
    return { completion, promptId, stopReason };
  }
  return null;
}

function assistantTextForPrompt(contents: string, promptId: string): string {
  const chunks: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const envelope = parseEnvelope(line);
    if (!envelope || envelope.method !== 'session/update') continue;
    const params = envelope.params;
    if (params._meta?.promptId !== promptId) continue;
    const update = isRecord(params.update) ? params.update : null;
    const content = update && isRecord(update.content) ? update.content : null;
    if (
      update?.sessionUpdate === 'agent_message_chunk'
      && content?.type === 'text'
      && typeof content.text === 'string'
    ) chunks.push(content.text);
  }
  return chunks.join('');
}

function parseEnvelope(line: string): {
  method: string;
  params: Record<string, unknown> & {
    _meta?: { promptId?: string };
  };
} | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || typeof value.method !== 'string' || !isRecord(value.params)) {
      return null;
    }
    return value as {
      method: string;
      params: Record<string, unknown> & { _meta?: { promptId?: string } };
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
