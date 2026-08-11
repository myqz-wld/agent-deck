import type { JSX } from 'react';

import {
  isRecoverableRelayWorkerOffline,
  type RemoteHostProfileDto,
  type RemoteHostStateDto,
} from '@shared/remote-host';

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
      <div className="px-5 py-10 text-center">
        <div className="text-[11px] text-deck-text">还没有远程连接</div>
        <div className="mt-1 text-[10px] leading-relaxed text-deck-muted">
          点击右上角“添加”，导入服务端签发的连接凭证。
        </div>
      </div>
    );
  }

  return (
    <div data-testid="remote-connection-list" className="space-y-2 p-3">
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
            className={`rounded-lg border p-3 transition ${
              selected
                ? 'border-white/15 bg-white/[0.08]'
                : 'border-deck-border bg-white/[0.02]'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(profile.id)}
              className="block w-full min-w-0 text-left"
              aria-label={`选择连接 ${profile.label}`}
              aria-pressed={selected}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-medium text-deck-text">
                    {profile.label}
                  </div>
                  {profile.endpoint && (
                    <div className="mt-0.5 truncate text-[9px] text-deck-muted/80">
                      {profile.endpoint.username}@{profile.endpoint.hostname}:{profile.endpoint.port}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-[9px] text-deck-muted">
                  <span className={`h-1.5 w-1.5 rounded-full ${statusColor(status)}`} />
                  {STATUS_LABEL[status]}
                </div>
              </div>
            </button>

            {state?.error && (
              <div className="mt-2 break-words rounded bg-status-waiting/10 p-2 text-[9px] leading-relaxed text-status-waiting">
                {state.error.message}
                {['child_exit_timeout', 'transport-close-failed'].includes(state.error.code) && (
                  <div className="mt-1 font-medium">
                    此安全栅栏不会自动放宽，请重启 Agent Deck 后恢复。
                  </div>
                )}
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => active ? onDisconnect(profile.id) : onConnect(profile.id)}
                className="rounded bg-status-working/25 px-2.5 py-1 text-[10px] text-status-working hover:bg-status-working/35 disabled:opacity-50"
              >
                {active ? '断开' : '连接'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onEdit(profile)}
                className="rounded bg-white/8 px-2.5 py-1 text-[10px] hover:bg-white/12 disabled:opacity-50"
              >
                编辑
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRemove(profile.id)}
                className="ml-auto rounded px-2 py-1 text-[9px] text-red-300 hover:bg-red-500/10 disabled:opacity-50"
              >
                删除配置
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function statusColor(status: RemoteHostStateDto['status']): string {
  if (status === 'connected') return 'bg-emerald-400';
  if (status === 'connecting' || status === 'reconnecting') return 'bg-amber-300';
  if (status === 'incompatible') return 'bg-red-400';
  return 'bg-white/25';
}
