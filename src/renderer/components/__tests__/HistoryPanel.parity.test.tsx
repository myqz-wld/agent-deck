// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionRecord } from '@shared/types';
import { LocalHistorySummaryCard } from '../LocalHistorySummaryCard';
import { RemoteSessionSummaryCard } from '../RemoteSessionSummaryCard';
import { legacyRemoteSessionPresentation } from '@renderer/remote-host/session-summary-presentation';

afterEach(cleanup);

const localSession: SessionRecord = {
  id: 'local-a',
  agentId: 'codex-cli',
  cwd: '/workspace/project',
  title: 'History row',
  source: 'sdk',
  lifecycle: 'closed',
  activity: 'finished',
  startedAt: 1,
  lastEventAt: 2,
  endedAt: 2,
  archivedAt: null,
  model: null,
  thinking: null,
};

describe('Local and Remote History presentation parity', () => {
  it('uses the same card frame, header and metadata structure', () => {
    const local = render(<LocalHistorySummaryCard
      session={localSession}
      onSelect={vi.fn()}
      onArchive={vi.fn(async () => undefined)}
      onUnarchive={vi.fn(async () => undefined)}
      onDelete={vi.fn(async () => undefined)}
    />);
    const localFrame = local.container.querySelector('[data-session-card-frame="true"]')!;
    const localHeader = local.container.querySelector('[data-session-card-header="true"]')!;
    expect(screen.getByText('模型 默认')).toBeTruthy();
    expect(screen.getByText('思考 默认')).toBeTruthy();
    expect(screen.getByText('上下文 暂无数据')).toBeTruthy();
    const localFrameClass = localFrame.className;
    const localHeaderClass = localHeader.className;
    local.unmount();

    const remote = render(<RemoteSessionSummaryCard
      session={legacyRemoteSessionPresentation({
        id: 'remote-a',
        adapterId: 'codex-cli',
        title: 'History row',
        status: 'closed-finished',
        createdAt: 1,
        updatedAt: 2,
      })}
      onSelect={vi.fn()}
    />);
    expect(remote.container.querySelector('[data-session-card-frame="true"]')!.className)
      .toBe(localFrameClass);
    expect(remote.container.querySelector('[data-session-card-header="true"]')!.className)
      .toBe(localHeaderClass);
    expect(screen.getByText('模型 默认')).toBeTruthy();
    expect(screen.getByText('思考 默认')).toBeTruthy();
    expect(screen.getByText('上下文 暂无数据')).toBeTruthy();
  });

  it('keeps Local-only archive actions in the card menu', () => {
    const archive = vi.fn(async () => undefined);
    render(<LocalHistorySummaryCard
      session={localSession}
      onSelect={vi.fn()}
      onArchive={archive}
      onUnarchive={vi.fn(async () => undefined)}
      onDelete={vi.fn(async () => undefined)}
    />);

    fireEvent.click(screen.getByRole('button', { name: '历史会话操作' }));
    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(archive).toHaveBeenCalledOnce();
  });
});
