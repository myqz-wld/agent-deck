// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionContextUsageChip } from '../SessionContextUsageChip';

afterEach(cleanup);

describe('SessionContextUsageChip', () => {
  it('shows current usage, window size, percentage, and exact values', () => {
    render(
      <SessionContextUsageChip
        usage={{
          usedTokens: 34_567,
          windowTokens: 272_000,
          updatedAt: 1,
          runtimeIdentity: null,
        }}
      />,
    );
    const chip = screen.getByLabelText('上下文窗口用量');
    expect(chip.textContent).toBe('上下文 34.6K / 272K · 12.7%');
    expect(chip.title).toContain('34,567 token / 272,000 token');
  });

  it('marks post-compaction usage as updating while retaining the window size', () => {
    render(
      <SessionContextUsageChip
        usage={{
          usedTokens: null,
          windowTokens: 200_000,
          updatedAt: 2,
          runtimeIdentity: null,
        }}
      />,
    );
    const chip = screen.getByLabelText('上下文窗口用量');
    expect(chip.textContent).toBe('上下文 更新中 / 200K');
    expect(chip.title).toContain('上下文已压缩');
  });

  it('keeps an explicit placeholder before a provider reports telemetry', () => {
    render(<SessionContextUsageChip usage={null} />);
    expect(screen.getByLabelText('上下文窗口用量').textContent).toBe(
      '上下文 暂无数据',
    );
  });
});
