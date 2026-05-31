/**
 * issue-detail-editing 纯逻辑单测（本批 deep-review HIGH-A/HIGH-B/Round2-HIGH/Round3-MED 回归兜底）。
 *
 * 覆盖统一模型（详 issue-detail-editing.ts 头注）：
 * - `buildUpdatePatch(editing, issue, expectedIssueId)`：只提交 editing vs **最新服务器值 issue**
 *   归一化不等的字段 + expectedIssueId 守护
 * - `rebaseEditingState(prev, prevBaseline, latest)`：baseline 推进到 latest；editing 无草稿字段
 *   同步最新、有草稿字段保留
 * - `fieldEquals` / `parseLabels`：归一化比较
 *
 * 关键回归叉乘格子（本地草稿 × 并发外部改动）：
 * - HIGH-B：用户没碰 status、外部改 resolved → 不回滚
 * - Round2-HIGH：碰过 status 又改回原值、外部改 resolved → 不回滚
 * - Round3-MED：冲突字段（改 in-progress）外部改 resolved 后用户改回 open → 提交 open（UI=DB 一致，不 stale no-op）
 * - HIGH-A：expectedIssueId !== issue.id → 返空 patch
 */
import { describe, expect, it } from 'vitest';
import type { IssueRecord } from '@shared/types';
import {
  toEditing,
  parseLabels,
  fieldEquals,
  hasDraft,
  buildUpdatePatch,
  rebaseEditingState,
} from '../issue-detail-editing';

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 'issue-1',
    title: 'T',
    description: 'D',
    repro: null,
    kind: 'follow-up',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 'sess-1',
    cwd: null,
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

describe('parseLabels / fieldEquals — 归一化比较', () => {
  it('parseLabels split/trim/filter 空', () => {
    expect(parseLabels('a, b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(parseLabels('')).toEqual([]);
  });

  it('fieldEquals labels：「a,b」与「a, b」归一化等价', () => {
    const a = { ...toEditing(makeIssue()), labels: 'a,b' };
    const b = { ...toEditing(makeIssue()), labels: 'a, b' };
    expect(fieldEquals('labels', a, b)).toBe(true);
  });

  it('fieldEquals status：不同值不等', () => {
    const a = { ...toEditing(makeIssue()), status: 'open' as const };
    const b = { ...toEditing(makeIssue()), status: 'resolved' as const };
    expect(fieldEquals('status', a, b)).toBe(false);
  });
});

describe('hasDraft — editing 相对 baseline 有无草稿', () => {
  it('全等 → 无草稿', () => {
    const e = toEditing(makeIssue());
    expect(hasDraft(e, e)).toBe(false);
  });
  it('某字段不同 → 有草稿', () => {
    const base = toEditing(makeIssue());
    const e = { ...base, title: 'edited' };
    expect(hasDraft(e, base)).toBe(true);
  });
  it('labels 仅空格差异 → 归一化无草稿', () => {
    const base = { ...toEditing(makeIssue()), labels: 'a, b' };
    const e = { ...base, labels: 'a,b' };
    expect(hasDraft(e, base)).toBe(false);
  });
});

describe('buildUpdatePatch — 只提交 editing vs 最新服务器值 issue 不等的字段', () => {
  it('editing===issue（无改动）→ 空 patch', () => {
    const issue = makeIssue();
    expect(buildUpdatePatch(toEditing(issue), issue, issue.id)).toEqual({});
  });

  it('普通：用户改 title → patch 仅 title', () => {
    const issue = makeIssue();
    const editing = { ...toEditing(issue), title: 'user edited' };
    expect(buildUpdatePatch(editing, issue, issue.id)).toEqual({ title: 'user edited' });
  });

  it('HIGH-B：editing 已同步最新（rebase 后 editing.status===issue.status）→ 不提交 status', () => {
    // rebase 后无草稿字段 editing 同步 latest，故 editing.status === issue.status
    const issue = makeIssue({ status: 'resolved' });
    const editing = { ...toEditing(issue), title: 'only title changed' };
    const patch = buildUpdatePatch(editing, issue, issue.id);
    expect(patch).toEqual({ title: 'only title changed' });
    expect(patch.status).toBeUndefined();
  });

  it('Round3-MED：冲突字段改回 open，但 issue 当前 resolved → 提交 open（UI=DB 一致，不 stale no-op）', () => {
    // 用户把已被外部改成 resolved 的 status 改回 open → editing.status(open) !== issue.status(resolved)
    const issue = makeIssue({ status: 'resolved' });
    const editing = { ...toEditing(issue), status: 'open' as const };
    expect(buildUpdatePatch(editing, issue, issue.id)).toEqual({ status: 'open' });
  });

  it('labels 归一化等价（"a,b" vs issue ["a","b"]）→ 不提交', () => {
    const issue = makeIssue({ labels: ['a', 'b'] });
    const editing = { ...toEditing(issue), labels: 'a,b' };
    expect(buildUpdatePatch(editing, issue, issue.id)).toEqual({});
  });

  it('labels 真改动 → 提交归一化数组', () => {
    const issue = makeIssue({ labels: ['a'] });
    const editing = { ...toEditing(issue), labels: 'a, b, c' };
    expect(buildUpdatePatch(editing, issue, issue.id)).toEqual({ labels: ['a', 'b', 'c'] });
  });

  it('repro 改空串 → 提交 null', () => {
    const issue = makeIssue({ repro: 'old' });
    const editing = { ...toEditing(issue), repro: '' };
    expect(buildUpdatePatch(editing, issue, issue.id)).toEqual({ repro: null });
  });

  it('HIGH-A 第二道防线：expectedIssueId !== issue.id → 返空 patch（即便有改动）', () => {
    const issueB = makeIssue({ id: 'B', title: 'B' });
    const editing = { ...toEditing(issueB), title: 'draft from A' };
    expect(buildUpdatePatch(editing, issueB, 'A')).toEqual({});
  });

  it('多字段改动 → 全提交', () => {
    const issue = makeIssue();
    const editing = {
      ...toEditing(issue),
      title: 'new',
      status: 'in-progress' as const,
      severity: 'high' as const,
    };
    expect(buildUpdatePatch(editing, issue, issue.id)).toEqual({
      title: 'new',
      status: 'in-progress',
      severity: 'high',
    });
  });
});

describe('rebaseEditingState — baseline 推进 latest；editing 无草稿同步、有草稿保留', () => {
  it('prev/baseline 任一 null（首次 seed）→ editing+baseline 都用 canonical', () => {
    const issue = makeIssue({ title: 'X', status: 'in-progress' });
    const canonical = toEditing(issue);
    expect(rebaseEditingState(null, null, issue)).toEqual({ editing: canonical, baseline: canonical });
  });

  it('无草稿（editing===baseline）→ editing+baseline 全字段同步最新', () => {
    const baseline = toEditing(makeIssue({ status: 'open', title: 'old' }));
    const editing = { ...baseline };
    const latest = makeIssue({ status: 'resolved', title: 'new' });
    const next = rebaseEditingState(editing, baseline, latest);
    expect(next.editing).toEqual(toEditing(latest));
    expect(next.baseline).toEqual(toEditing(latest));
  });

  it('baseline 始终推进 latest（即使有草稿字段，baseline 也全 = canonical）', () => {
    const baseline = toEditing(makeIssue({ status: 'open', title: 'orig' }));
    const editing = { ...baseline, title: 'user draft' }; // title 有草稿
    const latest = makeIssue({ status: 'resolved', title: 'server new' });
    const next = rebaseEditingState(editing, baseline, latest);
    // baseline 全字段 = latest canonical（不保留旧锚点 —— 修 Round3-MED 根因）
    expect(next.baseline).toEqual(toEditing(latest));
    // editing：title 有草稿保留，status 无草稿同步
    expect(next.editing.title).toBe('user draft');
    expect(next.editing.status).toBe('resolved');
  });

  it('HIGH-B 端到端：改 title + 外部 resolved → rebase 后 save 只发 title 不回滚 status', () => {
    const baseline = toEditing(makeIssue({ status: 'open', title: 'orig' }));
    const editing = { ...baseline, title: 'user draft' };
    const latest = makeIssue({ status: 'resolved', title: 'orig' });
    const next = rebaseEditingState(editing, baseline, latest);
    const patch = buildUpdatePatch(next.editing, latest, latest.id);
    expect(patch).toEqual({ title: 'user draft' });
    expect(patch.status).toBeUndefined();
  });

  it('Round2-HIGH 端到端：碰过 status 又改回原值 + 外部 resolved → 不回滚', () => {
    // editing.status 改回 open === baseline.status open → 无草稿 → rebase 同步 resolved
    const baseline = toEditing(makeIssue({ status: 'open' }));
    const editing = { ...baseline, status: 'open' as const };
    const latest = makeIssue({ status: 'resolved' });
    const next = rebaseEditingState(editing, baseline, latest);
    expect(next.editing.status).toBe('resolved');
    const patch = buildUpdatePatch(next.editing, latest, latest.id);
    expect(patch).toEqual({});
  });

  it('Round3-MED 端到端：改 in-progress（草稿）+ 外部 resolved → rebase 保留 in-progress；用户再改回 open → save 提交 open', () => {
    const baseline = toEditing(makeIssue({ status: 'open' }));
    const editing = { ...baseline, status: 'in-progress' as const }; // 草稿
    const latest = makeIssue({ status: 'resolved' });
    const next = rebaseEditingState(editing, baseline, latest);
    // 有草稿 → editing 保留 in-progress；baseline 推进 resolved
    expect(next.editing.status).toBe('in-progress');
    expect(next.baseline.status).toBe('resolved');
    // 用户把下拉改回 open
    const afterUserEdit = { ...next.editing, status: 'open' as const };
    // save：editing.status(open) !== latest.status(resolved) → 提交 open（不 stale no-op）
    const patch = buildUpdatePatch(afterUserEdit, latest, latest.id);
    expect(patch).toEqual({ status: 'open' });
  });

  it('撞同值：用户改 in-progress + 外部也改 in-progress → editing 保留 in-progress，save no-op（合理）', () => {
    const baseline = toEditing(makeIssue({ status: 'open' }));
    const editing = { ...baseline, status: 'in-progress' as const };
    const latest = makeIssue({ status: 'in-progress' });
    const next = rebaseEditingState(editing, baseline, latest);
    expect(next.editing.status).toBe('in-progress');
    // editing.status === latest.status → 不提交（用户想要的值已是服务器值）
    expect(buildUpdatePatch(next.editing, latest, latest.id)).toEqual({});
  });

  it('labels 草稿（仅空格差异）→ 视为无草稿 → 同步最新', () => {
    const baseline = { ...toEditing(makeIssue({ labels: ['a', 'b'] })) }; // "a, b"
    const editing = { ...baseline, labels: 'a,b' }; // 归一化等价 → 无草稿
    const latest = makeIssue({ labels: ['a', 'b', 'c'] });
    const next = rebaseEditingState(editing, baseline, latest);
    expect(next.editing.labels).toBe('a, b, c');
  });
});
