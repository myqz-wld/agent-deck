/**
 * Issues tab list 视图 + filter 栏（plan issue-tracker-mcp-20260529 §Step 3.8.2 / §D12）。
 *
 * - 上方 filter 栏: status 多选 / kind 多选 / search title (debounce 300ms) / show deleted toggle
 * - 主列表: createdAt DESC 排序; click 切到 IssueDetail
 * - useEffect 启动时 + filter 变时拉 `window.api.issuesList(filters)` merge 进 store
 * - issue-changed 实时事件由全局常驻 `useIssuesBridge`（App.tsx）订阅，**不在本组件内**——
 *   否则切走 tab unmount 即漏事件、切回状态不刷新（详 use-issues-bridge.ts 头注）
 */

import { useEffect, useMemo, useState, type JSX } from 'react';
import type { IssueStatus, IssueRecord } from '@shared/types';
import {
  useIssuesStore,
  selectFilteredIssues,
  type IssueFilters,
} from '../stores/issues-store';
import { IssueDetail } from './IssueDetail';

// 「活跃」tab = open + in-progress；「已解决」tab = resolved（两 tab 互斥，复用 filters.statuses 底层）
const ACTIVE_STATUSES: IssueStatus[] = ['open', 'in-progress'];
const RESOLVED_STATUSES: IssueStatus[] = ['resolved'];
const KIND_OPTIONS = ['follow-up', 'app-bug'] as const;

const KEYWORD_DEBOUNCE_MS = 300;

export function IssuesPanel({ onOpenSession }: { onOpenSession?: (sid: string) => void }): JSX.Element {
  const issues = useIssuesStore((s) => s.issues);
  const filters = useIssuesStore((s) => s.filters);
  const selectedIssueId = useIssuesStore((s) => s.selectedIssueId);
  const mergeIssuesFromList = useIssuesStore((s) => s.mergeIssuesFromList);
  const setFilters = useIssuesStore((s) => s.setFilters);
  const selectIssue = useIssuesStore((s) => s.selectIssue);

  const [keywordInput, setKeywordInput] = useState(filters.titleKeyword ?? '');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // selector 只用 issues / filters 两字段（store.ts），useMemo 缓存避免每 render 对最多 500 条
  // 重做 filter+sort（deep-review H1 INFO）。
  const filteredList = useMemo(
    () => selectFilteredIssues({ issues, filters }),
    [issues, filters],
  );

  // keyword input → filters debounce 300ms。
  // 用 functional updater 读最新 filters（不是闭包捕获的旧值）：用户输入搜索后 300ms 内切
  // tab/kind/showDeleted 时，旧 timeout 到点只补 titleKeyword 到**最新** filters，不再把刚切的
  // tab 覆盖回去（reviewer-codex MED：debounce 旧闭包覆盖 tab 切换）。
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((prev) => ({ ...prev, titleKeyword: keywordInput || undefined }));
    }, KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordInput]);

  // 初始 + filters 变 重拉 list
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    void window.api
      .issuesList({
        statuses: filters.statuses,
        kinds: filters.kinds,
        titleKeyword: filters.titleKeyword,
        includeDeleted: filters.showDeleted,
        limit: 500,
      })
      .then((list) => {
        if (cancelled) return;
        // merge（非整替）：保留期间 onIssueChanged event 已 upsert 的更新记录（deep-review H1 MED）。
        mergeIssuesFromList(list);
      })
      .catch((e: unknown) => {
        // deep-review H1 MED：无 catch 时 reject 冒泡到 main.tsx unhandledrejection → 全屏 fatal banner。
        // 接住 → 列表区内联报错，不遮挡整窗。
        if (cancelled) return;
        setListError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    filters.statuses,
    filters.kinds,
    filters.titleKeyword,
    filters.showDeleted,
    mergeIssuesFromList,
  ]);

  // 注：issue-changed event 订阅已上移到全局常驻 useIssuesBridge（App.tsx），不再放本组件内
  // ——否则切走 tab 时 IssuesPanel unmount，期间的 issue-changed 事件全漏，切回状态不刷新
  // （详 use-issues-bridge.ts 头注）。本组件只负责按 filter 拉 list snapshot + 渲染。

  return (
    <div className="flex h-full">
      {/* Left: list + filter */}
      <div className="flex w-1/2 min-w-[320px] max-w-[480px] flex-col border-r border-deck-border">
        <FilterBar
          filters={filters}
          keywordInput={keywordInput}
          onKeywordChange={setKeywordInput}
          onFiltersChange={setFilters}
        />
        <div className="flex-1 overflow-y-auto scrollbar-deck">
          {listError ? (
            <div className="px-3 py-8 text-center text-xs text-status-waiting">
              加载失败：{listError}
            </div>
          ) : loading && filteredList.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-deck-muted">加载中...</div>
          ) : filteredList.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-deck-muted">
              暂无问题。Agent 执行任务时主动上报的问题会显示在这里。
            </div>
          ) : (
            <ul className="divide-y divide-deck-border">
              {filteredList.map((i) => (
                <IssueRow
                  key={i.id}
                  issue={i}
                  selected={i.id === selectedIssueId}
                  onClick={() => selectIssue(i.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      {/* Right: detail (or empty hint) */}
      <div className="flex-1 overflow-y-auto scrollbar-deck">
        {selectedIssueId ? (
          // key={selectedIssueId} 是 load-bearing：强制 per-issue remount fresh state（editing/
          // baseline 从新 issue 重 seed），根治切 issue 时旧草稿写到新 issue 的跨 issue 污染
          // （deep-review HIGH-A）。删此 key 会令污染复活；buildUpdatePatch 的 expectedIssueId
          // 守护是第二道防线但不可替代 key（fresh state 才能保证 baseline 正确）。
          <IssueDetail
            key={selectedIssueId}
            issueId={selectedIssueId}
            onClose={() => selectIssue(null)}
            onOpenSession={onOpenSession}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-deck-muted">
            从左侧选择一个问题查看详情
          </div>
        )}
      </div>
    </div>
  );
}

interface FilterBarProps {
  filters: IssueFilters;
  keywordInput: string;
  onKeywordChange: (v: string) => void;
  onFiltersChange: (f: IssueFilters) => void;
}

function FilterBar({
  filters,
  keywordInput,
  onKeywordChange,
  onFiltersChange,
}: FilterBarProps): JSX.Element {
  // resolved tab 判定：filters.statuses 含 'resolved' = 已解决视图，否则活跃视图
  const showingResolved = (filters.statuses ?? []).includes('resolved');
  const toggleKind = (k: string): void => {
    const cur = filters.kinds ?? [];
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    onFiltersChange({ ...filters, kinds: next.length === 0 ? undefined : next });
  };
  return (
    <div className="space-y-2 border-b border-deck-border px-3 py-2">
      <input
        type="text"
        placeholder="搜索标题..."
        value={keywordInput}
        onChange={(e) => onKeywordChange(e.target.value)}
        className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20"
      />
      <div className="flex gap-1">
        <StatusTab
          label="活跃"
          active={!showingResolved}
          onClick={() => onFiltersChange({ ...filters, statuses: ACTIVE_STATUSES })}
        />
        <StatusTab
          label="已解决"
          active={showingResolved}
          onClick={() => onFiltersChange({ ...filters, statuses: RESOLVED_STATUSES })}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        <span className="text-[10px] text-deck-muted">类型:</span>
        {KIND_OPTIONS.map((k) => (
          <FilterChip
            key={k}
            label={k}
            active={(filters.kinds ?? []).includes(k)}
            onClick={() => toggleKind(k)}
          />
        ))}
      </div>
      <label className="flex items-center gap-1 text-[10px] text-deck-muted">
        <input
          type="checkbox"
          checked={filters.showDeleted ?? false}
          onChange={(e) => onFiltersChange({ ...filters, showDeleted: e.target.checked })}
        />
        显示已删除
      </label>
    </div>
  );
}

/** 活跃 / 已解决 互斥 tab（比 chip 更突出「切换视图」语义）。 */
function StatusTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-[11px] transition-colors ${
        active
          ? 'bg-white/15 text-deck-text ring-1 ring-white/20'
          : 'bg-white/[0.04] text-deck-muted hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
        active
          ? 'bg-white/15 text-deck-text ring-1 ring-white/20'
          : 'bg-white/[0.04] text-deck-muted hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  );
}

function IssueRow({
  issue,
  selected,
  onClick,
}: {
  issue: IssueRecord;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  const statusColor =
    issue.status === 'open'
      ? 'text-status-finished'
      : issue.status === 'in-progress'
        ? 'text-status-working'
        : 'text-status-idle';
  const severityColor =
    issue.severity === 'high'
      ? 'bg-status-waiting/25 text-status-waiting'
      : issue.severity === 'medium'
        ? 'bg-status-finished/25 text-status-finished'
        : 'bg-status-idle/25 text-status-idle';
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full px-3 py-2 text-left transition ${
          selected ? 'bg-white/10' : 'hover:bg-white/[0.04]'
        } ${issue.deletedAt !== null ? 'opacity-50' : ''}`}
      >
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] uppercase ${statusColor}`}>{issue.status}</span>
          <span className={`rounded px-1 text-[9px] ${severityColor}`}>
            {issue.severity.toUpperCase()}
          </span>
          <span className="rounded bg-white/[0.06] px-1 text-[9px] text-deck-muted">
            {issue.kind}
          </span>
          {issue.deletedAt !== null && (
            <span className="rounded bg-status-waiting/25 px-1 text-[9px] text-status-waiting">
              已删除
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-deck-text">{issue.title}</div>
        <div className="mt-0.5 text-[10px] text-deck-muted">
          {new Date(issue.createdAt).toLocaleString('zh-CN', { hour12: false })}
          {issue.branchName ? ` · ${issue.branchName}` : ''}
          {issue.cwd ? ` · ${issue.cwd.split('/').slice(-2).join('/')}` : ''}
        </div>
      </button>
    </li>
  );
}
