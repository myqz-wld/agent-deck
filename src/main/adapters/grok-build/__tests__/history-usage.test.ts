import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';

const harness = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  const emits: Array<{ name: string; payload: unknown }> = [];
  return {
    rows,
    emits,
    sessionRepo: {
      findByCliSessionId: vi.fn(),
      get: vi.fn(),
    },
    tokenUsageRepo: {
      insert: vi.fn((input: { messageId: string | null } & Record<string, unknown>) => {
        const key = input.messageId ?? `null-${harness.rows.size}`;
        const previous = harness.rows.get(key);
        if (!previous) {
          harness.rows.set(key, { ...input });
          return;
        }
        for (const field of [
          'totalTokens',
          'inputTokens',
          'outputTokens',
          'reasoningTokens',
          'cacheReadTokens',
          'cacheCreationTokens',
        ]) {
          const incoming = input[field];
          if (typeof incoming !== 'number') continue;
          const stored = previous[field];
          previous[field] =
            typeof stored === 'number' ? Math.max(stored, incoming) : incoming;
        }
      }),
    },
    eventBus: {
      emit: vi.fn((name: string, payload: unknown) => emits.push({ name, payload })),
    },
  };
});

vi.mock('@main/store/session-repo', () => ({ sessionRepo: harness.sessionRepo }));
vi.mock('@main/store/token-usage-repo', () => ({ tokenUsageRepo: harness.tokenUsageRepo }));
vi.mock('@main/event-bus', () => ({ eventBus: harness.eventBus }));

import {
  backfillGrokHistoryTokenUsage,
  ensureGrokHistoryTokenUsage,
} from '../history-usage';

describe('Grok history token usage backfill', () => {
  let root = '';

  beforeEach(async () => {
    harness.rows.clear();
    harness.emits.length = 0;
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'agent-deck-grok-history-'));
    const record = {
      id: 'app-session-1',
      agentId: 'grok-build',
      cliSessionId: 'native-1',
      model: null,
    } as unknown as SessionRecord;
    harness.sessionRepo.findByCliSessionId.mockImplementation((id: string) =>
      id === 'native-1' ? record : null,
    );
    harness.sessionRepo.get.mockReturnValue(null);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('imports turn_completed usage, maps model fallback, and remains idempotent', async () => {
    const updatesDir = join(root, 'encoded-cwd', 'native-1');
    await mkdir(updatesDir, { recursive: true });
    await writeFile(
      join(updatesDir, 'updates.jsonl'),
      [
        JSON.stringify({
          timestamp: 1_700_000_000,
          method: '_x.ai/session/update',
          params: {
            sessionId: 'native-1',
            update: {
              sessionUpdate: 'turn_completed',
              prompt_id: 'prompt-1',
              usage: {
                inputTokens: 10,
                outputTokens: 4,
                totalTokens: 14,
                cachedReadTokens: 2,
                cachedWriteTokens: 3,
                modelUsage: { 'claude-fable-5': {} },
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_001,
          method: '_x.ai/session/update',
          params: {
            sessionId: 'native-1',
            update: {
              sessionUpdate: 'usage_update',
              used: 100,
              size: 200,
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_002,
          method: '_x.ai/session/update',
          params: {
            sessionId: 'native-1',
            update: {
              sessionUpdate: 'turn_completed',
              prompt_id: 'prompt-1',
              usage: { inputTokens: 999, outputTokens: 999 },
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_003,
          method: '_x.ai/session/update',
          params: {
            sessionId: 'native-1',
            update: {
              sessionUpdate: 'turn_completed',
              prompt_id: 'prompt-2',
              usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 },
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_004,
          method: '_x.ai/session/update',
          params: {
            sessionId: 'native-1',
            update: {
              sessionUpdate: 'turn_completed',
              prompt_id: 'prompt-3',
              usage: { totalTokens: 77 },
            },
          },
        }),
      ].join('\n'),
    );

    const first = await backfillGrokHistoryTokenUsage({ root, now: () => 1_800_000_000_000 });
    const second = await backfillGrokHistoryTokenUsage({ root, now: () => 1_800_000_000_000 });

    expect(first).toMatchObject({ files: 1, matchedSessions: 1, imported: 4 });
    expect(second).toMatchObject({ files: 1, matchedSessions: 1, imported: 4 });
    expect(harness.rows.size).toBe(3);
    expect(harness.rows.get('prompt-1')).toMatchObject({
      model: 'claude-fable-5',
      totalTokens: 14,
      inputTokens: 999,
      outputTokens: 999,
      cacheCreationTokens: 3,
      ts: 1_700_000_000_000,
    });
    expect(harness.rows.get('prompt-2')).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      reasoningTokens: 1,
    });
    expect(harness.rows.get('prompt-3')).toMatchObject({
      totalTokens: 77,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(harness.emits).toHaveLength(2);
    expect(harness.emits[0]).toMatchObject({
      name: 'token-usage-changed',
      payload: { sessionId: 'app-session-1' },
    });
  });

  it('rescans after a completed ensure call so later Grok turns are not missed', async () => {
    const updatesDir = join(root, 'encoded-cwd', 'native-1');
    await mkdir(updatesDir, { recursive: true });
    const updatesFile = join(updatesDir, 'updates.jsonl');
    const completion = (promptId: string, inputTokens: number) => JSON.stringify({
      method: '_x.ai/session/update',
      params: {
        sessionId: 'native-1',
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: promptId,
          usage: { inputTokens, outputTokens: 1 },
        },
      },
    });
    await writeFile(updatesFile, completion('prompt-first', 10));

    await ensureGrokHistoryTokenUsage({ root });
    await writeFile(
      updatesFile,
      [completion('prompt-first', 10), completion('prompt-later', 20)].join('\n'),
    );
    await ensureGrokHistoryTokenUsage({ root });

    expect(harness.rows.has('prompt-first')).toBe(true);
    expect(harness.rows.get('prompt-later')).toMatchObject({
      inputTokens: 20,
      outputTokens: 1,
    });
  });
});
