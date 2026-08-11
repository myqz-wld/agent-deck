import { useEffect, useMemo, useState, type JSX } from 'react';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RuntimeMetadataChips } from '../SessionMetadataChips';
import {
  SessionContextUnavailableChip,
  SessionContextUsageChip,
} from '../SessionContextUsageChip';
import { ActivityRecordsView } from '../activity-feed';
import { SummaryRecordsView } from '../SummaryView';
import { RemoteDiffPanel } from './RemoteDiffPanel';
import { TaskRecordsView } from './TasksPanel';
import {
  SessionDetailShell,
  type SessionDetailTabId,
  type SessionDetailTabModel,
} from './SessionDetailShell';
import { RemoteSessionComposer } from './RemoteSessionComposer';
import { RemoteHandOffDialog } from './RemoteHandOffDialog';

const UNSUPPORTED = {
  messages: '当前远程 Session Console 协议未提供跨会话消息。',
  permissions: '远程审批统一显示在“待处理”中，并由远端 Core 做权威校验。',
} as const;
const LOADING_TABS: readonly SessionDetailTabModel[] = [{
  id: 'activity',
  label: '活动',
  content: <div className="py-10 text-center text-[10px] text-deck-muted">正在读取远程 session…</div>,
}];

interface HandOffNotice {
  sessionId: string;
  text: string;
}

export function RemoteSessionDetail({
  source,
  onClose,
}: {
  source: RemoteSessionSourceView;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<SessionDetailTabId>('activity');
  const [handOffOpen, setHandOffOpen] = useState(false);
  const [handOffNotice, setHandOffNotice] = useState<HandOffNotice | null>(null);
  const session = source.selectedSession?.id === source.selectedSessionId
    ? source.selectedSession
    : null;

  useEffect(() => {
    setTab('activity');
    setHandOffOpen(false);
  }, [session?.id, source.identity]);

  useEffect(() => setHandOffNotice(null), [source.identity]);

  const canReadEvents = source.capabilities.has('events.replay');
  const canReadSummaries = source.capabilities.has('sessions.summaries.read');
  const canReadFileChanges = source.capabilities.has('sessions.file-changes.read');
  const canReadTasks = source.capabilities.has('tasks');
  const tabs = useMemo<readonly SessionDetailTabModel[]>(() => [
    {
      id: 'activity',
      label: '活动',
      unavailableReason: canReadEvents
        ? undefined
        : '此远程 Core 未提供活动事件读取能力；不会回退读取本地事件。',
      content: (
        <ActivityRecordsView
          events={source.events?.events ?? []}
          loaded={source.events !== null}
          loadError={source.eventLoadError}
          sessionId={session?.id ?? ''}
          agentId={session?.adapterId ?? 'remote'}
          isSdk
          allowLocalAssets={false}
          interactivePending={false}
          truncated={source.events?.truncated ?? false}
        />
      ),
    },
    {
      id: 'tasks',
      label: '任务',
      content: (
        <TaskRecordsView
          tasks={source.tasks?.tasks ?? []}
          loaded={source.tasks !== null}
          error={source.taskLoadError}
        />
      ),
      unavailableReason: canReadTasks
        ? undefined
        : '此远程 Core 未提供任务读取能力；不会回退读取本地任务。',
    },
    {
      id: 'diff',
      label: '改动',
      content: <RemoteDiffPanel source={source} />,
      unavailableReason: canReadFileChanges
        ? undefined
        : '此远程 Core 未提供文件改动读取能力；不会回退读取本地工作区。',
    },
    {
      id: 'summary',
      label: '总结',
      content: (
        <SummaryRecordsView
          summaries={source.summaries?.summaries ?? []}
          loaded={source.summaries !== null}
          loadError={source.summaryLoadError ?? null}
        />
      ),
      unavailableReason: canReadSummaries
        ? undefined
        : '此远程 Core 未提供会话总结读取能力。',
    },
    { id: 'messages', label: '跨会话', content: null, unavailableReason: UNSUPPORTED.messages },
    { id: 'permissions', label: '权限', content: null, unavailableReason: UNSUPPORTED.permissions },
  ], [
    canReadEvents, canReadFileChanges,
    canReadSummaries, canReadTasks, session?.id, source,
  ]);

  if (!session) {
    return <RemoteDetailLoading source={source} onClose={onClose} />;
  }

  const banner = source.state?.status === 'reconnecting' || source.recoveringWorker
    ? (
        <div role="status" className="border-b border-amber-400/15 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-100">
          {source.recoveringWorker
            ? '远程执行节点当前离线；连接保留用于恢复探测。'
            : 'SSH 正在重连；当前操作仍受主进程 deadline 和数据源 epoch 保护。'}
        </div>
      )
    : undefined;
  const alertText = handOffNotice?.sessionId === session.id
    ? handOffNotice.text
    : source.error;
  const alert = alertText
    ? <div role="alert" className="border-t border-red-400/15 bg-red-500/10 px-3 py-1.5 text-[10px] text-red-200">{alertText}</div>
    : undefined;
  return (
    <SessionDetailShell
      title={session.title ?? '未命名 session'}
      sourceBadge={<span className="rounded bg-blue-500/15 px-1 py-0.5 text-[9px] text-blue-200">Remote</span>}
      subtitle={`${source.profile?.label ?? '远程主机'} · Worker 工作区`}
      metadata={<RemoteSessionMetadata source={source} />}
      banner={banner}
      tabs={tabs}
      activeTab={tab}
      onTabChange={setTab}
      alert={alert}
      composer={(
        <RemoteSessionComposer
          source={source}
          adapterId={session.adapterId}
          sessionId={session.id}
          onHandOff={() => { setHandOffNotice(null); setHandOffOpen(true); }}
        />
      )}
      overlay={handOffOpen ? (
        <RemoteHandOffDialog
          source={source}
          sessionId={session.id}
          onClose={() => setHandOffOpen(false)}
          onCommitted={(result) => {
            setHandOffOpen(false);
            setHandOffNotice(result.sourceFinalizationWarning
              ? { sessionId: result.successorSessionId, text: result.sourceFinalizationWarning }
              : null);
            source.selectSession(result.successorSessionId);
          }}
        />
      ) : undefined}
      onClose={onClose}
    />
  );
}

function RemoteSessionMetadata({ source }: { source: RemoteSessionSourceView }): JSX.Element {
  const values = source.runtime?.values;
  const model = typeof values?.model === 'string' ? values.model : null;
  const thinking = typeof values?.thinking === 'string' ? values.thinking : null;
  return (
    <>
      <RuntimeMetadataChips model={model} thinking={thinking} compact />
      {source.capabilities.has('sessions.context.read') && source.selectedSession
        ? (
            <SessionContextUsageChip session={{
              agentId: source.selectedSession.adapterId,
              contextUsage: source.context?.contextUsage ?? null,
            }} />
          )
        : (
            <SessionContextUnavailableChip reason="此 Remote Core 未提供可归属到 Worker runtime identity 的上下文窗口快照；不会回退显示本机会话数据。" />
          )}
    </>
  );
}

function RemoteDetailLoading({
  source,
  onClose,
}: {
  source: RemoteSessionSourceView;
  onClose: () => void;
}): JSX.Element {
  return (
    <SessionDetailShell
      title="正在读取远程 session…"
      sourceBadge={<span className="rounded bg-blue-500/15 px-1 py-0.5 text-[9px] text-blue-200">Remote</span>}
      subtitle={source.profile?.label ?? '远程主机'}
      tabs={LOADING_TABS}
      activeTab="activity"
      onTabChange={() => undefined}
      alert={source.error
        ? <div role="alert" className="border-t border-red-400/15 bg-red-500/10 px-3 py-1.5 text-[10px] text-red-200">{source.error}</div>
        : undefined}
      composer={<div className="shrink-0 border-t border-deck-border p-2 text-center text-[10px] text-deck-muted">等待当前远程 session 完成身份校验后才能操作。</div>}
      onClose={onClose}
    />
  );
}
