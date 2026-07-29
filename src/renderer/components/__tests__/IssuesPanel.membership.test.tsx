// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueRecord } from '@shared/types';
import { useIssuesStore } from '@renderer/stores/issues-store';
import { IssuesPanel } from '../IssuesPanel';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 'issue-1',
    title: 'Issue',
    description: 'Description',
    repro: null,
    kind: 'follow-up',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 'session-source',
    cwd: null,
    branchName: null,
    logsRef: null,
    resolutionSessionId: null,
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    resolvedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  useIssuesStore.setState({
    issues: new Map(),
    queryIssueIds: [],
    selectedIssueId: null,
    filters: { statuses: ['open', 'in-progress'], showDeleted: false },
    queryLimit: 500,
    filterVersion: 0,
    listRequestSerial: 0,
    activeListRequest: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('IssuesPanel bounded query membership', () => {
  it('keeps an event update that races a same-millisecond list snapshot', async () => {
    const pending = deferred<IssueRecord[]>();
    const issuesList = vi.fn(() => pending.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { issuesList } as unknown as Window['api'],
    });

    render(<IssuesPanel />);
    await waitFor(() => expect(issuesList).toHaveBeenCalledTimes(1));

    act(() => {
      useIssuesStore.getState().upsertIssue(issue({
        title: 'Event wins',
        status: 'in-progress',
        updatedAt: 2,
      }));
    });
    expect(screen.getByText('Event wins')).toBeTruthy();

    await act(async () => {
      pending.resolve([issue({ title: 'Stale list', updatedAt: 2 })]);
      await pending.promise;
    });

    await waitFor(() => expect(screen.getByText('Event wins')).toBeTruthy());
    expect(screen.queryByText('Stale list')).toBeNull();
    expect(useIssuesStore.getState().queryIssueIds).toEqual(['issue-1']);
  });

  it('ignores an older filter request after the current request commits', async () => {
    const activeRequest = deferred<IssueRecord[]>();
    const resolvedRequest = deferred<IssueRecord[]>();
    const issuesList = vi.fn()
      .mockImplementationOnce(() => activeRequest.promise)
      .mockImplementationOnce(() => resolvedRequest.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { issuesList } as unknown as Window['api'],
    });

    render(<IssuesPanel />);
    await waitFor(() => expect(issuesList).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '已解决' }));
    await waitFor(() => expect(issuesList).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolvedRequest.resolve([issue({
        id: 'resolved-current',
        title: 'Resolved current',
        status: 'resolved',
        updatedAt: 3,
      })]);
      await resolvedRequest.promise;
    });
    expect(await screen.findByText('Resolved current')).toBeTruthy();

    await act(async () => {
      activeRequest.resolve([issue({ id: 'active-stale', title: 'Active stale' })]);
      await activeRequest.promise;
    });
    expect(screen.queryByText('Active stale')).toBeNull();
    expect(useIssuesStore.getState().queryIssueIds).toEqual(['resolved-current']);
  });
});
