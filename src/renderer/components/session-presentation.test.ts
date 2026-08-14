import { describe, expect, it } from 'vitest';

import { agentIdLabel, lifecycleLabel, relativeTime } from './session-presentation';

describe('session presentation labels', () => {
  it.each([
    ['claude-code', 'Claude Code'],
    ['codex-cli', 'Codex CLI'],
    ['grok-build', 'Grok Build'],
  ])('maps %s to %s', (agentId, expected) => {
    expect(agentIdLabel(agentId)).toBe(expected);
  });

  it('preserves unknown adapter ids and missing values', () => {
    expect(agentIdLabel('custom-adapter')).toBe('custom-adapter');
    expect(agentIdLabel(null)).toBe('未知');
    expect(lifecycleLabel(undefined)).toBe('?');
  });

  it('formats lifecycle values', () => {
    expect(lifecycleLabel('active')).toBe('进行中');
    expect(lifecycleLabel('dormant')).toBe('已休眠');
    expect(lifecycleLabel('closed')).toBe('已结束');
  });

  it('rejects non-finite times and formats bounded elapsed times', () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(Number.NaN, now)).toBe('');
    expect(relativeTime(Number.POSITIVE_INFINITY, now)).toBe('');
    expect(relativeTime(now - 2_000, now)).toBe('刚刚');
    expect(relativeTime(now - 3 * 60_000, now)).toBe('3 分钟前');
    expect(relativeTime(now + 100_000, now)).toBe('刚刚');
  });
});
