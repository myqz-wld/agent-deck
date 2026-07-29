// @vitest-environment happy-dom
/** The application-level bridge keeps issue entities and query membership current across views. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { IssueChangedEvent, IssueRecord } from '@shared/types';
import { useIssuesBridge } from '../use-issues-bridge';
import { useIssuesStore } from '@renderer/stores/issues-store';

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 'i1',
    title: 'T',
    description: 'D',
    repro: null,
    kind: 'follow-up',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 's1',
    cwd: null,
    branchName: null,
    logsRef: null,
    resolutionSessionId: null,
    labels: [],
    createdAt: 1000,
    updatedAt: 1000,
    resolvedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/** 捕获 useIssuesBridge 注册的 issue-changed callback + off spy。 */
let emitIssueChanged: ((e: IssueChangedEvent) => void) | null = null;
let offSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  emitIssueChanged = null;
  offSpy = vi.fn();
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
  vi.stubGlobal('window', {
    api: {
      onIssueChanged: (cb: (e: IssueChangedEvent) => void) => {
        emitIssueChanged = cb;
        return offSpy;
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useIssuesBridge — 常驻订阅生命周期', () => {
  it('mount 即订阅 onIssueChanged（callback 被注册）', () => {
    expect(emitIssueChanged).toBeNull();
    renderHook(() => useIssuesBridge());
    expect(emitIssueChanged).not.toBeNull();
  });

  it('unmount 调用 off()（不泄漏订阅）', () => {
    const { unmount } = renderHook(() => useIssuesBridge());
    expect(offSpy).not.toHaveBeenCalled();
    unmount();
    expect(offSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useIssuesBridge — 事件 → store 派发', () => {
  it('updated event 移出当前 filter 时同步回收 query entity', () => {
    const requestId = useIssuesStore.getState().beginListRequest();
    useIssuesStore.getState().mergeIssuesFromList(requestId, [makeIssue()]);
    expect(useIssuesStore.getState().issues.has('i1')).toBe(true);

    renderHook(() => useIssuesBridge());
    const resolved = makeIssue({ status: 'resolved', updatedAt: 2000 });
    act(() => {
      emitIssueChanged!({
        kind: 'updated',
        issueId: 'i1',
        issue: resolved,
        sourceSessionId: 's1',
        ts: 2000,
      });
    });
    expect(useIssuesStore.getState().issues.has('i1')).toBe(false);
    expect(useIssuesStore.getState().queryIssueIds).not.toContain('i1');
  });

  it('created event（带 issue）→ upsert 新 issue 进 store', () => {
    renderHook(() => useIssuesBridge());
    const fresh = makeIssue({ id: 'i2', title: 'new' });
    act(() => {
      emitIssueChanged!({
        kind: 'created',
        issueId: 'i2',
        issue: fresh,
        sourceSessionId: 's1',
        ts: 1000,
      });
    });
    expect(useIssuesStore.getState().issues.get('i2')?.title).toBe('new');
    expect(useIssuesStore.getState().queryIssueIds).toContain('i2');
  });

  it('hardDeleted event → 从 store 移除', () => {
    // 先放一条进 store
    useIssuesStore.getState().upsertIssue(makeIssue());
    renderHook(() => useIssuesBridge());
    expect(useIssuesStore.getState().issues.has('i1')).toBe(true);
    act(() => {
      emitIssueChanged!({
        kind: 'hardDeleted',
        issueId: 'i1',
        issue: null,
        sourceSessionId: 's1',
        ts: 3000,
      });
    });
    expect(useIssuesStore.getState().issues.has('i1')).toBe(false);
  });
});
