/**
 * IssueDetail 编辑缓冲（editing buffer）纯逻辑（抽离自 IssueDetail.tsx）。
 *
 * 抽离原因（与 session-list-tree.ts 同款约定）：
 * 1. IssueDetail.tsx 含 JSX，vitest node env 不能直接 import（撞 React 依赖）
 * 2. 这些纯函数无 React 依赖，抽到 .ts 让单测直接 import（覆盖 dirty 判定 / rebase 这两条最易错、
 *    且本批 deep-review HIGH-A/HIGH-B/Round2-HIGH 所在的核心逻辑）
 * 3. IssueDetail.tsx 状态机变薄，只负责 React state 编排
 *
 * **核心模型（editing + baseline 双锚点）**：组件持 `editing`（用户缓冲）+ `baseline`（= 最新已知
 * 服务器值快照，每次 rebase 推进到 latest）。两者分工：
 * - **提交判定（buildUpdatePatch）**：比较 `editing[k]` 与**当前最新 issue**（服务器值）—— editing
 *   偏离服务器当前值才提交。**不**用 editing vs baseline（旧 v1 闸门，会让「冲突字段改回旧值」
 *   stale no-op → UI-DB 分叉，Round3-MED 根因）。
 * - **草稿判定（rebaseEditingState 内）**：比较 `editing[k]` 与 `baseline[k]`（rebase 前那刻的服务器
 *   值）—— 决定外部更新到来时该字段是同步最新（无草稿）还是保留用户输入（有草稿）。
 *
 * 为何不用「dirtyFields: Set 记录触碰过的字段」（Round 2 reviewer-codex HIGH 根因）：
 * 用户点 status 下拉 open→in-progress→改回 open，「触碰历史」会永久把 status 标 dirty，外部把
 * status 改 resolved 时 rebase 保留旧 open、save 又提交 open → 回滚。baseline 模型下 editing.status
 * === baseline.status（都 open）→ 非草稿 → rebase 正常同步 resolved，不回滚。
 *
 * 三/四类 HIGH/MED 的根治分工：
 * - **HIGH-A（跨 issue 污染）**：父组件 `key={selectedIssueId}` 强制 per-issue remount（fresh
 *   state）为主；`buildUpdatePatch` 的 `expectedIssueId` 守护为第二道防线（issueId 不匹配返空 patch）。
 * - **HIGH-B（外部改字段、用户没碰）+ Round2-HIGH（碰过又改回原值）**：rebase 把无草稿字段 editing
 *   同步到最新 → editing===issue → buildUpdatePatch 不提交（不回滚）。
 * - **Round3-MED（冲突字段改回旧值 stale no-op）**：提交判定用 editing vs 最新 issue（非旧 baseline）
 *   → 用户把已被外部改成 resolved 的字段改回 open 时 editing(open)!==issue(resolved) → 提交 open。
 */

import type { IssueRecord, IssueSeverity, IssueStatus } from '@shared/types';

export type EditingState = {
  title: string;
  description: string;
  repro: string;
  kind: string;
  status: IssueStatus;
  severity: IssueSeverity;
  labels: string; // comma-joined
};

/** EditingState 全字段 key（dirty 判定 / rebase 遍历用，单一 SSOT 避免漏字段）。 */
export const FIELD_KEYS = [
  'title',
  'description',
  'repro',
  'kind',
  'status',
  'severity',
  'labels',
] as const satisfies readonly (keyof EditingState)[];

export type FieldKey = (typeof FIELD_KEYS)[number];

/** IssueRecord → 编辑缓冲 canonical 形态（labels join 成逗号串）。 */
export function toEditing(rec: IssueRecord): EditingState {
  return {
    title: rec.title,
    description: rec.description,
    repro: rec.repro ?? '',
    kind: rec.kind,
    status: rec.status,
    severity: rec.severity,
    labels: rec.labels.join(', '),
  };
}

/** labels 编辑串 → 归一化数组（split/trim/filter 空）。submit + 比较共用，避免「a,b」vs「a, b」误判。 */
export function parseLabels(labels: string): string[] {
  return labels
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 单字段归一化相等判定（labels 比归一化数组、其余直接比串）。
 * 用于 dirty 判定：editing[k] 与 baseline[k] 归一化后相等 = 该字段无未保存草稿。
 */
export function fieldEquals(key: FieldKey, a: EditingState, b: EditingState): boolean {
  if (key === 'labels') {
    return JSON.stringify(parseLabels(a.labels)) === JSON.stringify(parseLabels(b.labels));
  }
  return a[key] === b[key];
}

/** editing 相对 baseline 是否有任何字段存在未保存草稿（归一化比较）。 */
export function hasDraft(editing: EditingState, baseline: EditingState): boolean {
  return FIELD_KEYS.some((k) => !fieldEquals(k, editing, baseline));
}

/** issuesUpdate 的 patch 形态（仅 detail 可改字段，全 optional — 缺省 = 不动该列）。 */
export interface IssueUpdatePatch {
  title?: string;
  description?: string;
  repro?: string | null;
  kind?: string;
  status?: IssueStatus;
  severity?: IssueSeverity;
  labels?: string[];
}

/**
 * 构建 issuesUpdate patch：**只提交 editing 与「当前最新服务器值 issue」归一化不等的字段**。
 *
 * 提交判定用 `editing[k] !== issue[k]`（issue = 最新服务器值），**不是** `editing[k] !== baseline[k]`：
 * - HIGH-B（外部改字段、用户没碰）：rebase 已把无草稿字段 editing 同步到 latest → editing===issue → 不提交（不回滚）
 * - Round2-HIGH（碰过又改回原值）：editing 改回后 === issue → 不提交（不回滚）
 * - Round3-MED（冲突字段改回旧值）：editing=open 但 issue=resolved → editing!==issue → **提交 open**
 *   （用户确实想把已被外部改成 resolved 的字段写回 open，正确，不再 stale no-op / UI-DB 分叉）
 *
 * HIGH-A 第二道防线：`expectedIssueId`（=组件 props.issueId）与 `issue.id` 不一致 → 返空 patch
 * （key remount 是主防线，这里兜底防回归把 A 的草稿写到 B）。
 */
export function buildUpdatePatch(
  editing: EditingState,
  issue: IssueRecord,
  expectedIssueId: string,
): IssueUpdatePatch {
  // HIGH-A 第二道防线：身份不符直接返空（key remount 是主防线，这里兜底防回归）。
  if (issue.id !== expectedIssueId) return {};
  const canonical = toEditing(issue);
  const patch: IssueUpdatePatch = {};
  if (!fieldEquals('title', editing, canonical)) patch.title = editing.title;
  if (!fieldEquals('description', editing, canonical)) patch.description = editing.description;
  if (!fieldEquals('repro', editing, canonical)) patch.repro = editing.repro || null;
  if (!fieldEquals('kind', editing, canonical)) patch.kind = editing.kind;
  if (!fieldEquals('status', editing, canonical)) patch.status = editing.status;
  if (!fieldEquals('severity', editing, canonical)) patch.severity = editing.severity;
  if (!fieldEquals('labels', editing, canonical)) patch.labels = parseLabels(editing.labels);
  return patch;
}

/**
 * 外部 issue（fetch resolve / store-sync event）到来时计算新的 `{editing, baseline}`：
 * - **baseline 始终推进到最新 issue 的 canonical**（baseline 语义 = 最新已知服务器值，不保留旧锚点
 *   —— 修 Round3-MED：旧实现冲突字段保留旧 baseline 导致「改回旧值 stale no-op」）
 * - **editing**：该字段无草稿（rebase 前 editing[k] 归一化等于 prevBaseline[k]）→ 同步最新；
 *   有草稿（不等）→ 保留用户输入
 *
 * 草稿判定用 `prevBaseline`（rebase 前那刻的服务器值）作对照，故 baseline 必须是「上一次的
 * 服务器值快照」。`prev`/`prevBaseline` 为 null（首次 seed）→ editing+baseline 都用 canonical。
 */
export function rebaseEditingState(
  prev: EditingState | null,
  prevBaseline: EditingState | null,
  latest: IssueRecord,
): { editing: EditingState; baseline: EditingState } {
  const canonical = toEditing(latest);
  if (!prev || !prevBaseline) return { editing: canonical, baseline: canonical };
  // baseline 总是推进到最新服务器值（不保留旧锚点）。
  const baseline = canonical;
  const editing = { ...canonical };
  for (const k of FIELD_KEYS) {
    if (!fieldEquals(k, prev, prevBaseline)) {
      // 该字段有未保存草稿（相对上一次服务器值）→ 保留用户输入，不同步最新。
      (editing[k] as EditingState[FieldKey]) = prev[k];
    }
    // 无草稿 → editing[k] 取 canonical（同步最新）。
  }
  return { editing, baseline };
}
