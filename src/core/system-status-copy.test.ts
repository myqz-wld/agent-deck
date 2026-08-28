import { describe, expect, it } from 'vitest';

import {
  completedSessionCommandText,
  failedSessionCommandText,
  normalizeSystemStatusDetail,
} from './system-status-copy';

describe('system status copy', () => {
  it('uses one command outcome pattern without decorative or terminal punctuation', () => {
    expect(completedSessionCommandText(
      'Claude',
      '/clear',
      '已开始新对话，原时间线保留。',
    )).toBe('Claude /clear 已完成，已开始新对话，原时间线保留');
    expect(failedSessionCommandText(
      'Codex',
      'compact',
      '⚠ 操作已中断。',
    )).toBe('Codex /compact 失败：操作已中断');
  });

  it('normalizes only system-row decorations and final punctuation', () => {
    expect(normalizeSystemStatusDetail('  🧭 summary. next!  ')).toBe('summary. next');
  });
});
