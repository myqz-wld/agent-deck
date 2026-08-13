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
  createSessionDetailTabs,
  SessionDetailShell,
  type SessionDetailTabId,
} from './SessionDetailShell';
import { useDelayedTabSelection } from './use-delayed-tab-selection';
import { RemoteSessionComposer } from './RemoteSessionComposer';
import { RemoteHandOffDialog } from './RemoteHandOffDialog';
import { PermissionsViewContent } from '../PermissionsView';
import { SessionMessagesView } from './MessagesPanel';
import { SourceBadge } from './SourceBadge';
import { SessionPinControl } from '../SessionPinButton';
import { RemotePendingRequestRow } from '../pending-rows/RemotePendingRequests';

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
  const [handOffOpen, setHandOffOpen] = useState(false);
  const [handOffNotice, setHandOffNotice] = useState<HandOffNotice | null>(null);
  const session = source.selectedSession?.id === source.selectedSessionId
    ? source.selectedSession
    : null;
  const presentation = session
    ? [...(source.sessions ?? []), ...(source.historySessions ?? [])]
        .find((item) => item.id === session.id) ?? null
    : null;
  const detailIdentity = `${source.identity}\u0000${session?.id ?? 'none'}`;
  const [requestedTabState, setRequestedTabState] = useState<{
    identity: string;
    tab: SessionDetailTabId;
  }>({ identity: detailIdentity, tab: 'activity' });
  const requestedTab = requestedTabState.identity === detailIdentity
    ? requestedTabState.tab
    : 'activity';
  const tabData = useRemoteSessionTabData(source, requestedTab);

  useEffect(() => {
    setRequestedTabState({ identity: detailIdentity, tab: 'activity' });
    setHandOffOpen(false);
  }, [detailIdentity]);

  useEffect(() => setHandOffNotice(null), [source.identity]);

  const canReadEvents = source.capabilities.has('events.replay');
  const canReadSummaries = source.capabilities.has('sessions.summaries.read');
  const canReadFileChanges = source.capabilities.has('sessions.file-changes.read');
  const canReadTasks = source.capabilities.has('tasks');
  const canReadMessages = source.capabilities.has('sessions.messages.read');
  const canReadPermissions = source.capabilities.has('sessions.permissions.read');
  const permissionsReady = tabData.permissions.value !== null || tabData.permissions.error !== null;
  const {
    activeTab: tab,
    selectTab,
  } = useDelayedTabSelection({
    canDefer: canReadPermissions && source.usable,
    deferredTab: 'permissions',
    identity: detailIdentity,
    ready: permissionsReady,
  });

  const changeTab = (next: SessionDetailTabId): void => {
    setRequestedTabState({ identity: detailIdentity, tab: next });
    selectTab(next);
  };
  const tabs = useMemo(() => createSessionDetailTabs({
    activity: (
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
          renderPendingEvent={(event) => {
            const payload = event.payload as { requestId?: unknown } | null;
            const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null;
            const pending = source.selectedPending;
            const request = requestId
              ? pending?.requests.find((candidate) => candidate.id === requestId)
              : undefined;
            if (!pending || !request) return undefined;
            return (
              <RemotePendingRequestRow
                request={request}
                revision={pending.revision}
                sourceIdentity={source.identity}
                agentId={session?.adapterId ?? 'remote'}
                busy={source.busy}
                onRespond={source.respondPending}
                planReviewTransport={source.planReviewTransport}
              />
            );
          }}
        />
      ),
    tasks: (
        <TaskRecordsView
          tasks={source.tasks?.tasks ?? []}
          loaded={source.tasks !== null}
          error={source.taskLoadError}
        />
      ),
    diff: <RemoteDiffPanel source={source} />,
    summary: (
        <SummaryRecordsView
          summaries={source.summaries?.summaries ?? []}
          loaded={source.summaries !== null}
          loadError={source.summaryLoadError ?? null}
        />
      ),
    messages: (
        <SessionMessagesView
          sessionId={session?.id ?? ''}
          messages={tabData.messages.value?.messages ?? []}
          loaded={tabData.messages.value !== null || tabData.messages.error !== null}
          error={tabData.messages.error}
          truncated={tabData.messages.value?.truncated ?? false}
        />
      ),
    permissions: (
        <PermissionsViewContent
          agentId={session?.adapterId ?? 'remote'}
          remoteState={{
            data: tabData.permissions.value,
            loading: tabData.permissions.loading,
            error: tabData.permissions.error,
            refresh: tabData.refreshPermissions,
          }}
        />
      ),
  }, {
    ...(!canReadEvents ? { activity: '当前版本暂不支持查看活动。' } : {}),
    ...(!canReadTasks ? { tasks: '当前版本暂不支持查看任务。' } : {}),
    ...(!canReadFileChanges ? { diff: '当前版本暂不支持查看改动。' } : {}),
    ...(!canReadSummaries ? { summary: '当前版本暂不支持查看总结。' } : {}),
    ...(!canReadMessages ? { messages: '当前版本暂不支持查看跨会话消息。' } : {}),
    ...(!canReadPermissions ? { permissions: '当前版本暂不支持查看权限。' } : {}),
  }), [
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
            ? '远程服务暂时离线，恢复后会自动继续。'
            : '正在重新连接，恢复后可继续查看和操作。'}
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
      title={session.title ?? '未命名会话'}
      sourceBadge={<SourceBadge isSdk={presentation?.source !== 'cli'} />}
      subtitle={`${source.profile?.label ?? '远程主机'} · ${presentation?.workspaceLabel ?? '远程工作区'}`}
      metadata={<RemoteSessionMetadata source={source} presentation={presentation} />}
      headerActions={<SessionPinControl pinned={presentation?.pinned ?? false} disabled disabledReason="远程会话暂不支持修改置顶状态" />}
      banner={banner}
      tabs={tabs}
      activeTab={tab}
      onTabChange={changeTab}
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
      <RuntimeMetadataChips
        adapterId={presentation?.adapterId}
        runtimeProvider={presentation?.runtimeProvider}
        model={model}
        thinking={thinking}
        compact
      />
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
            <SessionContextUnavailableChip reason="当前暂时无法读取上下文用量。" />
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
        title: '远程服务暂时离线',
        detail: '恢复后会自动重新读取当前会话。',
      }
    : state === 'reconnecting'
      ? {
          title: '正在重新连接',
          detail: '连接恢复后会自动重新读取当前会话。',
        }
      : state === 'connecting'
        ? {
            title: '正在连接远程服务',
            detail: '连接完成后即可查看和操作此会话。',
          }
        : state === 'offline'
          ? {
              title: '远程服务未连接',
              detail: '当前会话会保持选中，重新连接后自动恢复。',
            }
          : state === 'incompatible'
            ? {
                title: '远程版本不兼容',
                detail: '请更新远程服务后重试。',
              }
            : {
                title: '正在读取远程会话…',
                detail: '请稍候。',
              };
  const placeholder = <div className="py-10 text-center text-[10px] text-deck-muted">{copy.detail}</div>;
  const tabs = createSessionDetailTabs({
    activity: placeholder,
    tasks: placeholder,
    diff: placeholder,
    summary: placeholder,
    messages: placeholder,
    permissions: placeholder,
  });
  return (
    <SessionDetailShell
      title={copy.title}
      sourceBadge={<SourceBadge isSdk />}
      subtitle={source.profile?.label ?? '远程主机'}
      tabs={tabs}
      activeTab="activity"
      onTabChange={() => undefined}
      alert={source.error
        ? <div role="alert" className="border-t border-red-400/15 bg-red-500/10 px-3 py-1.5 text-[10px] text-red-200">{source.error}</div>
        : undefined}
      composer={<div className="shrink-0 border-t border-deck-border p-2 text-center text-[10px] text-deck-muted">会话恢复后即可继续操作。</div>}
      onClose={onClose}
    />
  );
}
