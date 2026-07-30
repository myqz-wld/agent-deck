import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readCompletedGrokNativeTurn } from '../provider-completion-recovery';

describe('Grok provider completion history', () => {
  it('reads the exact rate-limit envelope emitted by Grok 0.2.114', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-provider-completion-'));
    const cwd = '/Users/example';
    const nativeSessionId = '019fb234-a509-74c0-92df-10a9156114b4';
    const historyDir = join(root, encodeURIComponent(cwd), nativeSessionId);
    await mkdir(historyDir, { recursive: true });
    const startedAt = Date.now();
    const completedAt = startedAt + 4_000;
    await writeFile(join(historyDir, 'updates.jsonl'), [
      JSON.stringify({
        timestamp: Math.floor(startedAt / 1_000),
        method: '_x.ai/session/update',
        params: {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'retry_state',
            type: 'exhausted',
            is_rate_limited: true,
          },
          _meta: { agentTimestampMs: completedAt - 1 },
        },
      }),
      JSON.stringify({
        timestamp: Math.floor(completedAt / 1_000),
        method: '_x.ai/session/update',
        params: {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'provider-rate-limit',
            stop_reason: 'rate_limit',
          },
          _meta: { agentTimestampMs: completedAt },
        },
      }),
    ].join('\n'));

    try {
      await expect(readCompletedGrokNativeTurn({
        root,
        cwd,
        nativeSessionId,
        startedAt,
      })).resolves.toMatchObject({
        promptId: 'provider-rate-limit',
        stopReason: 'rate_limit',
        assistantText: '',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats history that has not been created yet as an incomplete turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-provider-missing-'));
    try {
      await expect(readCompletedGrokNativeTurn({
        root,
        cwd: '/repo',
        nativeSessionId: 'native-session',
        startedAt: Date.now(),
      })).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
