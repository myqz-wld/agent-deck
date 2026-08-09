import { useEffect, useRef, useState, type JSX } from 'react';
import type { IssueRecord } from '@shared/types';
import type {
  RemoteSessionCreateInput,
  RemoteSessionSourceView,
} from '@renderer/remote-host/source-types';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { useIssuesStore } from '../stores/issues-store';
import { CloseIcon, RefreshIcon, SaveIcon, TrashIcon } from './icons';
import {
  Field,
  SessionLink,
  ISSUE_SEVERITY_OPTIONS,
  ISSUE_STATUS_OPTIONS,
} from './issue-detail-controls';
import {
  type EditingState,
  type FieldKey,
  toEditing,
  buildUpdatePatch,
  rebaseEditingState,
  validateEditing,
} from './issue-detail-editing';
import { ExpandableIssueTextField } from './issue-detail/ExpandableIssueTextField';
import { IssueAppendices, IssueLogsReference } from './issue-detail/IssueEvidence';
import { IssueResolutionControls } from './issues/IssueResolutionControls';

interface Props {
  issueId: string;
  onClose: () => void;
  /** Opens the related live session when that session still exists. */
  onOpenSession?: (sid: string) => void;
  source?: IssueDetailDataSource;
}

export interface IssueDetailDataSource {
  identity: string;
  observedIssue: IssueRecord | null;
  load(issueId: string): Promise<IssueRecord | null>;
  update(issueId: string, patch: ReturnType<typeof buildUpdatePatch>): Promise<IssueRecord>;
  softDelete(issueId: string): Promise<IssueRecord>;
  undelete(issueId: string): Promise<IssueRecord>;
  onUpdated(issue: IssueRecord): void;
  resolution?: {
    source: RemoteSessionSourceView;
    create(issue: IssueRecord, input: RemoteSessionCreateInput): Promise<IssueRecord>;
  };
}

export function IssueDetail({ issueId, onClose, onOpenSession, source }: Props): JSX.Element {
  // The store remains authoritative while this component keeps a per-issue edit buffer.
  const localIssueFromStore = useIssuesStore((s) => s.issues.get(issueId));
  const upsertIssue = useIssuesStore((s) => s.upsertIssue);
  const issueFromStore = source ? source.observedIssue ?? undefined : localIssueFromStore;
  const [issue, setIssue] = useState<IssueRecord | null>(issueFromStore ?? null);
  const [editing, setEditing] = useState<EditingState | null>(
    issueFromStore ? toEditing(issueFromStore) : null,
  );
  // The baseline is the latest known server value and identifies local field drafts.
  const [baseline, setBaseline] = useState<EditingState | null>(
    issueFromStore ? toEditing(issueFromStore) : null,
  );
  const [saving, setSaving] = useState(false);
  // Loading can replace the view; operation failures stay inline so the draft survives.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [fetchNonce, setFetchNonce] = useState(0);

  // Async fetches and store effects must rebase against values current at completion time.
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

  const loadIssue = (): Promise<IssueRecord | null> =>
    source ? source.load(issueId) : window.api.issuesGet(issueId);
  const applyIssue = (next: IssueRecord): void => {
    if (source) source.onUpdated(next);
    else upsertIssue(next);
  };

  const updateField = <K extends FieldKey>(key: K, value: EditingState[K]): void => {
    setEditing((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const rebaseEditing = (latest: IssueRecord): void => {
    const next = rebaseEditingState(editingRef.current, baselineRef.current, latest);
    setEditing(next.editing);
    setBaseline(next.baseline);
  };

  // Detail fetches add appendices omitted by list rows. Slow results rebase instead of
  // replacing fields that the user edited while the request was in flight.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    void loadIssue()
      .then((fetched) => {
        if (cancelled) return;
        if (!fetched) {
          setLoadError('未找到该 Issue');
          return;
        }
        const cur = issueRef.current;
        if (cur) {
          if (fetched.updatedAt < cur.updatedAt) return;
          // Millisecond timestamps can tie. On a tie, only hydrate appendices and retain
          // the event-backed content fields already visible to the user.
          if (fetched.updatedAt === cur.updatedAt) {
            if (cur.appendices === undefined && fetched.appendices !== undefined) {
              setIssue({ ...cur, appendices: fetched.appendices });
            }
            return;
          }
        }
        setIssue(fetched);
        rebaseEditing(fetched);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId, fetchNonce, source?.identity]);

  // Store updates advance untouched fields while preserving local drafts and hydrated appendices.
  useEffect(() => {
    if (!issueFromStore || savingRef.current) return;
    const base = issueRef.current;
    if (base && base.updatedAt > issueFromStore.updatedAt) return;
    setIssue((prev) => ({
      ...issueFromStore,
      appendices: issueFromStore.appendices ?? prev?.appendices,
    }));
    rebaseEditing(issueFromStore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueFromStore]);

  if (loadError) {
    return (
      <div className="px-3 py-3 text-xs text-status-waiting">
        {loadError}{' '}
        <button
          type="button"
          onClick={() => setFetchNonce((n) => n + 1)}
          className="underline hover:text-deck-text"
        >
          重试
        </button>{' '}
        <button type="button" onClick={onClose} className="underline hover:text-deck-text">
          关闭
        </button>
      </div>
    );
  }
  if (!issue || !editing || !baseline) {
    return <div className="px-3 py-3 text-xs text-deck-muted">加载中…</div>;
  }

  const handleSave = async (): Promise<void> => {
    const invalid = validateEditing(editing);
    if (invalid) {
      setOpError(invalid);
      return;
    }
    setSaving(true);
    setOpError(null);
    try {
      const patch = buildUpdatePatch(editing, issue, issueId);
      if (Object.keys(patch).length === 0) {
        setSaving(false);
        return;
      }
      const updated = source
        ? await source.update(issueId, patch)
        : await window.api.issuesUpdate(issueId, patch);
      setIssue(updated);
      applyIssue(updated);
      setEditing(toEditing(updated));
      setBaseline(toEditing(updated));
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSoftDelete = async (): Promise<void> => {
    setSaving(true);
    setOpError(null);
    try {
      const fresh = source
        ? await source.softDelete(issueId)
        : await window.api.issuesSoftDelete(issueId).then(() => window.api.issuesGet(issueId));
      if (fresh) { setIssue(fresh); applyIssue(fresh); }
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleUndelete = async (): Promise<void> => {
    setSaving(true);
    setOpError(null);
    try {
      const fresh = source
        ? await source.undelete(issueId)
        : await window.api.issuesUndelete(issueId).then(() => window.api.issuesGet(issueId));
      if (fresh) { setIssue(fresh); applyIssue(fresh); }
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const appendices = issue.appendices ?? [];
  const isDeleted = issue.deletedAt !== null;
  const isResolved = issue.status === 'resolved';
  const expansionSessionId =
    issue.sourceSessionId ?? issue.resolutionSessionId ?? 'issues';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-deck-border px-3 py-2">
        <h2 className="truncate text-sm font-medium text-deck-text" title={issue.id}>
          Issue · {issue.id.slice(0, 8)}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="text-xs text-deck-muted hover:text-deck-text"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto scrollbar-deck px-3 py-3">
        {opError && (
          <div className="rounded bg-status-waiting/15 px-2 py-1 text-xs text-status-waiting">
            {opError}
          </div>
        )}

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
            <DeckSelect
              value={editing.status}
              onChange={(next) => updateField('status', next)}
              disabled={isDeleted || saving}
              options={ISSUE_STATUS_OPTIONS}
              buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-xs text-deck-text outline-none disabled:opacity-50"
            />
          </Field>
          <Field label="严重度">
            <DeckSelect
              value={editing.severity}
              onChange={(next) => updateField('severity', next)}
              disabled={isDeleted || saving}
              options={ISSUE_SEVERITY_OPTIONS}
              buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-xs text-deck-text outline-none disabled:opacity-50"
            />
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
        <Field label="Issue 描述">
          {source ? (
            <IssueTextArea
              value={editing.description}
              onChange={(value) => updateField('description', value)}
              disabled={isDeleted || saving}
              maxLength={2000}
              rows={4}
            />
          ) : (
            <ExpandableIssueTextField
              issueId={issue.id}
              sessionId={expansionSessionId}
              field="description"
              label="Issue 描述"
              value={editing.description}
              onChange={(value) => updateField('description', value)}
              disabled={isDeleted || saving}
              maxLength={2000}
              rows={4}
            />
          )}
        </Field>
        <Field label="重现步骤（可选）">
          {source ? (
            <IssueTextArea
              value={editing.repro}
              onChange={(value) => updateField('repro', value)}
              disabled={isDeleted || saving}
              maxLength={2000}
              rows={3}
            />
          ) : (
            <ExpandableIssueTextField
              issueId={issue.id}
              sessionId={expansionSessionId}
              field="repro"
              label="重现步骤"
              value={editing.repro}
              onChange={(value) => updateField('repro', value)}
              disabled={isDeleted || saving}
              maxLength={2000}
              rows={3}
            />
          )}
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

        <div className="space-y-1 rounded bg-white/[0.03] px-2 py-2 text-[10px] text-deck-muted">
          <div>ID：{issue.id}</div>
          <div className="flex items-center gap-1">
            来源会话：{' '}
            {issue.sourceSessionId ? (
              <SessionLink sid={issue.sourceSessionId} onOpenSession={onOpenSession} />
            ) : (
              <em>原会话已被清理</em>
            )}
          </div>
          <div>工作目录：{issue.cwd ?? '—'}</div>
          <div>分支：{issue.branchName ?? '—'}</div>
          <div>
            创建：{new Date(issue.createdAt).toLocaleString('zh-CN', { hour12: false })} · 更新：{' '}
            {new Date(issue.updatedAt).toLocaleString('zh-CN', { hour12: false })}
          </div>
          {issue.resolvedAt && (
            <div>
              {isResolved ? '解决于' : '上次解决于'}：{' '}
              {new Date(issue.resolvedAt).toLocaleString('zh-CN', { hour12: false })}
            </div>
          )}
          {issue.deletedAt && (
            <div className="text-status-waiting">
              删除于：{new Date(issue.deletedAt).toLocaleString('zh-CN', { hour12: false })}
            </div>
          )}
          {issue.resolutionSessionId && (
            <div className="flex items-center gap-1">
              解决会话：{' '}
              <SessionLink sid={issue.resolutionSessionId} onOpenSession={onOpenSession} />
            </div>
          )}
        </div>

        {issue.logsRef && (
          <IssueLogsReference
            logsRef={issue.logsRef}
          />
        )}

        <IssueAppendices
          appendices={appendices}
          onOpenSession={onOpenSession}
        />
      </div>

      <div className="flex gap-1.5 border-t border-deck-border px-3 py-2">
        {!isDeleted && (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded bg-white/15 px-2 py-1 text-xs text-deck-text hover:bg-white/25 disabled:opacity-50"
          >
            <SaveIcon className="mr-1 inline h-3 w-3" />保存
          </button>
        )}
        <IssueResolutionControls
          issue={issue}
          saving={saving}
          source={source}
          onResolved={(updated) => {
            setIssue(updated);
            applyIssue(updated);
            rebaseEditing(updated);
          }}
        />
        <div className="flex-1" />
        {!isDeleted ? (
          <button
            type="button"
            onClick={() => void handleSoftDelete()}
            disabled={saving}
            className="rounded bg-status-waiting/25 px-2 py-1 text-xs text-status-waiting hover:bg-status-waiting/40 disabled:opacity-50"
          >
            <TrashIcon className="mr-1 inline h-3 w-3" />删除
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleUndelete()}
            disabled={saving}
            className="rounded bg-status-finished/25 px-2 py-1 text-xs text-status-finished hover:bg-status-finished/40 disabled:opacity-50"
          >
            <RefreshIcon className="mr-1 inline h-3 w-3" />恢复
          </button>
        )}
      </div>

    </div>
  );
}

function IssueTextArea({
  value,
  onChange,
  disabled,
  maxLength,
  rows,
}: {
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  maxLength: number;
  rows: number;
}): JSX.Element {
  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      maxLength={maxLength}
      rows={rows}
      className="w-full resize-y rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs leading-relaxed text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
    />
  );
}
