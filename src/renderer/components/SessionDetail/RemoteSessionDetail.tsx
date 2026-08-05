import { useEffect, useMemo, useState, type JSX } from 'react';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RemotePendingRequests } from '../pending-rows/RemotePendingRequests';
import {
  SessionDetailShell,
  SessionPendingPanel,
  SessionRuntimePanel,
  SessionTextComposer,
  type SessionDetailTabId,
  type SessionDetailTabModel,
} from './SessionDetailShell';

const UNSUPPORTED = {
  tasks: '当前远程 Session Console 协议未提供任务明细；不会回退读取本地数据。',
  diff: '当前远程 Session Console 协议未提供文件改动；不会回退读取本地工作区。',
  summary: '当前远程 Session Console 协议未提供本地总结视图。',
  messages: '当前远程 Session Console 协议未提供跨会话消息。',
  permissions: '远程审批统一显示在“待处理”中，并由远端 Core 做权威校验。',
} as const;
const LOADING_TABS: readonly SessionDetailTabModel[] = [{
  id: 'activity',
  label: '活动',
  content: <div className="py-10 text-center text-[10px] text-deck-muted">正在读取远程 session…</div>,
}];

export function RemoteSessionDetail({
  source,
  onClose,
}: {
  source: RemoteSessionSourceView;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<SessionDetailTabId>('activity');
  const [localError, setLocalError] = useState<string | null>(null);
  const session = source.selectedSession?.id === source.selectedSessionId
    ? source.selectedSession
    : null;

  useEffect(() => {
    setTab('activity');
    setLocalError(null);
  }, [session?.id, source.identity]);

  const canReadHistory = source.capabilities.has('sessions.history');
  const canReadPending = source.capabilities.has('pending.read');
  const canReadRuntime = source.capabilities.has('sessions.runtime.read');
  const canWriteRuntime = source.capabilities.has('sessions.runtime.write');
  const canWrite = source.capabilities.has('sessions.write');
  const tabs = useMemo<readonly SessionDetailTabModel[]>(() => [
    {
      id: 'activity',
      label: '活动',
      unavailableReason: canReadHistory ? undefined : '此远程 Core 未提供历史读取能力。',
      content: <RemoteHistory source={source} />,
    },
    { id: 'tasks', label: '任务', content: null, unavailableReason: UNSUPPORTED.tasks },
    { id: 'diff', label: '改动', content: null, unavailableReason: UNSUPPORTED.diff },
    { id: 'summary', label: '总结', content: null, unavailableReason: UNSUPPORTED.summary },
    { id: 'messages', label: '跨会话', content: null, unavailableReason: UNSUPPORTED.messages },
    {
      id: 'pending',
      label: '待处理',
      unavailableReason: canReadPending ? undefined : '此远程 Core 未提供待处理请求读取能力。',
      content: (
        <SessionPendingPanel>
          <RemotePendingRequests
            pending={source.selectedPending ?? { requests: [], revision: 0 }}
            sourceIdentity={source.identity}
            busy={source.busy}
            onRespond={source.respondPending}
          />
        </SessionPendingPanel>
      ),
    },
    {
      id: 'runtime',
      label: '运行时',
      unavailableReason: canReadRuntime ? undefined : '此远程 Core 未提供运行时读取能力。',
      content: (
        <SessionRuntimePanel
          identity={`${source.identity}:${session?.id ?? ''}`}
          values={source.runtime?.values ?? null}
          busy={source.busy}
          canWrite={canWriteRuntime}
          onApply={source.updateRuntime}
          onError={setPublicError}
        />
      ),
    },
    { id: 'permissions', label: '权限', content: null, unavailableReason: UNSUPPORTED.permissions },
  ], [canReadHistory, canReadPending, canReadRuntime, canWriteRuntime, session?.id, source]);

  if (!session) {
    return <RemoteDetailLoading source={source} onClose={onClose} />;
  }

  const topology = source.profile?.topology === 'relay' ? 'Relay' : 'Server Core';
  const banner = source.state?.status === 'reconnecting' || source.recoveringWorker
    ? (
        <div role="status" className="border-b border-amber-400/15 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-100">
          {source.recoveringWorker
            ? 'Relay 后的本机 Worker 当前离线；保留 SSH 通道用于恢复探测。'
            : 'SSH 正在重连；当前操作仍受主进程 deadline 和数据源 epoch 保护。'}
        </div>
      )
    : undefined;
  const alert = localError || source.error
    ? <div role="alert" className="border-t border-red-400/15 bg-red-500/10 px-3 py-1.5 text-[10px] text-red-200">{localError ?? source.error}</div>
    : undefined;
  return (
    <SessionDetailShell
      title={session.title ?? '未命名 session'}
      sourceBadge={<span className="rounded bg-blue-500/15 px-1 py-0.5 text-[9px] text-blue-200">Remote</span>}
      subtitle={`${source.profile?.label ?? '远程主机'} · ${topology}`}
      metadata={<span className="text-[9px] text-deck-muted">{session.adapterId} · {session.status}</span>}
      banner={banner}
      tabs={tabs}
      activeTab={tab}
      onTabChange={setTab}
      alert={alert}
      composer={(
        <SessionTextComposer
          identity={`${source.identity}:${session.id}`}
          busy={source.busy}
          canWrite={canWrite}
          onSend={source.send}
          onSteer={source.steer}
          onInterrupt={source.interrupt}
          onError={setPublicError}
        />
      )}
      onClose={onClose}
    />
  );

  function setPublicError(reason: unknown): void {
    setLocalError(reason instanceof Error ? reason.message : String(reason));
  }
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

function RemoteHistory({ source }: { source: RemoteSessionSourceView }): JSX.Element {
  const entries = source.history?.entries;
  if (!entries) return <Empty text="正在读取远程历史…" />;
  if (entries.length === 0) return <Empty text="暂无历史消息" />;
  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <article
          key={`${source.identity}:${entry.id}`}
          className={`rounded border p-2 text-[10px] ${entry.role === 'user' ? 'ml-8 border-blue-400/20 bg-blue-500/10' : 'mr-8 border-white/8 bg-white/[0.03]'}`}
        >
          <div className="mb-1 text-[9px] uppercase text-deck-muted">{entry.role} · #{entry.sequence}</div>
          <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed">
            {typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content, null, 2)}
          </pre>
        </article>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }): JSX.Element {
  return <div className="py-10 text-center text-[10px] text-deck-muted">{text}</div>;
}
