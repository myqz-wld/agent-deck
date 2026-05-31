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

import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  IssueRecord,
  IssueAppendix,
  IssueSeverity,
  IssueStatus,
} from '@shared/types';
import { useIssuesStore } from '../stores/issues-store';
import { ResolveInNewSessionDialog } from './ResolveInNewSessionDialog';
import {
  type EditingState,
  type FieldKey,
  toEditing,
  buildUpdatePatch,
  rebaseEditingState,
} from './issue-detail-editing';

interface Props {
  issueId: string;
  onClose: () => void;
  /** 点「解决会话 / 来源会话」跳到 live 视图打开该 session（App → IssuesPanel 透传） */
  onOpenSession?: (sid: string) => void;
}

export function IssueDetail({ issueId, onClose, onOpenSession }: Props): JSX.Element {
  // store 是权威源：list 重拉 / onIssueChanged event（含起新会话改 status='in-progress'）都先
  // 落 store，本组件订阅它而非读一次。selectedIssueId 不变时 store 行变 → 自动重渲染。
  const issueFromStore = useIssuesStore((s) => s.issues.get(issueId));
  const upsertIssue = useIssuesStore((s) => s.upsertIssue);
  const [issue, setIssue] = useState<IssueRecord | null>(issueFromStore ?? null);
  const [editing, setEditing] = useState<EditingState | null>(
    issueFromStore ? toEditing(issueFromStore) : null,
  );
  // baseline = 最新已知服务器值快照（每次 rebase 推进到 latest）。仅用于 rebase 时判定某字段
  // 「有无未保存草稿」（editing[k] 归一化 !== baseline[k]）。详 issue-detail-editing.ts 头注 ——
  // 提交判定走 editing vs 最新 issue（非 baseline），修 Round3-MED「冲突字段改回旧值 stale no-op」。
  const [baseline, setBaseline] = useState<EditingState | null>(
    issueFromStore ? toEditing(issueFromStore) : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);

  // ref 镜像让异步 fetch callback / effect 读到 resolve 那一刻的最新值（闭包变量是启动时旧值）。
  const issueRef = useRef(issue);
  const editingRef = useRef(editing);
  const baselineRef = useRef(baseline);
  const savingRef = useRef(saving);
  useEffect(() => {
    issueRef.current = issue;
    editingRef.current = editing;
    baselineRef.current = baseline;
    savingRef.current = saving;
  });

  // 用户改某字段：只写 editing（草稿由 editing vs baseline 归一化比较动态得出，无需单独记录）。
  const updateField = <K extends FieldKey>(key: K, value: EditingState[K]): void => {
    setEditing((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  // 外部 issue（fetch resolve / store-sync event）到来时 rebase：baseline 推进到最新；editing 无草稿
  // 字段同步最新、有草稿字段保留用户输入。用 ref 读 resolve 那一刻的最新 editing/baseline。
  const rebaseEditing = (latest: IssueRecord): void => {
    const next = rebaseEditingState(editingRef.current, baselineRef.current, latest);
    setEditing(next.editing);
    setBaseline(next.baseline);
  };

  // 初始拉 detail 含 appendices（IssuesGet 比 store 多带 appendices 子列表）。父组件 key={issueId}
  // 保证 issueId 变即 remount fresh state（HIGH-A 跨 issue 污染根治），故本 effect 仅 mount 跑一次。
  // editing/baseline 已由 issueFromStore 同步 seed（可在 fetch 未回前就编辑）→ fetch 回来时 rebase：
  // 无草稿字段更到最新，有草稿字段保留（codex MED：慢 fetch 不吞已输入草稿）。
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void window.api.issuesGet(issueId).then((fetched) => {
      if (cancelled || !fetched) {
        if (!cancelled && !fetched) setError('未找到该问题');
        return;
      }
      setIssue(fetched);
      rebaseEditing(fetched);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId]);

  // store 行被 onIssueChanged event 更新（典型：起新会话回写 status='in-progress'，或其他
  // 视图 / teammate 改了同一 issue）→ 刷新 read-only `issue` 显示，避免「状态没刷新需切走再切回」。
  // editing 草稿处理：rebaseEditing 把无草稿字段同步到最新、有草稿字段保留（HIGH-B / Round2-HIGH 根治）。
  // saving 期间整体跳过：handleSave 自己 setIssue。
  // appendices 防丢：list() 路径的 store 行不带 appendices（避免 N+1），event 路径都带；
  // 故 `?? prev` 保住 IssuesGet 已拉到的子列表（undefined=未加载，区别于 []=确无）。
  // 用 ref 读最新 issue/editing/baseline/saving（这些可在 storeUpdatedAt 不变时变化 → 闭包值会过时）。
  const storeUpdatedAt = issueFromStore?.updatedAt;
  useEffect(() => {
    if (!issueFromStore || savingRef.current) return;
    const base = issueRef.current;
    if (base && base.updatedAt === issueFromStore.updatedAt) return;
    setIssue((prev) => ({
      ...issueFromStore,
      appendices: issueFromStore.appendices ?? prev?.appendices,
    }));
    rebaseEditing(issueFromStore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeUpdatedAt]);

  if (error) {
    return (
      <div className="px-3 py-3 text-xs text-status-waiting">
        {error} <button onClick={onClose} className="underline">关闭</button>
      </div>
    );
  }
  if (!issue || !editing || !baseline) {
    return <div className="px-3 py-3 text-xs text-deck-muted">加载中...</div>;
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const patch = buildUpdatePatch(editing, issue, issueId);
      // 空 patch（无草稿）→ 跳过 IPC 往返（避免冗余 emit kind=updated 触发全 panel no-op upsert）。
      if (Object.keys(patch).length === 0) {
        setSaving(false);
        return;
      }
      const updated = await window.api.issuesUpdate(issueId, patch);
      setIssue(updated);
      upsertIssue(updated);
      // 保存成功 → editing + baseline 都归一化为 DB canonical 形态（labels "a,b" → "a, b"）。
      // baseline 推进到 updated → 后续外部 event 能把所有字段 rebase 到最新（草稿已落库）。
      setEditing(toEditing(updated));
      setBaseline(toEditing(updated));
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
            onChange={(e) => updateField('title', e.target.value)}
            disabled={isDeleted || saving}
            maxLength={200}
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
          />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="状态">
            <select
              value={editing.status}
              onChange={(e) => updateField('status', e.target.value as IssueStatus)}
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
              onChange={(e) => updateField('severity', e.target.value as IssueSeverity)}
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
              onChange={(e) => updateField('kind', e.target.value)}
              disabled={isDeleted || saving}
              maxLength={32}
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none disabled:opacity-50"
            />
          </Field>
        </div>
        <Field label="描述">
          <textarea
            value={editing.description}
            onChange={(e) => updateField('description', e.target.value)}
            disabled={isDeleted || saving}
            maxLength={2000}
            rows={4}
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
          />
        </Field>
        <Field label="重现步骤（可选）">
          <textarea
            value={editing.repro}
            onChange={(e) => updateField('repro', e.target.value)}
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
            onChange={(e) => updateField('labels', e.target.value)}
            disabled={isDeleted || saving}
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
          />
        </Field>

        {/* meta 信息 read-only */}
        <div className="space-y-1 rounded bg-white/[0.03] px-2 py-2 text-[10px] text-deck-muted">
          <div>ID: {issue.id}</div>
          <div className="flex items-center gap-1">
            来源会话:{' '}
            {issue.sourceSessionId ? (
              <SessionLink sid={issue.sourceSessionId} onOpenSession={onOpenSession} />
            ) : (
              <em>原会话已被清理</em>
            )}
          </div>
          <div>工作目录: {issue.cwd ?? '—'}</div>
          <div>
            创建: {new Date(issue.createdAt).toLocaleString('zh-CN', { hour12: false })} · 更新:{' '}
            {new Date(issue.updatedAt).toLocaleString('zh-CN', { hour12: false })}
          </div>
          {issue.resolvedAt && (
            <div>
              {/* LOW-1（review Round 1）：D15 状态机 reopen 后保留 resolved_at（避免 GC 误删），
                  但当前 status≠resolved 时显示「解决于」与状态矛盾 → 改「上次解决于」。 */}
              {isResolved ? '解决于' : '上次解决于'}:{' '}
              {new Date(issue.resolvedAt).toLocaleString('zh-CN', { hour12: false })}
            </div>
          )}
          {issue.deletedAt && (
            <div className="text-status-waiting">
              删除于: {new Date(issue.deletedAt).toLocaleString('zh-CN', { hour12: false })}
            </div>
          )}
          {issue.resolutionSessionId && (
            <div className="flex items-center gap-1">
              解决会话:{' '}
              <SessionLink sid={issue.resolutionSessionId} onOpenSession={onOpenSession} />
            </div>
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
            title={
              issue.resolutionSessionId
                ? '已有解决会话；重新起会替换 resolutionSessionId，旧解决会话将失去自助改状态的授权'
                : undefined
            }
            className="rounded bg-status-working/25 px-2 py-1 text-xs text-status-working hover:bg-status-working/40 disabled:opacity-50"
          >
            {issue.resolutionSessionId ? '换解决会话' : '起新会话解决'}
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
            // rebase editing：把非 dirty 字段（典型 status，起新会话已回写 in-progress）同步到
            // 下拉显示，dirty 字段保留用户草稿。不补这步 → issue 与 store 同对象 updatedAt 相等 →
            // store-sync effect 短路（base.updatedAt === issueFromStore.updatedAt return）→ editing
            // 永不刷新 → 状态下拉卡在 dialog 打开那刻的旧 open（起新会话已改 in-progress 但下拉仍 open）。
            rebaseEditing(updated);
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

/** session id 渲染：有 onOpenSession 回调时可点击跳转到该会话，否则纯文本展示。 */
function SessionLink({
  sid,
  onOpenSession,
}: {
  sid: string;
  onOpenSession?: (sid: string) => void;
}): JSX.Element {
  if (!onOpenSession) return <span className="font-mono">{sid}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpenSession(sid)}
      title="打开该会话"
      className="truncate font-mono text-status-working underline-offset-2 hover:underline"
    >
      {sid}
    </button>
  );
}
