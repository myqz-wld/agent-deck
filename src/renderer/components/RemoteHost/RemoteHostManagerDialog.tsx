import { useEffect, useRef, useState, type JSX } from 'react';

import type { RemoteHostProfileDto } from '@shared/remote-host';
import type { RemoteHostSnapshotState } from '@renderer/remote-host/use-remote-host-snapshot';
import { CloseIcon, PlusIcon } from '../icons';
import { RemoteConnectionCards } from './RemoteConnectionCards';
import { RemoteProfileForm } from './RemoteProfileForm';
import { useModalFocus } from '../use-modal-focus';

export function RemoteHostManagerDialog({
  open,
  hosts,
  onClose,
}: {
  open: boolean;
  hosts: RemoteHostSnapshotState;
  onClose: () => void;
}): JSX.Element | null {
  const [editing, setEditing] = useState<RemoteHostProfileDto | null | undefined>();
  const dialogRef = useRef<HTMLElement>(null);
  const snapshot = hosts.snapshot;
  useEffect(() => {
    if (!open) {
      if (editing !== undefined) setEditing(undefined);
      return;
    }
    if (editing && !snapshot?.profiles.some((profile) => profile.id === editing.id)) {
      setEditing(undefined);
    }
  }, [editing, open, snapshot?.profiles]);
  // Background connection work must never trap the user inside this manager.
  useModalFocus({ dialogRef, onClose, open });
  if (!open) return null;

  const removeProfile = async (profileId: string): Promise<void> => {
    const confirmed = await window.api.confirmDialog({
      title: '删除远程主机配置',
      message: '仅删除本机配置并关闭本机 SSH 传输。',
      detail: '远端服务和远端会话不会停止。',
      okLabel: '删除配置',
      destructive: true,
    });
    if (confirmed) await hosts.removeProfile(profileId);
  };
  const consume = (operation: Promise<void>): void => {
    void operation.catch(() => undefined);
  };
  const remoteProfiles = snapshot?.profiles.filter((profile) => profile.scope === 'remote') ?? [];
  const connectedCount = snapshot?.states.filter((state) =>
    remoteProfiles.some((profile) => profile.id === state.profileId) &&
    state.status === 'connected').length ?? 0;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-host-manager-title"
        data-layout="single-column"
        className="no-drag relative flex h-[85%] max-h-[42rem] w-[min(34rem,92%)] flex-col overflow-hidden rounded-xl border border-white/[0.09] bg-deck-bg-strong shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-white/[0.07] bg-black/[0.05] px-4 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 id="remote-host-manager-title" className="text-[13px] font-medium">远程数据源</h2>
              {remoteProfiles.length > 0 && (
                <span className="rounded-full border border-white/[0.07] bg-black/10 px-1.5 py-0.5 text-[9px] tabular-nums text-deck-muted/80">
                  {connectedCount}/{remoteProfiles.length} 已连接
                </span>
              )}
            </div>
            <p className="mt-1 text-[10px] text-deck-muted/80">管理连接；当前数据源仍由顶部菜单选择。</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing(null)}
              disabled={hosts.mutations.profileRegistry}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-white/[0.10] bg-white/[0.045] px-2.5 text-[10px] text-deck-text transition hover:border-white/[0.16] hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlusIcon className="h-3 w-3" />添加
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-5 w-5 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
              aria-label="关闭远程数据源设置"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>
        <div className="min-h-0 overflow-y-auto bg-black/[0.04] scrollbar-deck">
          {hosts.error && (
            <div role="alert" className="mx-3 mt-3 break-words rounded bg-status-waiting/10 p-2 text-[10px] text-status-waiting">
              {hosts.error}
            </div>
          )}
          <RemoteConnectionCards
            profiles={snapshot?.profiles ?? []}
            states={snapshot?.states ?? []}
            selectedRemoteProfileId={snapshot?.selectedRemoteProfileId ?? null}
            mutations={hosts.mutations}
            onEdit={setEditing}
            onSelect={(profileId) => consume(hosts.selectProfile(profileId))}
            onConnect={(profileId) => consume(hosts.connect(profileId))}
            onDisconnect={(profileId) => consume(hosts.disconnect(profileId))}
            onRemove={(profileId) => consume(removeProfile(profileId))}
          />
        </div>
        {editing !== undefined && (
          <RemoteProfileForm
            profile={editing}
            busy={hosts.mutations.profileRegistry}
            onClose={() => setEditing(undefined)}
            onSave={(draft) => editing
              ? hosts.updateProfile(editing.id, draft)
              : hosts.addProfile(draft)}
          />
        )}
      </section>
    </div>
  );
}
