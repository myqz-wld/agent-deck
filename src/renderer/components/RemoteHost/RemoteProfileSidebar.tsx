import type { JSX } from 'react';

import type {
  RemoteHostProfileDto,
  RemoteHostStateDto,
} from '@shared/remote-host';
import { isRecoverableRelayWorkerOffline } from '@shared/remote-host';

interface RemoteProfileSidebarProps {
  profiles: RemoteHostProfileDto[];
  states: RemoteHostStateDto[];
  selectedRemoteProfileId: string | null;
  busy: boolean;
  onAdd(): void;
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

export function RemoteProfileSidebar({
  profiles,
  states,
  selectedRemoteProfileId,
  busy,
  onAdd,
  onEdit,
  onSelect,
  onConnect,
  onDisconnect,
  onRemove,
}: RemoteProfileSidebarProps): JSX.Element {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-white/10 bg-black/10">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div>
          <div className="text-xs font-semibold">主机配置</div>
          <div className="text-[9px] text-deck-muted">SSH 由主进程独占</div>
        </div>
        <button type="button" onClick={onAdd} disabled={busy} className="rounded bg-blue-500/20 px-2 py-1 text-[10px] text-blue-200 hover:bg-blue-500/30 disabled:opacity-50">添加</button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 scrollbar-deck">
        {profiles.filter((profile) => profile.topology !== 'standalone').map((profile) => {
          const state = states.find((candidate) => candidate.profileId === profile.id);
          const selected = selectedRemoteProfileId === profile.id;
          return (
            <button
              key={profile.id}
              type="button"
              onClick={() => onSelect(profile.id)}
              className={`w-full rounded border p-2 text-left transition ${
                selected
                  ? 'border-blue-400/50 bg-blue-500/15'
                  : 'border-transparent hover:border-white/10 hover:bg-white/5'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11px] font-medium">{profile.label}</span>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusColor(state?.status ?? 'offline')}`} />
              </div>
              <div className="mt-0.5 text-[9px] text-deck-muted">
                {topologyLabel(profile.topology)} · {profile.topology === 'standalone'
                  ? '本机运行'
                  : STATUS_LABEL[state?.status ?? 'offline']}
              </div>
              {profile.endpoint && (
                <div className="mt-1 truncate text-[9px] text-deck-muted/80">
                  {profile.endpoint.username}@{profile.endpoint.hostname}:{profile.endpoint.port}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {(() => {
        const profile = profiles.find((candidate) => candidate.id === selectedRemoteProfileId);
        const state = states.find((candidate) => candidate.profileId === selectedRemoteProfileId);
        if (!profile || profile.topology === 'standalone') return null;
        const active = state?.status === 'connected' ||
          state?.status === 'connecting' ||
          state?.status === 'reconnecting' ||
          isRecoverableRelayWorkerOffline(state);
        return (
          <div className="space-y-2 border-t border-white/10 p-2">
            {state?.error && (
              <div className="rounded bg-red-500/10 p-2 text-[9px] text-red-200">
                {state.error.message}
                {['child_exit_timeout', 'transport-close-failed'].includes(state.error.code) && (
                  <div className="mt-1 font-medium">此安全栅栏不会自动放宽，请重启 Agent Deck 后恢复。</div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-1">
              <button type="button" disabled={busy} onClick={() => active ? onDisconnect(profile.id) : onConnect(profile.id)} className="rounded bg-emerald-500/20 px-2 py-1 text-[10px] text-emerald-200 disabled:opacity-50">
                {active ? '断开' : '连接'}
              </button>
              <button type="button" disabled={busy} onClick={() => onEdit(profile)} className="rounded bg-white/8 px-2 py-1 text-[10px] hover:bg-white/12 disabled:opacity-50">编辑</button>
            </div>
            <button type="button" disabled={busy} onClick={() => onRemove(profile.id)} className="w-full rounded px-2 py-1 text-[9px] text-red-300 hover:bg-red-500/10 disabled:opacity-50">删除配置</button>
          </div>
        );
      })()}
    </aside>
  );
}

function topologyLabel(topology: RemoteHostProfileDto['topology']): string {
  if (topology === 'server-core') return 'Server Core';
  if (topology === 'relay') return 'Relay';
  return 'Standalone';
}

function statusColor(status: RemoteHostStateDto['status']): string {
  if (status === 'connected') return 'bg-emerald-400';
  if (status === 'connecting' || status === 'reconnecting') return 'bg-amber-300';
  if (status === 'incompatible') return 'bg-red-400';
  return 'bg-white/25';
}
