// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { registerBuiltinDiffRenderers } from '../diff/install';
import { RemoteDiffPanel } from './RemoteDiffPanel';

registerBuiltinDiffRenderers();
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CHANGE = {
  id: 3,
  sessionId: 'session-a',
  filePath: 'repo/src/index.ts',
  kind: 'text' as const,
  toolCallId: null,
  hasBeforeBlob: true,
  hasAfterBlob: true,
  hasBeforeSnapshot: false,
  hasAfterSnapshot: false,
  ts: 11,
};
const LATER_CHANGE = { ...CHANGE, id: 4, ts: 12 };

function source(dataRevision = 1, changes = [CHANGE], nextCursor: string | null = null) {
  const listFileChanges = vi.fn(async (_cursor?: string) => ({
    items: changes, nextCursor, revision: dataRevision,
  }));
  const getFileChange = vi.fn(async (changeId: number) => ({
    change: {
      ...(changes.find((change) => change.id === changeId) ?? CHANGE),
      beforeBlob: 'old',
      afterBlob: 'new',
      beforeSnapshot: null,
      afterSnapshot: null,
      metadata: {},
    },
    revision: dataRevision,
  }));
  const getFileFinalDiff = vi.fn(async (filePath: string) => ({
    fileDiff: {
      ok: true as const,
      filePath,
      diff: '@@ -1 +1 @@\n-old\n+new',
      source: 'recorded-snapshot' as const,
    },
    revision: dataRevision,
  }));
  return {
    value: {
      dataRevision,
      identity: 'remote-a:core-a:1',
      selectedSessionId: 'session-a',
      listFileChanges,
      getFileChange,
      getFileFinalDiff,
      loadImageBlob: vi.fn(),
    } as unknown as RemoteSessionSourceView,
    getFileFinalDiff,
    getFileChange,
    listFileChanges,
  };
}

describe('RemoteDiffPanel', () => {
  it('does not reload a selected payload for an equivalent fresh source view', async () => {
    const first = source();
    const view = render(<RemoteDiffPanel source={first.value} />);
    await waitFor(() => expect(first.getFileChange).toHaveBeenCalledOnce());

    const fresh = source();
    view.rerender(<RemoteDiffPanel source={fresh.value} />);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(first.listFileChanges).toHaveBeenCalledOnce();
    expect(fresh.listFileChanges).not.toHaveBeenCalled();
    expect(first.getFileChange).toHaveBeenCalledOnce();
    expect(fresh.getFileChange).not.toHaveBeenCalled();
  });

  it('refreshes summaries and relevant payloads when the same source revision advances', async () => {
    const first = source(1);
    const view = render(<RemoteDiffPanel source={first.value} />);
    await waitFor(() => expect(first.getFileChange).toHaveBeenCalledWith(3));
    fireEvent.click(screen.getByRole('button', { name: '最终 diff' }));
    await waitFor(() => expect(first.getFileFinalDiff).toHaveBeenCalledWith(CHANGE.filePath));

    const revised = source(2, [LATER_CHANGE, CHANGE], 'cursor-new');
    view.rerender(<RemoteDiffPanel source={revised.value} />);

    await waitFor(() => expect(revised.listFileChanges).toHaveBeenCalledOnce());
    await waitFor(() => expect(revised.getFileChange).toHaveBeenCalledWith(4));
    await waitFor(() => expect(revised.getFileFinalDiff).toHaveBeenCalledWith(CHANGE.filePath));
    fireEvent.click(screen.getByRole('button', { name: '加载更早改动' }));
    await waitFor(() => expect(revised.listFileChanges).toHaveBeenCalledWith('cursor-new'));
  });

  it('releases pagination busy when a revision refresh supersedes a slow page', async () => {
    let resolvePage!: (page: {
      items: typeof CHANGE[];
      nextCursor: string | null;
      revision: number;
    }) => void;
    const pendingPage = new Promise<{
      items: typeof CHANGE[];
      nextCursor: string | null;
      revision: number;
    }>((resolve) => { resolvePage = resolve; });
    const first = source(1, [CHANGE], 'cursor-old');
    first.listFileChanges.mockImplementation(async (cursor?: string) => cursor
      ? pendingPage
      : { items: [CHANGE], nextCursor: 'cursor-old', revision: 1 });
    const view = render(<RemoteDiffPanel source={first.value} />);

    const loadMore = await screen.findByRole('button', { name: '加载更早改动' });
    fireEvent.click(loadMore);
    await waitFor(() => expect(first.listFileChanges).toHaveBeenCalledWith('cursor-old'));
    expect((screen.getByRole('button', { name: '加载中…' }) as HTMLButtonElement).disabled)
      .toBe(true);

    const revised = source(2, [LATER_CHANGE, CHANGE], 'cursor-new');
    view.rerender(<RemoteDiffPanel source={revised.value} />);
    await waitFor(() => expect(revised.listFileChanges).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByRole(
      'button', { name: '加载更早改动' },
    ) as HTMLButtonElement).disabled).toBe(false));

    resolvePage({ items: [CHANGE], nextCursor: null, revision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((screen.getByRole(
      'button', { name: '加载更早改动' },
    ) as HTMLButtonElement).disabled).toBe(false);
  });
});
