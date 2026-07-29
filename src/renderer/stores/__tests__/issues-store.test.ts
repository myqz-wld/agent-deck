/**
 * issues-store 纯逻辑单测（deep-review H1 MED 回归兜底）。
 *
 * Query membership is bounded independently from the authoritative entities needed by the
 * selected detail and by events that race an in-flight list snapshot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { IssueRecord } from '@shared/types';
import {
  MAX_ISSUE_QUERY_DIRTY,
  useIssuesStore,
  selectFilteredIssues,
} from '../issues-store';

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

// store 是全局单例 — 每个 test 前重置到初值。
beforeEach(() => {
  useIssuesStore.setState({
    issues: new Map(),
    queryIssueIds: [],
    selectedIssueId: null,
    filters: { statuses: ['open', 'in-progress'], showDeleted: false },
    queryLimit: 500,
    filterVersion: 0,
    activeListRequest: null,
    listRequestSerial: 0,
  });
});

function commitList(records: IssueRecord[], limit = 500): string {
  const requestId = useIssuesStore.getState().beginListRequest(limit);
  return useIssuesStore.getState().mergeIssuesFromList(requestId, records);
}

describe('issue query membership — list/event reconciliation', () => {
  it('store 内记录比 list 新（event 已 upsert）→ 保留 store 版本（不退回旧值）', () => {
    const requestId = useIssuesStore.getState().beginListRequest(500);
    const { upsertIssue, mergeIssuesFromList } = useIssuesStore.getState();
    upsertIssue(makeIssue({ updatedAt: 2000, status: 'in-progress' }));
    expect(mergeIssuesFromList(
      requestId,
      [makeIssue({ updatedAt: 1000, status: 'open' })],
    )).toBe('applied');
    const got = useIssuesStore.getState().issues.get('i1');
    expect(got?.updatedAt).toBe(2000);
    expect(got?.status).toBe('in-progress');
  });

  it('同毫秒 event 在请求期间到达时胜过旧 list snapshot', () => {
    const requestId = useIssuesStore.getState().beginListRequest(500);
    useIssuesStore.getState().upsertIssue(makeIssue({
      updatedAt: 2000,
      status: 'in-progress',
      title: 'event-new',
    }));
    expect(useIssuesStore.getState().mergeIssuesFromList(requestId, [
      makeIssue({ updatedAt: 2000, status: 'open', title: 'list-old' }),
    ])).toBe('applied');

    const got = useIssuesStore.getState().issues.get('i1');
    expect(got?.title).toBe('event-new');
    expect(got?.status).toBe('in-progress');
  });

  it('乱序旧 event 不回退当前 entity 或 membership', () => {
    commitList([makeIssue({
      updatedAt: 3000,
      status: 'in-progress',
      title: 'current',
    })]);
    useIssuesStore.getState().upsertIssue(makeIssue({
      updatedAt: 2000,
      status: 'resolved',
      title: 'stale',
    }));

    expect(useIssuesStore.getState().issues.get('i1')?.title).toBe('current');
    expect(useIssuesStore.getState().queryIssueIds).toEqual(['i1']);
  });

  it('请求期间新建且匹配 filter 的 event 即使不在 snapshot 也进入 membership', () => {
    const requestId = useIssuesStore.getState().beginListRequest(500);
    useIssuesStore.getState().upsertIssue(makeIssue({
      id: 'event-created',
      createdAt: 4000,
      updatedAt: 4000,
    }));
    useIssuesStore.getState().mergeIssuesFromList(requestId, [makeIssue({ id: 'listed' })]);

    expect(useIssuesStore.getState().queryIssueIds).toEqual(['event-created', 'listed']);
    expect(selectFilteredIssues(useIssuesStore.getState()).map((issue) => issue.id))
      .toEqual(['event-created', 'listed']);
  });

  it('event 移出当前 filter 时旧 snapshot 不能把它重新加入 membership', () => {
    const requestId = useIssuesStore.getState().beginListRequest(500);
    useIssuesStore.getState().upsertIssue(makeIssue({
      updatedAt: 2000,
      status: 'resolved',
    }));
    useIssuesStore.getState().mergeIssuesFromList(
      requestId,
      [makeIssue({ updatedAt: 1000, status: 'open' })],
    );

    expect(useIssuesStore.getState().queryIssueIds).toEqual([]);
    expect(useIssuesStore.getState().issues.has('i1')).toBe(false);
  });

  it('list 记录比未标 dirty 的 store 记录新 → 用 list 版本', () => {
    useIssuesStore.setState({
      issues: new Map([['i1', makeIssue({ updatedAt: 1000, status: 'open' })]]),
      queryIssueIds: ['i1'],
    });
    commitList([makeIssue({ updatedAt: 3000, status: 'resolved' })]);
    expect(useIssuesStore.getState().issues.has('i1')).toBe(false);

    useIssuesStore.getState().setFilters({ statuses: ['resolved'] });
    commitList([makeIssue({ updatedAt: 3000, status: 'resolved' })]);
    expect(useIssuesStore.getState().issues.get('i1')?.updatedAt).toBe(3000);
  });

  it('list 版本胜出但不带 appendices → 保住 selected entity 已加载的 appendices', () => {
    const appendix = { id: 1, issueId: 'i1', body: 'note', logsRef: null, appendedSessionId: 's1', appendedAt: 500 };
    useIssuesStore.setState({
      issues: new Map([['i1', makeIssue({ updatedAt: 1000, appendices: [appendix] })]]),
      queryIssueIds: ['i1'],
      selectedIssueId: 'i1',
    });
    commitList([makeIssue({ updatedAt: 2000 })]);
    const got = useIssuesStore.getState().issues.get('i1');
    expect(got?.updatedAt).toBe(2000);
    expect(got?.appendices).toEqual([appendix]);
  });

  it('snapshot 外旧 entity 会回收，但 selected entity 保留到 deselect', () => {
    useIssuesStore.setState({
      issues: new Map([
        ['listed', makeIssue({ id: 'listed' })],
        ['selected', makeIssue({ id: 'selected' })],
        ['stale', makeIssue({ id: 'stale' })],
      ]),
      queryIssueIds: ['listed', 'selected', 'stale'],
      selectedIssueId: 'selected',
    });

    commitList([makeIssue({ id: 'listed' })]);
    expect([...useIssuesStore.getState().issues.keys()].sort()).toEqual(['listed', 'selected']);
    expect(useIssuesStore.getState().queryIssueIds).toEqual(['listed']);

    useIssuesStore.getState().selectIssue(null);
    expect([...useIssuesStore.getState().issues.keys()]).toEqual(['listed']);
  });

  it('membership 永远不超过 query limit，entity 只额外 pin selected/dirty', () => {
    const listed = Array.from({ length: 700 }, (_, index) => makeIssue({
      id: `listed-${index}`,
      createdAt: index,
      updatedAt: index,
    }));
    expect(commitList(listed, 500)).toBe('applied');
    expect(useIssuesStore.getState().queryIssueIds).toHaveLength(500);
    expect(useIssuesStore.getState().issues.size).toBe(500);

    for (let index = 0; index < 20; index += 1) {
      useIssuesStore.getState().upsertIssue(makeIssue({
        id: `event-${index}`,
        createdAt: 10_000 + index,
        updatedAt: 10_000 + index,
      }));
    }
    expect(useIssuesStore.getState().queryIssueIds).toHaveLength(500);
    expect(useIssuesStore.getState().issues.size).toBe(500);
  });

  it('过多 request-dirty events 使 snapshot 失效并要求一次 retry，缓存仍有界', () => {
    const requestId = useIssuesStore.getState().beginListRequest(2);
    for (let index = 0; index <= MAX_ISSUE_QUERY_DIRTY; index += 1) {
      useIssuesStore.getState().upsertIssue(makeIssue({
        id: `event-${index}`,
        createdAt: index,
        updatedAt: index,
      }));
    }

    expect(useIssuesStore.getState().mergeIssuesFromList(
      requestId,
      [makeIssue({ id: 'stale-snapshot' })],
    )).toBe('retry');
    expect(useIssuesStore.getState().queryIssueIds.length).toBeLessThanOrEqual(2);
    expect(useIssuesStore.getState().issues.size).toBeLessThanOrEqual(2);
  });

  it('stale/cancelled request 不能覆盖较新的 membership', () => {
    const first = useIssuesStore.getState().beginListRequest(500);
    const second = useIssuesStore.getState().beginListRequest(500);
    expect(useIssuesStore.getState().mergeIssuesFromList(
      first,
      [makeIssue({ id: 'stale' })],
    )).toBe('stale');
    expect(useIssuesStore.getState().mergeIssuesFromList(
      second,
      [makeIssue({ id: 'current' })],
    )).toBe('applied');
    expect(useIssuesStore.getState().queryIssueIds).toEqual(['current']);

    const third = useIssuesStore.getState().beginListRequest(500);
    useIssuesStore.getState().upsertIssue(makeIssue({ id: 'event-after-third' }));
    useIssuesStore.getState().cancelListRequest(third);
    expect(useIssuesStore.getState().activeListRequest).toBeNull();
    expect(useIssuesStore.getState().queryIssueIds).toContain('event-after-third');
  });
});

describe('selectFilteredIssues — filter + createdAt DESC sort', () => {
  it('按 createdAt DESC 排序', () => {
    const issues = new Map<string, IssueRecord>([
      ['a', makeIssue({ id: 'a', createdAt: 100 })],
      ['b', makeIssue({ id: 'b', createdAt: 300 })],
      ['c', makeIssue({ id: 'c', createdAt: 200 })],
    ]);
    const out = selectFilteredIssues({
      issues,
      queryIssueIds: ['a', 'b', 'c'],
      filters: {},
    });
    expect(out.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('showDeleted=false 隐藏 deletedAt 非 null', () => {
    const issues = new Map<string, IssueRecord>([
      ['a', makeIssue({ id: 'a' })],
      ['b', makeIssue({ id: 'b', deletedAt: 999 })],
    ]);
    const out = selectFilteredIssues({
      issues,
      queryIssueIds: ['a', 'b'],
      filters: { showDeleted: false },
    });
    expect(out.map((i) => i.id)).toEqual(['a']);
  });
});
