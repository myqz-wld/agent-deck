// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, FileChangePage, FileChangePayload } from '@shared/types';
import { DiffTab } from '../DiffTab';
import { useFileChanges } from '../use-file-changes';

const api = {
  listFileChangePage: vi.fn(),
  getFileChange: vi.fn(),
  onAgentEvent: vi.fn(),
};

function summary(id: number, ts = id) {
  return {
    id,
    sessionId: 's1',
    filePath: `/repo/${id}.ts`,
    kind: 'text',
    toolCallId: null,
    hasBeforeBlob: false,
    hasAfterBlob: false,
    hasBeforeSnapshot: false,
    hasAfterSnapshot: false,
    ts,
  };
}

function payload(id: number): FileChangePayload {
  return {
    ...summary(id),
    beforeBlob: 'before',
    afterBlob: 'after',
    beforeSnapshot: 'before',
    afterSnapshot: 'after',
    metadata: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useFileChanges paging and request fencing', () => {
  let eventListener: ((event: AgentEvent) => void) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    eventListener = null;
    api.onAgentEvent.mockImplementation((listener: (event: AgentEvent) => void) => {
      eventListener = listener;
      return vi.fn();
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api,
    });
  });

  afterEach(() => cleanup());

  it('loads one summary page, appends load-more, and incrementally merges refreshes', async () => {
    api.listFileChangePage
      .mockResolvedValueOnce({
        items: [summary(3), summary(2)],
        nextCursor: 'older',
      } satisfies FileChangePage)
      .mockResolvedValueOnce({
        items: [summary(1)],
        nextCursor: null,
      } satisfies FileChangePage)
      .mockResolvedValueOnce({
        items: [summary(4), summary(3)],
        nextCursor: 'refresh-tail',
      } satisfies FileChangePage);

    const { result } = renderHook(() =>
      useFileChanges({ sessionId: 's1', enabled: true, selectedChangeId: null }),
    );
    await waitFor(() => expect(result.current.changes?.map((item) => item.id)).toEqual([3, 2]));

    await act(async () => result.current.loadMore());
    expect(result.current.changes?.map((item) => item.id)).toEqual([3, 2, 1]);

    await act(async () => {
      eventListener?.({
        sessionId: 's1',
        agentId: 'codex-cli',
        kind: 'file-changed',
        payload: {},
        ts: 10,
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(result.current.changes?.map((item) => item.id)).toEqual([4, 3, 2, 1]);
    expect(api.listFileChangePage.mock.calls[2]).toEqual(['s1', { limit: 50 }]);
  });

  it('discards a stale selected-payload completion after selection changes', async () => {
    const first = deferred<FileChangePayload | null>();
    const second = deferred<FileChangePayload | null>();
    api.listFileChangePage.mockResolvedValue({
      items: [summary(2), summary(1)],
      nextCursor: null,
    } satisfies FileChangePage);
    api.getFileChange.mockImplementation((_sessionId: string, id: number) =>
      id === 1 ? first.promise : second.promise,
    );

    const { result, rerender } = renderHook(
      ({ selectedChangeId }: { selectedChangeId: number | null }) =>
        useFileChanges({ sessionId: 's1', enabled: true, selectedChangeId }),
      { initialProps: { selectedChangeId: 1 } },
    );
    rerender({ selectedChangeId: 2 });

    await act(async () => second.resolve(payload(2)));
    await waitFor(() => expect(result.current.selectedPayload?.id).toBe(2));
    await act(async () => first.resolve(payload(1)));

    expect(result.current.selectedPayload?.id).toBe(2);
  });

  it('retries an initial page failure without toggling the diff tab', async () => {
    api.listFileChangePage
      .mockRejectedValueOnce(new Error('raw transport failure'))
      .mockResolvedValueOnce({
        items: [summary(1)],
        nextCursor: null,
      } satisfies FileChangePage);

    const { result } = renderHook(() =>
      useFileChanges({ sessionId: 's1', enabled: true, selectedChangeId: null }),
    );
    await waitFor(() => expect(result.current.error).toBe('无法加载文件改动。'));

    await act(async () => result.current.retry());

    expect(result.current.error).toBeNull();
    expect(result.current.changes?.map((item) => item.id)).toEqual([1]);
  });

  it('shows a fixed-copy retry action for the initial diff load error', () => {
    const retry = vi.fn();
    render(
      <DiffTab
        sessionId="s1"
        changes={null}
        diffError="无法加载文件改动。"
        hasMore={false}
        loadingMore={false}
        payloadLoading={false}
        payloadError={null}
        fileGroups={[]}
        selectedFilePath={null}
        selectedGroup={null}
        selectedChangeId={null}
        diffMode="single"
        finalDiffLoading={false}
        finalDiff={null}
        diffPayload={null}
        finalDiffPayload={null}
        onSelectFile={vi.fn()}
        onSelectChange={vi.fn()}
        onDiffModeChange={vi.fn()}
        onLoadMore={vi.fn()}
        onRetry={retry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText(/raw transport failure/)).toBeNull();
  });
});
