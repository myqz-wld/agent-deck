// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContextSnapshotChip, SessionContextUsageChip } from '../SessionContextUsageChip';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('SessionContextUsageChip', () => {
  const currentIdentity = {
    version: 1 as const,
    runtimeKey: 'codex:openai:gpt-current:default',
    adapter: 'codex-cli' as const,
    runtimeProvider: 'openai',
    model: 'gpt-current',
    capacityConfigFingerprint: 'default',
  };

  it('shows current usage, window size, percentage, and exact values', () => {
    render(
      <SessionContextUsageChip
        session={{
          id: 'session-a',
          agentId: 'codex-cli',
          contextUsage: {
            usedTokens: 34_567,
            windowTokens: 272_000,
            updatedAt: 1,
            runtimeIdentity: currentIdentity,
          },
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
        session={{
          id: 'session-a',
          agentId: 'codex-cli',
          contextUsage: {
            usedTokens: null,
            windowTokens: 200_000,
            updatedAt: 2,
            runtimeIdentity: currentIdentity,
          },
        }}
      />,
    );
    const chip = screen.getByLabelText('上下文窗口用量');
    expect(chip.textContent).toBe('上下文 更新中 / 200K');
    expect(chip.title).toContain('上下文已压缩');
  });

  it('reserves space and reveals missing telemetry only at 150 ms', () => {
    vi.useFakeTimers();
    render(
      <SessionContextUsageChip
        session={{ id: 'session-a', agentId: 'codex-cli', contextUsage: null }}
      />,
    );
    expect(screen.queryByLabelText('上下文窗口用量')).toBeNull();
    expect(screen.getByText('上下文 暂无数据').className).toContain('invisible');
    act(() => vi.advanceTimersByTime(149));
    expect(screen.queryByLabelText('上下文窗口用量')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByLabelText('上下文窗口用量').textContent).toBe(
      '上下文 暂无数据',
    );
  });


  it('commits fast telemetry immediately and cancels its fallback timer', () => {
    vi.useFakeTimers();
    const session = { id: 'session-a', agentId: 'codex-cli', contextUsage: null };
    const view = render(<SessionContextUsageChip session={session} />);
    act(() => vi.advanceTimersByTime(80));
    const contextUsage = { usedTokens: 1000, windowTokens: 200000, updatedAt: 1,
      runtimeIdentity: currentIdentity };
    view.rerender(<SessionContextUsageChip session={{ ...session, contextUsage }} />);
    expect(screen.getByLabelText('上下文窗口用量').textContent).toContain('1K / 200K');
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByLabelText('上下文窗口用量').textContent).toContain('1K / 200K');
    view.rerender(<SessionContextUsageChip session={{ ...session,
      contextUsage: { ...contextUsage, usedTokens: 2000 } }} />);
    expect(screen.getByLabelText('上下文窗口用量').textContent).toContain('2K / 200K');
  });

  it.each(['id', 'model', 'runtimeProvider'] as const)(
    'resets grace on %s changes without retaining another runtime snapshot', (field) => {
      vi.useFakeTimers();
      const session = { id: 'session-a', agentId: 'codex-cli', model: 'model-a',
        runtimeProvider: 'gateway-a', contextUsage: null };
      const view = render(<SessionContextUsageChip session={session} />);
      act(() => vi.advanceTimersByTime(150));
      expect(screen.getByLabelText('上下文窗口用量')).toBeTruthy();
      view.rerender(<SessionContextUsageChip session={{ ...session, [field]: 'replacement' }} />);
      expect(screen.queryByLabelText('上下文窗口用量')).toBeNull();
      act(() => vi.advanceTimersByTime(149));
      expect(screen.queryByLabelText('上下文窗口用量')).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByLabelText('上下文窗口用量').textContent).toBe('上下文 暂无数据');
    },
  );

  it('drops old usage immediately when switching to a session without telemetry', () => {
    const view = render(<SessionContextUsageChip session={{ id: 'session-a', agentId: 'codex-cli',
      contextUsage: { usedTokens: 1000, windowTokens: 200000, updatedAt: 1,
        runtimeIdentity: currentIdentity } }} />);
    view.rerender(<SessionContextUsageChip session={{ id: 'session-b', agentId: 'codex-cli',
      contextUsage: null }} />);
    expect(screen.queryByLabelText('上下文窗口用量')).toBeNull();
    expect(screen.queryByText(/1K \/ 200K/)).toBeNull();
  });

  it('applies the same initial grace to remote summary snapshots', () => {
    vi.useFakeTimers();
    const view = render(<SessionContextSnapshotChip context={null} identity="remote-a" />);
    act(() => vi.advanceTimersByTime(149));
    expect(screen.queryByLabelText('上下文窗口用量')).toBeNull();
    view.rerender(<SessionContextSnapshotChip context={{ usedTokens: 1000, windowTokens: 200000 }}
      identity="remote-a" />);
    expect(screen.getByLabelText('上下文窗口用量').textContent).toContain('1K / 200K');
    view.rerender(<SessionContextSnapshotChip context={null} identity="remote-b" />);
    expect(screen.queryByLabelText('上下文窗口用量')).toBeNull();
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByLabelText('上下文窗口用量').textContent).toBe('上下文 暂无数据');
  });

  it.each([
    ['unattributed', null],
    [
      'another adapter',
      { ...currentIdentity, adapter: 'claude-code' as const, runtimeKey: 'claude:other' },
    ],
  ])('does not display a %s snapshot as current usage', (_label, runtimeIdentity) => {
    render(
      <SessionContextUsageChip
        session={{
          id: 'session-a',
          agentId: 'codex-cli',
          contextUsage: {
            usedTokens: 34_567,
            windowTokens: 272_000,
            updatedAt: 3,
            runtimeIdentity,
          },
        }}
      />,
    );
    const chip = screen.getByLabelText('上下文窗口用量');
    expect(chip.textContent).toBe('上下文 旧快照');
    expect(chip.title).toContain('未显示');
  });
});
