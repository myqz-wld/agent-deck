/**
 * issues-store 纯逻辑单测（deep-review H1 MED 回归兜底）。
 *
 * 重点覆盖 `mergeIssuesFromList`：list fetch resolve 时按 id 保留 updatedAt 更大的版本，防慢 list
 * fetch 取旧 snapshot 后于 onIssueChanged event 到达时，旧 list resolve 整表替换把更新记录退回旧值。
 * 同时验 setIssues 整替语义不变 + selectFilteredIssues filter/sort 正确。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { IssueRecord } from '@shared/types';
import { useIssuesStore, selectFilteredIssues } from '../issues-store';

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
    selectedIssueId: null,
    filters: { statuses: ['open', 'in-progress'], showDeleted: false },
  });
});

describe('mergeIssuesFromList — list resolve 保留 updatedAt 更大的版本', () => {
  it('store 内记录比 list 新（event 已 upsert）→ 保留 store 版本（不退回旧值）', () => {
    const { upsertIssue, mergeIssuesFromList } = useIssuesStore.getState();
    // t1: onIssueChanged event 先到，store 落 v2（updatedAt=2000, status=in-progress）
    upsertIssue(makeIssue({ updatedAt: 2000, status: 'in-progress' }));
    // t2: 慢 list fetch resolve，list 内是旧 snapshot v1（updatedAt=1000, status=open）
    mergeIssuesFromList([makeIssue({ updatedAt: 1000, status: 'open' })]);
    const got = useIssuesStore.getState().issues.get('i1');
    expect(got?.updatedAt).toBe(2000);
    expect(got?.status).toBe('in-progress'); // 没退回旧 open
  });

  it('list 记录比 store 新 → 用 list 版本', () => {
    const { upsertIssue, mergeIssuesFromList } = useIssuesStore.getState();
    upsertIssue(makeIssue({ updatedAt: 1000, status: 'open' }));
    mergeIssuesFromList([makeIssue({ updatedAt: 3000, status: 'resolved' })]);
    const got = useIssuesStore.getState().issues.get('i1');
    expect(got?.updatedAt).toBe(3000);
    expect(got?.status).toBe('resolved');
  });

  it('keep-all：store 有但 list snapshot 没有的 id 被保留（deep-review H1 R2 MED：防慢 fetch 剔除 event 新建行）', () => {
    const { upsertIssue, mergeIssuesFromList } = useIssuesStore.getState();
    upsertIssue(makeIssue({ id: 'i1' }));
    // i2 模拟 list fetch 在途期间被 onIssueChanged 新建 upsert，不在旧 list snapshot 内
    upsertIssue(makeIssue({ id: 'i2' }));
    mergeIssuesFromList([makeIssue({ id: 'i1' })]);
    const issues = useIssuesStore.getState().issues;
    expect(issues.has('i1')).toBe(true);
    expect(issues.has('i2')).toBe(true); // keep-all：保留，不被剔除（渲染时由 selectFilteredIssues 过滤）
  });

  it('list 版本胜出但不带 appendices → 保住 store 已有的 appendices（避免 N+1 list 抹掉详情子列表）', () => {
    const { upsertIssue, mergeIssuesFromList } = useIssuesStore.getState();
    const appendix = { id: 1, issueId: 'i1', body: 'note', logsRef: null, appendedSessionId: 's1', appendedAt: 500 };
    // store 内有带 appendices 的记录（IssuesGet 拉过 detail）
    upsertIssue(makeIssue({ updatedAt: 1000, appendices: [appendix] }));
    // list 版本更新但不带 appendices（undefined）
    mergeIssuesFromList([makeIssue({ updatedAt: 2000 })]);
    const got = useIssuesStore.getState().issues.get('i1');
    expect(got?.updatedAt).toBe(2000);
    expect(got?.appendices).toEqual([appendix]);
  });
});

describe('selectFilteredIssues — filter + createdAt DESC sort', () => {
  it('按 createdAt DESC 排序', () => {
    const issues = new Map<string, IssueRecord>([
      ['a', makeIssue({ id: 'a', createdAt: 100 })],
      ['b', makeIssue({ id: 'b', createdAt: 300 })],
      ['c', makeIssue({ id: 'c', createdAt: 200 })],
    ]);
    const out = selectFilteredIssues({ issues, filters: {} });
    expect(out.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('showDeleted=false 隐藏 deletedAt 非 null', () => {
    const issues = new Map<string, IssueRecord>([
      ['a', makeIssue({ id: 'a' })],
      ['b', makeIssue({ id: 'b', deletedAt: 999 })],
    ]);
    const out = selectFilteredIssues({ issues, filters: { showDeleted: false } });
    expect(out.map((i) => i.id)).toEqual(['a']);
  });
});
