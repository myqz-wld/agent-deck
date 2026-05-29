/**
 * Issue detail 视图（plan issue-tracker-mcp-20260529 §Step 3.8.3 / §D12）。
 *
 * - 上方 main 字段可改: status (3 态下拉) / kind / title / description / repro / severity / labels
 * - 中间 logsRef 显示（read-only）
 * - 下方 appendices read-only 按 appendedAt asc 渲染
 * - 操作: Save (调 issuesUpdate) / Soft Delete / Undelete / Resolve in new session (打开 dialog)
 *
 * **§不变量 9**: appendices 是 agent 写的现场，UI 端不改（read-only 渲染）。
 * **§D7**: status 严格 3 态（zod IPC 层守门 reject foo）。
 */

import { useEffect, useState, type JSX } from 'react';
import type {
  IssueRecord,
  IssueAppendix,
  IssueSeverity,
  IssueStatus,
} from '@shared/types';
import { useIssuesStore } from '../stores/issues-store';
import { ResolveInNewSessionDialog } from './ResolveInNewSessionDialog';

interface Props {
  issueId: string;
  onClose: () => void;
}

export function IssueDetail({ issueId, onClose }: Props): JSX.Element {
  const issueFromStore = useIssuesStore((s) => s.issues.get(issueId));
  const upsertIssue = useIssuesStore((s) => s.upsertIssue);
  const [issue, setIssue] = useState<IssueRecord | null>(issueFromStore ?? null);
  const [editing, setEditing] = useState<{
    title: string;
    description: string;
    repro: string;
    kind: string;
    status: IssueStatus;
    severity: IssueSeverity;
    labels: string; // comma-joined
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);

  // 初始 / issueId 变 → 拉 detail 含 appendices
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void window.api.issuesGet(issueId).then((fetched) => {
      if (cancelled || !fetched) {
        if (!cancelled && !fetched) setError('未找到该问题');
        return;
      }
      setIssue(fetched);
      setEditing({
        title: fetched.title,
        description: fetched.description,
        repro: fetched.repro ?? '',
        kind: fetched.kind,
        status: fetched.status,
        severity: fetched.severity,
        labels: fetched.labels.join(', '),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  if (error) {
    return (
      <div className="px-3 py-3 text-xs text-status-waiting">
        {error} <button onClick={onClose} className="underline">关闭</button>
      </div>
    );
  }
  if (!issue || !editing) {
    return <div className="px-3 py-3 text-xs text-deck-muted">加载中...</div>;
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const labelsArr = editing.labels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const updated = await window.api.issuesUpdate(issueId, {
        title: editing.title !== issue.title ? editing.title : undefined,
        description: editing.description !== issue.description ? editing.description : undefined,
        repro: editing.repro !== (issue.repro ?? '') ? (editing.repro || null) : undefined,
        kind: editing.kind !== issue.kind ? editing.kind : undefined,
        status: editing.status !== issue.status ? editing.status : undefined,
        severity: editing.severity !== issue.severity ? editing.severity : undefined,
        labels: JSON.stringify(labelsArr) !== JSON.stringify(issue.labels) ? labelsArr : undefined,
      });
      setIssue(updated);
      upsertIssue(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSoftDelete = async (): Promise<void> => {
    setSaving(true);
    try {
      await window.api.issuesSoftDelete(issueId);
      // store 通过 onIssueChanged 自动更新；这里同步 local issue state 让 button 立即换显
      const fresh = await window.api.issuesGet(issueId);
      if (fresh) setIssue(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleUndelete = async (): Promise<void> => {
    setSaving(true);
    try {
      await window.api.issuesUndelete(issueId);
      const fresh = await window.api.issuesGet(issueId);
      if (fresh) setIssue(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const appendices: IssueAppendix[] = issue.appendices ?? [];
  const isDeleted = issue.deletedAt !== null;
  const isResolved = issue.status === 'resolved';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-deck-border px-3 py-2">
        <h2 className="truncate text-sm font-medium text-deck-text" title={issue.id}>
          问题 · {issue.id.slice(0, 8)}
        </h2>
        <button onClick={onClose} className="text-xs text-deck-muted hover:text-deck-text">
          ✕
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto scrollbar-deck px-3 py-3">
        {error && (
          <div className="rounded bg-status-waiting/15 px-2 py-1 text-xs text-status-waiting">
            {error}
          </div>
        )}

        {/* main 字段编辑 */}
        <Field label="标题">
          <input
            type="text"
            value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            disabled={isDeleted || saving}
            maxLength={200}
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
          />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="状态">
            <select
              value={editing.status}
              onChange={(e) => setEditing({ ...editing, status: e.target.value as IssueStatus })}
              disabled={isDeleted || saving}
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none disabled:opacity-50"
            >
              <option value="open">open</option>
              <option value="in-progress">in-progress</option>
              <option value="resolved">resolved</option>
            </select>
          </Field>
          <Field label="严重度">
            <select
              value={editing.severity}
              onChange={(e) =>
                setEditing({ ...editing, severity: e.target.value as IssueSeverity })
              }
              disabled={isDeleted || saving}
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none disabled:opacity-50"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </Field>
          <Field label="类型">
            <input
              type="text"
              value={editing.kind}
              onChange={(e) => setEditing({ ...editing, kind: e.target.value })}
              disabled={isDeleted || saving}
              maxLength={32}
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none disabled:opacity-50"
            />
          </Field>
        </div>
        <Field label="描述">
          <textarea
            value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            disabled={isDeleted || saving}
            maxLength={2000}
            rows={4}
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
          />
        </Field>
        <Field label="重现步骤（可选）">
          <textarea
            value={editing.repro}
            onChange={(e) => setEditing({ ...editing, repro: e.target.value })}
            disabled={isDeleted || saving}
            maxLength={2000}
            rows={3}
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
          />
        </Field>
        <Field label="标签（逗号分隔）">
          <input
            type="text"
            value={editing.labels}
            onChange={(e) => setEditing({ ...editing, labels: e.target.value })}
            disabled={isDeleted || saving}
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
          />
        </Field>

        {/* meta 信息 read-only */}
        <div className="space-y-1 rounded bg-white/[0.03] px-2 py-2 text-[10px] text-deck-muted">
          <div>ID: {issue.id}</div>
          <div>来源会话: {issue.sourceSessionId ?? <em>原会话已被清理</em>}</div>
          <div>工作目录: {issue.cwd ?? '—'}</div>
          <div>
            创建: {new Date(issue.createdAt).toLocaleString('zh-CN', { hour12: false })} · 更新:{' '}
            {new Date(issue.updatedAt).toLocaleString('zh-CN', { hour12: false })}
          </div>
          {issue.resolvedAt && (
            <div>解决于: {new Date(issue.resolvedAt).toLocaleString('zh-CN', { hour12: false })}</div>
          )}
          {issue.deletedAt && (
            <div className="text-status-waiting">
              删除于: {new Date(issue.deletedAt).toLocaleString('zh-CN', { hour12: false })}
            </div>
          )}
          {issue.resolutionSessionId && (
            <div>解决会话: {issue.resolutionSessionId}</div>
          )}
        </div>

        {/* logsRef read-only */}
        {issue.logsRef && (
          <div className="space-y-1 rounded bg-white/[0.03] px-2 py-2 text-[10px] text-deck-muted">
            <div className="font-medium text-deck-muted">日志参考</div>
            <div>日期: {issue.logsRef.date}</div>
            {issue.logsRef.tsRange && (
              <div>
                时间范围: {new Date(issue.logsRef.tsRange.start).toISOString()} ~{' '}
                {new Date(issue.logsRef.tsRange.end).toISOString()}
              </div>
            )}
            {issue.logsRef.scopes && issue.logsRef.scopes.length > 0 && (
              <div>范围: {issue.logsRef.scopes.join(', ')}</div>
            )}
            {issue.logsRef.note && <div className="whitespace-pre-wrap">备注: {issue.logsRef.note}</div>}
          </div>
        )}

        {/* appendices read-only */}
        {appendices.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-deck-muted">
              补充记录 ({appendices.length})
            </div>
            <ul className="space-y-1.5">
              {appendices.map((a) => (
                <li
                  key={a.id}
                  className="rounded bg-white/[0.03] px-2 py-1.5 text-[11px] text-deck-text"
                >
                  <div className="mb-1 text-[10px] text-deck-muted">
                    {new Date(a.appendedAt).toLocaleString('zh-CN', { hour12: false })}
                    {a.appendedSessionId ? ` · 会话 ${a.appendedSessionId.slice(0, 8)}` : ' · 会话已清理'}
                  </div>
                  <div className="whitespace-pre-wrap">{a.body}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* action bar */}
      <div className="flex gap-1.5 border-t border-deck-border px-3 py-2">
        {!isDeleted && (
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded bg-white/15 px-2 py-1 text-xs text-deck-text hover:bg-white/25 disabled:opacity-50"
          >
            保存
          </button>
        )}
        {!isDeleted && !isResolved && (
          <button
            onClick={() => setResolveDialogOpen(true)}
            disabled={saving}
            className="rounded bg-status-working/25 px-2 py-1 text-xs text-status-working hover:bg-status-working/40 disabled:opacity-50"
          >
            起新会话解决
          </button>
        )}
        <div className="flex-1" />
        {!isDeleted ? (
          <button
            onClick={() => void handleSoftDelete()}
            disabled={saving}
            className="rounded bg-status-waiting/25 px-2 py-1 text-xs text-status-waiting hover:bg-status-waiting/40 disabled:opacity-50"
          >
            删除
          </button>
        ) : (
          <button
            onClick={() => void handleUndelete()}
            disabled={saving}
            className="rounded bg-status-finished/25 px-2 py-1 text-xs text-status-finished hover:bg-status-finished/40 disabled:opacity-50"
          >
            恢复
          </button>
        )}
      </div>

      {resolveDialogOpen && (
        <ResolveInNewSessionDialog
          issue={issue}
          onClose={() => setResolveDialogOpen(false)}
          onResolved={(updated) => {
            setIssue(updated);
            upsertIssue(updated);
            setResolveDialogOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="space-y-1">
      <label className="block text-[10px] uppercase tracking-wide text-deck-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
