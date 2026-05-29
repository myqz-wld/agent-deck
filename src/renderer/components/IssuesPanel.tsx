/**
 * Issues tab list 视图 + filter 栏（plan issue-tracker-mcp-20260529 §Step 3.8.2 / §D12）。
 *
 * - 上方 filter 栏: status 多选 / kind 多选 / search title (debounce 300ms) / show deleted toggle
 * - 主列表: createdAt DESC 排序; click 切到 IssueDetail
 * - useEffect 启动时拉 `window.api.issuesList(filters)` + 订阅 `window.api.onIssueChanged` 实时更新 store
 * - hardDeleted event → store.removeIssue + 若 selected 跟着 deselect
 */

import { useEffect, useState, type JSX } from 'react';
import type { IssueStatus, IssueRecord } from '@shared/types';
import {
  useIssuesStore,
  selectFilteredIssues,
  type IssueFilters,
} from '../stores/issues-store';
import { IssueDetail } from './IssueDetail';

const STATUS_OPTIONS: IssueStatus[] = ['open', 'in-progress', 'resolved'];
const KIND_OPTIONS = [
  'follow-up',
  'app-bug',
  'external-tooling-bug',
  'convention-gap',
  'enhancement',
] as const;

const KEYWORD_DEBOUNCE_MS = 300;

export function IssuesPanel(): JSX.Element {
  const issues = useIssuesStore((s) => s.issues);
  const filters = useIssuesStore((s) => s.filters);
  const selectedIssueId = useIssuesStore((s) => s.selectedIssueId);
  const setIssues = useIssuesStore((s) => s.setIssues);
  const upsertIssue = useIssuesStore((s) => s.upsertIssue);
  const removeIssue = useIssuesStore((s) => s.removeIssue);
  const setFilters = useIssuesStore((s) => s.setFilters);
  const selectIssue = useIssuesStore((s) => s.selectIssue);

  const [keywordInput, setKeywordInput] = useState(filters.titleKeyword ?? '');
  const [loading, setLoading] = useState(false);

  const filteredList = selectFilteredIssues({
    issues,
    filters,
    selectedIssueId,
    setIssues,
    upsertIssue,
    removeIssue,
    setFilters,
    selectIssue,
  } as Parameters<typeof selectFilteredIssues>[0]);

  // keyword input → filters debounce 300ms
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters({ ...filters, titleKeyword: keywordInput || undefined });
    }, KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordInput]);

  // 初始 + filters 变 重拉 list
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
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
        setIssues(list);
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
    setIssues,
  ]);

  // 订阅 issue-changed event 推 store (与 task-changed "component 自订阅" 同模式)
  useEffect(() => {
    const off = window.api.onIssueChanged((e) => {
      if (e.kind === 'hardDeleted') {
        removeIssue(e.issueId);
      } else if (e.issue) {
        upsertIssue(e.issue);
      }
    });
    return off;
  }, [upsertIssue, removeIssue]);

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
          {loading && filteredList.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-deck-muted">加载中...</div>
          ) : filteredList.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-deck-muted">
              暂无 issue。agent 在执行中调 mcp tool report_issue 上报问题后会在此显示。
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
          <IssueDetail issueId={selectedIssueId} onClose={() => selectIssue(null)} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-deck-muted">
            左侧选择 issue 查看 detail
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
  const toggleStatus = (s: IssueStatus): void => {
    const cur = filters.statuses ?? [];
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
    onFiltersChange({ ...filters, statuses: next.length === 0 ? undefined : next });
  };
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
      <div className="flex flex-wrap gap-1">
        <span className="text-[10px] text-deck-muted">状态:</span>
        {STATUS_OPTIONS.map((s) => (
          <FilterChip
            key={s}
            label={s}
            active={(filters.statuses ?? []).includes(s)}
            onClick={() => toggleStatus(s)}
          />
        ))}
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
        显示软删
      </label>
    </div>
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
          <span className={`rounded px-1 text-[9px] ${severityColor}`}>{issue.severity}</span>
          <span className="rounded bg-white/[0.06] px-1 text-[9px] text-deck-muted">
            {issue.kind}
          </span>
          {issue.deletedAt !== null && (
            <span className="rounded bg-status-waiting/25 px-1 text-[9px] text-status-waiting">
              已删
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-deck-text">{issue.title}</div>
        <div className="mt-0.5 text-[10px] text-deck-muted">
          {new Date(issue.createdAt).toLocaleString('zh-CN', { hour12: false })}
          {issue.cwd ? ` · ${issue.cwd.split('/').slice(-2).join('/')}` : ''}
        </div>
      </button>
    </li>
  );
}
