// @vitest-environment happy-dom
import type { ComponentProps } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import type { FileChangeSummary } from '@shared/types';
import { RemoteDiffPanel } from './RemoteDiffPanel';
import type { DiffTab } from './DiffTab';

const observed = vi.hoisted(() => ({ props: null as ComponentProps<typeof DiffTab> | null }));
vi.mock('./DiffTab', () => ({ DiffTab: (props: ComponentProps<typeof DiffTab>) => {
  observed.props = props;
  return null;
} }));
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function rows(count: number): FileChangeSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: count - i, ts: count - i, kind: 'text', sessionId: 's1', filePath: 'repo/same.ts',
    toolCallId: null, hasBeforeBlob: false, hasAfterBlob: false,
    hasBeforeSnapshot: false, hasAfterSnapshot: false,
  }));
}
afterEach(cleanup);

it.each([2, 80])('keeps Remote burst continuity and selection with an initial %i-row history', async (initial) => {
  let records = rows(initial);
  const list = vi.fn(async (cursor?: string) => {
    const remaining = cursor ? records.filter((row) => row.id < Number(cursor)) : records;
    const items = remaining.slice(0, 50);
    return { items, nextCursor: remaining.length > items.length ? String(items.at(-1)!.id) : null,
      revision: 1 };
  });
  const source = (revision: number) => ({
    identity: 'remote-a:core-a:1', selectedSessionId: 's1', dataRevision: revision,
    listFileChanges: list,
    getFileChange: vi.fn(async () => ({ change: null, revision })),
    getFileFinalDiff: vi.fn(), loadImageBlob: vi.fn(),
  }) as unknown as RemoteSessionSourceView;
  const view = render(<RemoteDiffPanel source={source(1)} />);
  await act(flush);
  act(() => observed.props!.onSelectChange(initial - 1));
  records = rows(initial + 51);
  view.rerender(<RemoteDiffPanel source={source(2)} />);
  await act(flush);
  expect(observed.props!.hasMore).toBe(true);
  expect(observed.props!.selectedChangeId).toBe(initial - 1);
  for (let page = 0; page < 5 && observed.props!.hasMore; page++) {
    await act(async () => { observed.props!.onLoadMore(); await flush(); });
  }
  expect(observed.props!.changes?.map((row) => row.id)).toEqual(records.map((row) => row.id));
  expect(observed.props!.hasMore).toBe(false);
  expect(observed.props!.selectedChangeId).toBe(initial - 1);
  view.rerender(<RemoteDiffPanel source={{ ...source(3), identity: 'remote-b:core-b:1' }} />);
  await act(flush);
  expect(observed.props!.selectedChangeId).toBe(initial + 51);
  expect(observed.props!.loadedCount).toBe(50);
});
