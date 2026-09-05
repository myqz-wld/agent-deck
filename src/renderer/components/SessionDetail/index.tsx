import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  AgentEvent,
  DiffPayload,
  FileFinalDiffResult,
  SessionRecord,
} from '@shared/types';
import type { BrowserStateSource } from '@shared/browser-view';
import { ActivityFeed } from '../activity-feed';
import { SummaryView } from '../SummaryView';
import { HandOffPreviewDialog } from '../HandOffPreviewDialog';
import { MessagesPanel } from './MessagesPanel';
import { SessionMetadataChips } from '../SessionMetadataChips';
import { SessionPinButton } from '../SessionPinButton';
import { CloseIcon } from '../icons';
import {
  useSessionStore,
} from '@renderer/stores/session-store';
import { SourceBadge } from './SourceBadge';
import { ComposerSdk } from './ComposerSdk';
import { CliFooter } from './CliFooter';
import { DiffTab } from './DiffTab';
import { TasksPanel } from './TasksPanel';
import { SessionContextUsageChip } from '../SessionContextUsageChip';
import { decodeBlob, groupFileChanges } from './helpers';
import { useFileChanges } from './use-file-changes';
import { useFileChangeSelection } from './use-file-change-selection';
import { useFileChangePayload } from './use-file-change-payload';
import { useSessionGitBranch } from '@renderer/hooks/use-session-git-branches';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RemoteSessionDetail } from './RemoteSessionDetail';
import {
  createSessionDetailTabs,
  SessionDetailShell,
  type SessionDetailTabModel,
  type SessionDetailTabId,
} from './SessionDetailShell';
import { IabPanel } from './IabPanel';
import { useBrowserState } from './use-browser-state';
import { useBrowserShowTab } from '@renderer/hooks/use-browser-show';
import {
  IabComposerBridgeProvider,
  unsupportedIabComposerTarget,
} from './iab-composer-bridge';

type DiffMode = 'single' | 'final';
const EMPTY_EVENTS_FOR_TOAST: AgentEvent[] = [];

interface LocalProps {
  session: SessionRecord;
  onClose: () => void;
}

interface RemoteProps {
  remoteSource: RemoteSessionSourceView;
  onClose: () => void;
}

export function SessionDetail(props: LocalProps | RemoteProps): JSX.Element {
  if ('remoteSource' in props) {
    return (
      <RemoteSessionDetail
        key={`${props.remoteSource.identity}:${props.remoteSource.selectedSessionId ?? 'none'}:${
          props.remoteSource.usable ? 'usable' : 'unavailable'
        }`}
        source={props.remoteSource}
        onClose={props.onClose}
      />
    );
  }
  return <LocalSessionDetail key={props.session.id} {...props} />;
}

function LocalSessionDetail({ session, onClose }: LocalProps): JSX.Element {
  const [tab, changeTab] = useState<SessionDetailTabId>('activity');
  const browserSource = useMemo<BrowserStateSource>(
    () => ({ kind: 'local', sessionId: session.id }),
    [session.id],
  );
  const browserState = useBrowserState(browserSource);
  const browserPresentationKey = useBrowserShowTab(
    session.id, browserState.snapshot, () => changeTab('browser'),
  );
  const [diffMode, setDiffMode] = useState<DiffMode>('single');
  const [finalDiff, setFinalDiff] = useState<FileFinalDiffResult | null>(null);
  const [finalDiffLoading, setFinalDiffLoading] = useState(false);
  const gitBranch = useSessionGitBranch(session);
  const fileChanges = useFileChanges({
    sessionId: session.id,
    enabled: tab === 'diff',
    workspaceKey: session.cwd,
  });
  const changes = fileChanges.changes;
  const selection = useFileChangeSelection({
    changes,
    sessionId: session.id,
    workspaceKey: session.cwd,
  });
  const selectedFilePath = selection.selectedFilePath;
  const selectedChangeId = selection.selectedChangeId;
  const selectedFileChange = useFileChangePayload({
    sessionId: session.id,
    selectedChangeId,
    workspaceKey: session.cwd,
  });
  const [handOffOpen, setHandOffOpen] = useState(false);
  /** 最近被 SDK 自动取消的权限/提问，用于 toast 提示「不是你做的，是 SDK 取消的」。 */
  const [cancelToasts, setCancelToasts] = useState<{ id: string; text: string; ts: number }[]>([]);
  // Toast timer 按 id 独立管理，后续事件刷新不会提前取消自动关闭。
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissToast = (id: string): void => {
    setCancelToasts((prev) => prev.filter((t) => t.id !== id));
    const tm = toastTimersRef.current.get(id);
    if (tm) {
      clearTimeout(tm);
      toastTimersRef.current.delete(id);
    }
  };
  // 卸载时清掉所有挂起的 toast timer（防 setState on unmounted）。
  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const tm of timers.values()) clearTimeout(tm);
      timers.clear();
    };
  }, []);

  const recent = useSessionStore(
    (s) => s.recentEventsBySession.get(session.id) ?? EMPTY_EVENTS_FOR_TOAST,
  );

  // SDK 自动取消权限、提问或计划批准时显示 5 秒提示。
  useEffect(() => {
    const e = recent[0];
    if (!e || e.kind !== 'waiting-for-user') return;
    const p = (e.payload ?? {}) as { type?: string; requestId?: string };
    if (
      p.type !== 'permission-cancelled' &&
      p.type !== 'ask-question-cancelled' &&
      p.type !== 'exit-plan-cancelled'
    ) {
      return;
    }
    const id = `${e.ts}-${p.requestId ?? ''}`;
    // 已有该 toast（含已注册 timer）→ 不重复加、不重设 timer。
    if (toastTimersRef.current.has(id)) return;
    const kindLabel =
      p.type === 'permission-cancelled'
        ? '权限请求'
        : p.type === 'ask-question-cancelled'
          ? '提问'
          : '计划批准请求';
    const text = `已取消一条${kindLabel}`;
    setCancelToasts((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, text, ts: e.ts }]));
    const timer = setTimeout(() => {
      setCancelToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimersRef.current.delete(id);
    }, 5000);
    toastTimersRef.current.set(id, timer);
  }, [recent]);

  useEffect(() => {
    setDiffMode('single');
    setFinalDiff(null);
    setFinalDiffLoading(false);
    // 组件切换会话时不会 remount，因此同步清空上一会话的提示和 timer。
    setCancelToasts([]);
    for (const tm of toastTimersRef.current.values()) clearTimeout(tm);
    toastTimersRef.current.clear();
  }, [session.id]);

  useEffect(() => {
    setDiffMode('single');
    setFinalDiff(null);
    setFinalDiffLoading(false);
  }, [session.id, session.cwd]);

  // 按文件分组：组内升序（旧→新）+ 文件按最近改动倒序，同毫秒带 id tiebreaker（详 groupFileChanges）。
  const fileGroups = useMemo(() => (changes ? groupFileChanges(changes) : []), [changes]);

  const selectedGroup = useMemo(
    () => fileGroups.find((g) => g.filePath === selectedFilePath) ?? null,
    [fileGroups, selectedFilePath],
  );

  const selectedChange =
    selectedFileChange.selectedPayload?.id === selectedChangeId
      ? selectedFileChange.selectedPayload
      : null;
  const selectedGroupLastId = selectedGroup?.lastId ?? null;

  useEffect(() => {
    if (tab !== 'diff' || diffMode !== 'final' || !selectedFilePath) return;
    let disposed = false;
    setFinalDiffLoading(true);
    setFinalDiff(null);
    void window.api
      .getFileFinalDiff(session.id, selectedFilePath)
      .then((r) => {
        if (disposed) return;
        setFinalDiff(r);
      })
      .catch(() => {
        if (disposed) return;
        setFinalDiff({
          ok: false,
          filePath: selectedFilePath,
          diff: null,
          source: 'recorded-snapshot',
          reason: 'snapshot_unavailable',
          message: '无法加载最终 diff。',
        });
      })
      .finally(() => {
        if (!disposed) setFinalDiffLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [tab, diffMode, session.id, selectedFilePath, selectedGroupLastId]);

  const diffPayload: DiffPayload | null = selectedChange
    ? {
        kind: selectedChange.kind,
        filePath: selectedChange.filePath,
        before: decodeBlob(
          selectedChange.kind,
          selectedChange.beforeSnapshot ?? selectedChange.beforeBlob,
        ),
        after: decodeBlob(
          selectedChange.kind,
          selectedChange.afterSnapshot ?? selectedChange.afterBlob,
        ),
        metadata: selectedChange.metadata,
        toolCallId: selectedChange.toolCallId ?? undefined,
        ts: selectedChange.ts,
      }
    : null;
  const finalDiffPayload: DiffPayload | null =
    finalDiff?.ok && finalDiff.diff
      ? {
          kind: 'text',
          filePath: finalDiff.filePath,
          before: null,
          after: null,
          metadata: { source: finalDiff.source, diff: finalDiff.diff },
          ts: selectedGroup?.lastTs ?? 0,
        }
      : null;

  const isSdk = session.source === 'sdk';
  const turnBusy = session.activity === 'working';
  const canSteerTurn = session.agentId === 'codex-cli' || session.agentId === 'grok-build';
  const canSteerTurnAttachments =
    session.agentId === 'codex-cli' || session.agentId === 'grok-build';
  const canPin =
    session.archivedAt === null &&
    (session.lifecycle === 'active' || session.lifecycle === 'dormant');
  const selectFileGroup = (group: NonNullable<typeof selectedGroup>): void => {
    selection.selectFile(group.filePath, group.items[group.items.length - 1].id);
    setFinalDiff(null);
  };
  const baseTabs = createSessionDetailTabs({
    activity: <ActivityFeed sessionId={session.id} agentId={session.agentId} isSdk={isSdk} />,
    tasks: <TasksPanel sessionId={session.id} />,
    diff: (
        <DiffTab
          sessionId={session.id}
          changes={changes}
          diffError={fileChanges.error}
          hasMore={fileChanges.hasMore}
          loadedCount={fileChanges.loadedCount}
          loadingMore={fileChanges.loadingMore}
          lastLoadSummary={fileChanges.lastLoadSummary}
          hasNewerChanges={selection.hasNewerChanges}
          payloadLoading={selectedFileChange.payloadLoading}
          payloadError={selectedFileChange.payloadError}
          fileGroups={fileGroups}
          selectedFilePath={selectedFilePath}
          selectedGroup={selectedGroup}
          selectedChangeId={selectedChangeId}
          diffMode={diffMode}
          finalDiffLoading={finalDiffLoading}
          finalDiff={finalDiff}
          diffPayload={diffPayload}
          finalDiffPayload={finalDiffPayload}
          onSelectFile={selectFileGroup}
          onSelectChange={(id) => { selection.selectChange(id); setDiffMode('single'); }}
          onDiffModeChange={setDiffMode}
          onLoadMore={() => void fileChanges.loadMore()}
          onFollowLatest={() => { selection.followLatest(); setDiffMode('single'); setFinalDiff(null); }}
          onRetry={() => void fileChanges.retry()}
        />
      ),
    summary: <SummaryView sessionId={session.id} />,
    messages: <MessagesPanel sessionId={session.id} />,
  });
  const tabs: readonly SessionDetailTabModel[] = browserState.snapshot == null
    ? baseTabs
    : [
        ...baseTabs,
        {
          id: 'browser',
          label: 'IAB',
          fullBleed: true,
          content: (
            <IabPanel
              key={browserPresentationKey}
              source={browserSource}
              snapshot={browserState.snapshot}
            />
          ),
        },
      ];
  useEffect(() => {
    if (tab === 'browser' && browserState.snapshot == null) changeTab('activity');
  }, [browserState.snapshot, tab]);
  const notice = cancelToasts.length > 0
    ? (
        <div className="shrink-0 border-b border-deck-border/40 bg-white/[0.03] px-3 py-1.5">
          {cancelToasts.map((toast) => (
            <div key={toast.id} className="flex items-center gap-1.5 text-[10px] text-deck-muted">
              <span>⚪</span><span className="flex-1">{toast.text}</span>
              <button type="button" onClick={() => dismissToast(toast.id)} className="text-deck-muted/60 hover:text-deck-text" aria-label="关闭">
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )
    : undefined;
  const iabComposerFallback = useMemo(
    () => isSdk
      ? undefined
      : unsupportedIabComposerTarget(
          `local:${session.id}`,
          '此会话来自外部终端，Agent Deck 无法向它添加图片消息，因此不提供 IAB 标注。',
        ),
    [isSdk, session.id],
  );
  return (
    <IabComposerBridgeProvider fallback={iabComposerFallback}>
      <SessionDetailShell
        title={session.title}
        sourceBadge={<SourceBadge isSdk={isSdk} />}
        subtitle={session.cwd}
        metadata={<><SessionMetadataChips session={session} branch={gitBranch} compact /><SessionContextUsageChip session={session} /></>}
        headerActions={canPin ? <SessionPinButton key={session.id} session={session} /> : undefined}
        notice={notice}
        tabs={tabs}
        activeTab={tab}
        onTabChange={changeTab}
        composer={isSdk
          ? <ComposerSdk session={session} onHandOff={() => setHandOffOpen(true)} turnBusy={turnBusy} canSteerTurn={canSteerTurn} canSteerTurnAttachments={canSteerTurnAttachments} />
          : <CliFooter agentId={session.agentId} />}
        overlay={<HandOffPreviewDialog open={handOffOpen} session={session} onClose={() => setHandOffOpen(false)} />}
        onClose={onClose}
      />
    </IabComposerBridgeProvider>
  );
}
