// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteHostSessionPresentationDto } from '@shared/remote-host';
import type { SessionRecord } from '@shared/types';
import { LocalHistorySummaryCard } from '../LocalHistorySummaryCard';
import { RemoteSessionSummaryCard } from '../RemoteSessionSummaryCard';

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

const remoteSession: RemoteHostSessionPresentationDto = {
  id: 'remote-a', adapterId: 'codex-cli', title: 'History row', source: 'sdk',
  lifecycle: 'closed', activity: 'finished', archived: true, pinned: false,
  createdAt: 1, updatedAt: 2, endedAt: 2, model: null, thinking: null,
  runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0, teams: [],
  summary: null, summaryGenerationSource: null, workspaceLabel: null, contextOnly: false,
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
      history
      session={remoteSession}
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

  it('opens history actions by right click at the pointer position', () => {
    const archive = vi.fn(async () => undefined);
    render(<LocalHistorySummaryCard
      session={localSession}
      onSelect={vi.fn()}
      onArchive={archive}
      onUnarchive={vi.fn(async () => undefined)}
      onDelete={vi.fn(async () => undefined)}
    />);

    expect(screen.queryByRole('button', { name: '历史会话操作' })).toBeNull();
    fireEvent.contextMenu(screen.getByText('History row'), { clientX: 120, clientY: 80 });
    const menu = screen.getByRole('menu', { name: '会话操作' });
    expect(menu.style.left).toBe('120px');
    expect(menu.style.top).toBe('80px');
    fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
    expect(archive).toHaveBeenCalledOnce();
  });
});
