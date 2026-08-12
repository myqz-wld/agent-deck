import type { JSX } from 'react';

import {
  isRecoverableRelayWorkerOffline,
  type RemoteHostProfileDto,
  type RemoteHostStateDto,
} from '@shared/remote-host';
import { PencilIcon, PlayIcon, StopIcon, TrashIcon } from '../icons';

interface RemoteConnectionCardsProps {
  profiles: RemoteHostProfileDto[];
  states: RemoteHostStateDto[];
  selectedRemoteProfileId: string | null;
  busy: boolean;
  onEdit(profile: RemoteHostProfileDto): void;
  onSelect(profileId: string): void;
  onConnect(profileId: string): void;
  onDisconnect(profileId: string): void;
  onRemove(profileId: string): void;
}

const STATUS_LABEL: Record<RemoteHostStateDto['status'], string> = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  incompatible: '不兼容',
  offline: '离线',
};

export function RemoteConnectionCards({
  profiles,
  states,
  selectedRemoteProfileId,
  busy,
  onEdit,
  onSelect,
  onConnect,
  onDisconnect,
  onRemove,
}: RemoteConnectionCardsProps): JSX.Element {
  const remoteProfiles = profiles.filter((profile) => profile.scope === 'remote');
  if (remoteProfiles.length === 0) {
    return (
      <div className="p-3">
        <div className="rounded-xl border border-dashed border-blue-300/15 bg-gradient-to-br from-blue-500/[0.07] to-transparent px-5 py-9 text-center">
          <div className="text-[11px] text-deck-text">还没有远程连接</div>
          <div className="mt-1 text-[10px] leading-relaxed text-deck-muted/75">
            点击右上角“添加”，导入服务端签发的连接凭证。
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="remote-connection-list" className="space-y-2.5 p-3">
      {remoteProfiles.map((profile) => {
        const state = states.find((candidate) => candidate.profileId === profile.id);
        const status = state?.status ?? 'offline';
        const selected = selectedRemoteProfileId === profile.id;
        const active = status === 'connected' || status === 'connecting' ||
          status === 'reconnecting' || isRecoverableRelayWorkerOffline(state);
        return (
          <article
            key={profile.id}
            data-testid="remote-connection-card"
            data-selected={selected ? 'true' : 'false'}
            className={`group relative overflow-hidden rounded-xl border transition-all duration-150 ${
              selected
                ? 'border-blue-300/25 bg-gradient-to-r from-blue-500/[0.12] via-blue-500/[0.035] to-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.055),0_10px_28px_rgba(0,0,0,0.12)]'
                : 'border-white/[0.065] bg-black/[0.10] hover:border-white/[0.12] hover:bg-black/[0.04]'
            }`}
          >
            {selected && (
              <span
                aria-hidden="true"
                className="absolute inset-y-3 left-0 w-px rounded-full bg-blue-300/80 shadow-[0_0_10px_rgba(147,197,253,0.65)]"
              />
            )}
            <button
              type="button"
              onClick={() => onSelect(profile.id)}
              className="block w-full min-w-0 px-3 py-3 text-left outline-none transition focus-visible:bg-blue-400/[0.07]"
              aria-label={`选择连接 ${profile.label}`}
              aria-pressed={selected}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <div className="truncate text-[11px] font-medium text-deck-text">
                      {profile.label}
                    </div>
                    {selected && (
                      <span className="shrink-0 rounded-full border border-blue-300/15 bg-blue-400/10 px-1.5 py-px text-[8px] text-blue-100/90">
                        默认连接
                      </span>
                    )}
                  </div>
                  {profile.endpoint && (
                    <div className="mt-1 truncate font-mono text-[9px] text-deck-muted/65">
                      {profile.endpoint.username}@{profile.endpoint.hostname}:{profile.endpoint.port}
                    </div>
                  )}
                </div>
                <div className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] ${statusBadge(status)}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${statusColor(status)}`} />
                  {STATUS_LABEL[status]}
                </div>
              </div>
            </button>

            {state?.error && (
              <div className="mx-3 mb-2 break-words rounded-md border border-status-waiting/15 bg-status-waiting/[0.07] px-2.5 py-2 text-[9px] leading-relaxed text-status-waiting">
                {state.error.message}
                {['child_exit_timeout', 'transport-close-failed'].includes(state.error.code) && (
                  <div className="mt-1 font-medium">
                    此安全栅栏不会自动放宽，请重启 Agent Deck 后恢复。
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1 border-t border-white/[0.055] px-2.5 py-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => active ? onDisconnect(profile.id) : onConnect(profile.id)}
                className={`inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[9px] transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? 'border-white/[0.07] text-deck-muted hover:border-white/[0.12] hover:bg-white/[0.05] hover:text-deck-text'
                    : 'border-emerald-300/15 bg-emerald-400/[0.08] text-emerald-200 hover:border-emerald-300/25 hover:bg-emerald-400/[0.13]'
                }`}
              >
                {active
                  ? <StopIcon className="h-2.5 w-2.5" />
                  : <PlayIcon className="h-2.5 w-2.5" />}
                {active ? '断开' : '连接'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onEdit(profile)}
                className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[9px] text-deck-muted transition hover:bg-white/[0.05] hover:text-deck-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PencilIcon className="h-3 w-3" />编辑
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRemove(profile.id)}
                className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-2 text-[9px] text-red-300/80 transition hover:bg-red-500/[0.08] hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <TrashIcon className="h-3 w-3" />删除配置
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function statusColor(status: RemoteHostStateDto['status']): string {
  if (status === 'connected') return 'bg-emerald-300 shadow-[0_0_7px_rgba(110,231,183,0.65)]';
  if (status === 'connecting' || status === 'reconnecting') {
    return 'bg-amber-300 shadow-[0_0_7px_rgba(252,211,77,0.55)]';
  }
  if (status === 'incompatible') return 'bg-red-300 shadow-[0_0_7px_rgba(252,165,165,0.5)]';
  return 'bg-white/30';
}

function statusBadge(status: RemoteHostStateDto['status']): string {
  if (status === 'connected') {
    return 'border-emerald-300/15 bg-emerald-400/[0.07] text-emerald-200';
  }
  if (status === 'connecting' || status === 'reconnecting') {
    return 'border-amber-300/15 bg-amber-400/[0.07] text-amber-100';
  }
  if (status === 'incompatible') {
    return 'border-red-300/15 bg-red-400/[0.07] text-red-200';
  }
  return 'border-white/[0.07] bg-black/10 text-deck-muted/75';
}
