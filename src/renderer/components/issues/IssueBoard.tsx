import type { JSX, ReactNode } from 'react';

import type { IssueRecord, IssueStatus } from '@shared/types';
import type { IssueFilters } from '@renderer/stores/issues-store';

const ACTIVE_STATUSES: IssueStatus[] = ['open', 'in-progress'];
const RESOLVED_STATUSES: IssueStatus[] = ['resolved'];
const KIND_OPTIONS = ['follow-up', 'app-bug'] as const;

export function IssueBoard({
  filters,
  issues,
  keywordInput,
  listError,
  loading,
  selectedIssueId,
  truncated,
  detail,
  onFiltersChange,
  onKeywordChange,
  onSelectIssue,
}: {
  filters: IssueFilters;
  issues: readonly IssueRecord[];
  keywordInput: string;
  listError: string | null;
  loading: boolean;
  selectedIssueId: string | null;
  truncated?: boolean;
  detail: ReactNode;
  onFiltersChange(filters: IssueFilters): void;
  onKeywordChange(value: string): void;
  onSelectIssue(issueId: string): void;
}): JSX.Element {
  return (
    <div className="flex h-full">
      <div className="flex w-1/2 min-w-[320px] max-w-[480px] flex-col border-r border-deck-border">
        <FilterBar
          filters={filters}
          keywordInput={keywordInput}
          onKeywordChange={onKeywordChange}
          onFiltersChange={onFiltersChange}
        />
        <div className="flex-1 overflow-y-auto scrollbar-deck">
          {listError ? (
            <div className="px-3 py-8 text-center text-xs text-status-waiting">
              加载失败：{listError}
            </div>
          ) : loading && issues.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-deck-muted">加载中…</div>
          ) : issues.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-deck-muted">
              暂无问题。Agent 执行任务时主动上报的问题会显示在这里。
            </div>
          ) : (
            <>
              <ul className="divide-y divide-deck-border">
                {issues.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    selected={issue.id === selectedIssueId}
                    onClick={() => onSelectIssue(issue.id)}
                  />
                ))}
              </ul>
              {truncated && (
                <div className="border-t border-deck-border px-3 py-2 text-[10px] text-deck-muted">
                  仅显示当前筛选下最近的 100 条问题。
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-deck">{detail}</div>
    </div>
  );
}

function FilterBar({
  filters,
  keywordInput,
  onKeywordChange,
  onFiltersChange,
}: {
  filters: IssueFilters;
  keywordInput: string;
  onKeywordChange(value: string): void;
  onFiltersChange(filters: IssueFilters): void;
}): JSX.Element {
  const showingResolved = (filters.statuses ?? []).includes('resolved');
  const toggleKind = (kind: string): void => {
    const current = filters.kinds ?? [];
    const next = current.includes(kind)
      ? current.filter((value) => value !== kind)
      : [...current, kind];
    onFiltersChange({ ...filters, kinds: next.length === 0 ? undefined : next });
  };
  return (
    <div className="space-y-2 border-b border-deck-border px-3 py-2">
      <input
        type="text"
        placeholder="搜索标题…"
        value={keywordInput}
        onChange={(event) => onKeywordChange(event.target.value)}
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
        <span className="text-[10px] text-deck-muted">类型：</span>
        {KIND_OPTIONS.map((kind) => (
          <FilterChip
            key={kind}
            label={kind}
            active={(filters.kinds ?? []).includes(kind)}
            onClick={() => toggleKind(kind)}
          />
        ))}
      </div>
      <label className="flex items-center gap-1 text-[10px] text-deck-muted">
        <input
          type="checkbox"
          checked={filters.showDeleted ?? false}
          onChange={(event) => onFiltersChange({ ...filters, showDeleted: event.target.checked })}
        />
        显示已删除
      </label>
    </div>
  );
}

function StatusTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick(): void;
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
  onClick(): void;
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
  onClick(): void;
}): JSX.Element {
  const statusColor = issue.status === 'open'
    ? 'text-status-finished'
    : issue.status === 'in-progress' ? 'text-status-working' : 'text-status-idle';
  const severityColor = issue.severity === 'high'
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

export function EmptyIssueDetail(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-xs text-deck-muted">
      从左侧选择一个问题查看详情
    </div>
  );
}
