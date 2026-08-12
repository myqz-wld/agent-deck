import { useEffect, useMemo, useState, type JSX } from 'react';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import type { RemoteHostSessionPresentationDto } from '@shared/remote-host';
import { useRemoteSessionTabData } from '@renderer/remote-host/use-remote-session-tab-data';
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
import { RemoteEffectivePermissionsView } from './RemoteEffectivePermissionsView';
import { SessionMessagesView } from './MessagesPanel';

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
  const presentation = session
    ? [...(source.sessions ?? []), ...(source.historySessions ?? [])]
        .find((item) => item.id === session.id) ?? null
    : null;
  const tabData = useRemoteSessionTabData(source, tab);

  useEffect(() => {
    setTab('activity');
    setHandOffOpen(false);
  }, [session?.id, source.identity]);

  useEffect(() => setHandOffNotice(null), [source.identity]);

  const canReadEvents = source.capabilities.has('events.replay');
  const canReadSummaries = source.capabilities.has('sessions.summaries.read');
  const canReadFileChanges = source.capabilities.has('sessions.file-changes.read');
  const canReadTasks = source.capabilities.has('tasks');
  const canReadMessages = source.capabilities.has('sessions.messages.read');
  const canReadPermissions = source.capabilities.has('sessions.permissions.read');
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
    {
      id: 'messages',
      label: '跨会话',
      content: (
        <SessionMessagesView
          sessionId={session?.id ?? ''}
          messages={tabData.messages.value?.messages ?? []}
          loaded={tabData.messages.value !== null || tabData.messages.error !== null}
          error={tabData.messages.error}
          truncated={tabData.messages.value?.truncated ?? false}
        />
      ),
      unavailableReason: canReadMessages
        ? undefined
        : '此远程 Core 未提供安全的跨会话消息投影；不会回退读取本地消息数据库。',
    },
    {
      id: 'permissions',
      label: '权限',
      content: (
        <RemoteEffectivePermissionsView
          data={tabData.permissions.value}
          loading={tabData.permissions.loading}
          error={tabData.permissions.error}
          onRefresh={tabData.refreshPermissions}
        />
      ),
      unavailableReason: canReadPermissions
        ? undefined
        : '此远程 Core 未提供无路径、无配置原文的生效权限投影；不会扫描 Worker 配置文件。',
    },
  ], [
    canReadEvents, canReadFileChanges,
    canReadMessages, canReadPermissions, canReadSummaries, canReadTasks,
    session?.id, source, tabData,
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
      sourceBadge={<span className="rounded bg-blue-500/15 px-1 py-0.5 text-[9px] text-blue-200">Remote · {presentation?.source === 'cli' ? 'CLI' : 'SDK'}</span>}
      subtitle={`${source.profile?.label ?? '远程主机'} · ${presentation?.workspaceLabel ?? 'Worker 工作区'}`}
      metadata={<RemoteSessionMetadata source={source} presentation={presentation} />}
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

function RemoteSessionMetadata({
  source,
  presentation,
}: {
  source: RemoteSessionSourceView;
  presentation: RemoteHostSessionPresentationDto | null;
}): JSX.Element {
  const values = source.runtime?.values;
  const model = typeof values?.model === 'string' ? values.model : presentation?.model ?? null;
  const thinking = typeof values?.thinking === 'string'
    ? values.thinking : presentation?.thinking ?? null;
  return (
    <>
      <RuntimeMetadataChips model={model} thinking={thinking} compact />
      {source.capabilities.has('sessions.context.read') && source.selectedSession
        ? source.contextLoadError
          ? <SessionContextUnavailableChip reason={source.contextLoadError} />
          : (
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
  const state = source.state?.status;
  const copy = source.recoveringWorker
    ? {
        title: 'Remote Worker 当前离线',
        detail: '连接保留用于受控恢复；恢复前不会发送会话读取或写入请求。',
      }
    : state === 'reconnecting'
      ? {
          title: 'Remote SSH 正在重连',
          detail: '重连完成并重新确认 Core 身份后才能读取此会话。',
        }
      : state === 'connecting'
        ? {
            title: '正在连接 Remote Core',
            detail: '完成协议协商和 Worker 身份确认后才能读取此会话。',
          }
        : state === 'offline'
          ? {
              title: 'Remote 当前未连接',
              detail: '此会话仍保持选中；重新连接后会按同一 Remote 身份重新读取。',
            }
          : state === 'incompatible'
            ? {
                title: 'Remote 协议不兼容',
                detail: '请升级 Remote Core；不会回退读取本机会话数据。',
              }
            : {
                title: '正在读取远程 session…',
                detail: '正在确认当前 Remote 会话身份。',
              };
  const tabs: readonly SessionDetailTabModel[] = [{
    id: 'activity',
    label: '活动',
    content: <div className="py-10 text-center text-[10px] text-deck-muted">{copy.detail}</div>,
  }];
  return (
    <SessionDetailShell
      title={copy.title}
      sourceBadge={<span className="rounded bg-blue-500/15 px-1 py-0.5 text-[9px] text-blue-200">Remote</span>}
      subtitle={source.profile?.label ?? '远程主机'}
      tabs={tabs}
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
