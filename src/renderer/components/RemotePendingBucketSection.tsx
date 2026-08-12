import { useRef, useState, type JSX, type MouseEvent } from 'react';

import type { RemoteHostPendingIndexBucketDto } from '@shared/remote-host';
import { deriveTeamRole } from '@renderer/lib/derive-team-role';
import { remotePendingPresentation } from '@renderer/remote-host/remote-pending-presentation';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { StatusBadge } from './StatusBadge';
import { CheckIcon, CloseIcon, CrownIcon, ShieldIcon, UsersIcon } from './icons';
import { RemotePendingRequests } from './pending-rows/RemotePendingRequests';
import { agentIdLabel } from './TeamDetail/helpers';

export function RemotePendingBucketSection({
  bucket,
  source,
  onOpenSession,
}: {
  bucket: RemoteHostPendingIndexBucketDto;
  source: RemoteSessionSourceView;
  onOpenSession(sessionId: string): void;
}): JSX.Element {
  const { session, pending } = bucket;
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const operationRef = useRef(0);
  const permissions = pending.requests.filter((request) =>
    request.kind === 'permission' && request.status === 'pending');
  const primaryTeam = session.teams[0];
  const teamRole = deriveTeamRole(session, false, 0, true);
  const disabled = source.busy || batchBusy || session.source !== 'sdk' || permissions.length === 0;

  const respondBatch = async (
    event: MouseEvent,
    action: 'approve' | 'deny',
  ): Promise<void> => {
    event.stopPropagation();
    if (disabled) return;
    const operation = ++operationRef.current;
    setBatchBusy(true);
    setBatchError(null);
    try {
      for (const request of permissions) {
        await source.respondPending(
          remotePendingPresentation(source.identity, pending.revision, request),
          action,
        );
        if (operationRef.current !== operation) return;
      }
    } catch {
      if (operationRef.current === operation) {
        setBatchError('批量处理未全部完成。已完成的项目不会重复执行，请刷新后继续。');
      }
    } finally {
      if (operationRef.current === operation) setBatchBusy(false);
    }
  };

  return (
    <li className="rounded-md border border-deck-border bg-white/[0.02]">
      <header
        className="flex cursor-pointer items-center gap-2 border-b border-deck-border/50 px-3 py-2 hover:bg-white/[0.04]"
        onClick={() => onOpenSession(session.id)}
      >
        <StatusBadge activity={session.activity} lifecycle={session.lifecycle} archived={session.archived} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{session.title}</span>
        <span className={`rounded px-1 py-0.5 text-[8px] ${
          session.source === 'sdk'
            ? 'bg-status-working/20 text-status-working'
            : 'bg-white/8 text-deck-muted'
        }`}>{session.source === 'sdk' ? '内' : '外'}</span>
        {primaryTeam && (
          <span className="max-w-[6rem] truncate rounded bg-purple-500/20 px-1 py-0.5 text-[9px] text-purple-300" title={`团队：${primaryTeam.teamName}`}>
            <ShieldIcon className="mr-0.5 inline h-3 w-3" />{primaryTeam.teamName}
          </span>
        )}
        {teamRole === 'lead' && <span className="rounded bg-blue-400/15 px-1 py-0.5 text-[9px] text-blue-200"><CrownIcon className="mr-0.5 inline h-3 w-3" />负责人</span>}
        {teamRole === 'teammate' && <span className="rounded bg-blue-400/10 px-1 py-0.5 text-[9px] text-blue-200/85"><UsersIcon className="mr-0.5 inline h-3 w-3" />协作者</span>}
        <span className="text-[9px] text-deck-muted/60">{agentIdLabel(session.adapterId)}</span>
        <span className="rounded bg-status-waiting/25 px-1.5 py-0.5 text-[10px] text-status-waiting">{pending.requests.length}</span>
        <span className="flex gap-1" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            disabled={disabled}
            onClick={(event) => void respondBatch(event, 'approve')}
            className="rounded bg-status-working/25 px-1.5 py-0.5 text-[9px] text-status-working disabled:opacity-35"
            title={session.source === 'sdk' ? '依次批准此会话当前的权限请求' : '终端会话需回到原终端处理'}
          ><CheckIcon className="mr-0.5 inline h-3 w-3" />全部允许</button>
          <button
            type="button"
            disabled={disabled}
            onClick={(event) => void respondBatch(event, 'deny')}
            className="rounded bg-status-waiting/25 px-1.5 py-0.5 text-[9px] text-status-waiting disabled:opacity-35"
            title={session.source === 'sdk' ? '依次拒绝此会话当前的权限请求' : '终端会话需回到原终端处理'}
          ><CloseIcon className="mr-0.5 inline h-3 w-3" />全部拒绝</button>
        </span>
      </header>
      <div className={batchBusy ? 'pointer-events-none p-2 opacity-50' : 'p-2'}>
        <RemotePendingRequests
          pending={pending}
          sourceIdentity={source.identity}
          agentId={session.adapterId}
          busy={source.busy || batchBusy}
          onRespond={source.respondPending}
          planReviewTransport={source.planReviewTransport}
        />
      </div>
      {batchError && <div role="alert" className="mx-2 mb-2 rounded bg-red-500/10 px-2 py-1 text-[9px] text-red-200">{batchError}</div>}
    </li>
  );
}
