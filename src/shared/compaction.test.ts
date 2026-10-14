import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './types';
import { readCompaction } from './compaction';

const event = (payload: unknown, kind: AgentEvent['kind'] = 'message'): AgentEvent => ({
  sessionId: 'session', agentId: 'claude-code', kind, payload, ts: 100,
});

describe('compaction evidence', () => {
  it('recovers stored statistics without interpreting user/assistant text', () => {
    const text = 'Claude /compact 已完成\n触发：自动 · Token：967,260 → 14,639 · 耗时：111,670ms';
    const payload = { text, role: 'system', sessionCommandStatus: { command: 'compact', status: 'completed' } };
    expect(readCompaction(event(payload))).toEqual({ status: 'completed', trigger: 'auto', preTokens: 967260, postTokens: 14639, durationMs: 111670 });
    expect(readCompaction(event({ ...payload, role: 'user' }))).toBeNull();
    expect(readCompaction(event({ text, role: 'assistant' }))).toBeNull();
  });
  it('preserves zero and clearing while rejecting invalid metrics', () => {
    expect(readCompaction(event({ role: 'system', compaction: {
      id: 'native', status: 'completed', preTokens: -1, postTokens: 0, durationMs: Infinity, summary: '', error: '',
    } }))).toEqual({ id: 'native', status: 'completed', postTokens: 0, summary: '', error: '' });
    expect(readCompaction(event({ trigger: 'manual' }, 'context-compaction-end'))).toEqual({ status: 'completed', trigger: 'manual' });
  });
  it('keeps cancellation neutral and unknown states explicit', () => {
    expect(readCompaction(event({ role: 'system', text: 'Codex /compact 失败：操作已中断',
      sessionCommandStatus: { command: 'compact', status: 'failed' } })))
      .toMatchObject({ status: 'interrupted' });
    expect(readCompaction(event({ status: '_future' }, 'context-compaction-end'))?.status).toBe('unknown');
  });
});
