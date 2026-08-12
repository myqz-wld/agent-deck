import { useEffect, useRef, useState, type JSX } from 'react';

import type { RemoteHostProfileDto } from '@shared/remote-host';
import type { RemoteHostSnapshotState } from '@renderer/remote-host/use-remote-host-snapshot';
import { CloseIcon } from '../icons';
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
  useModalFocus({ blocked: hosts.busy, dialogRef, onClose, open });
  if (!open) return null;

  const removeProfile = async (profileId: string): Promise<void> => {
    const confirmed = await window.api.confirmDialog({
      title: '删除远程主机配置',
      message: '仅删除本机配置并关闭本机 SSH 传输。',
      detail: '远程 Core 和远程 session 不会停止。',
      okLabel: '删除配置',
      destructive: true,
    });
    if (confirmed) await hosts.removeProfile(profileId);
  };
  const consume = (operation: Promise<void>): void => {
    void operation.catch(() => undefined);
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-host-manager-title"
        data-layout="single-column"
        className="no-drag relative flex max-h-[85%] w-[min(34rem,92%)] flex-col overflow-hidden rounded-xl border border-deck-border bg-deck-bg-strong shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-deck-border px-4 py-3">
          <div>
            <h2 id="remote-host-manager-title" className="text-[13px] font-medium">远程数据源</h2>
            <p className="mt-0.5 text-[10px] text-deck-muted">管理连接；当前数据源仍由顶部菜单选择。</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => setEditing(null)} disabled={hosts.busy} className="rounded bg-status-working/25 px-2.5 py-1 text-[10px] text-status-working hover:bg-status-working/35 disabled:opacity-50">添加</button>
            <button
              type="button"
              onClick={onClose}
              disabled={hosts.busy}
              className="flex h-5 w-5 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="关闭远程数据源设置"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>
        <div className="min-h-0 overflow-y-auto scrollbar-deck">
          {hosts.error && (
            <div role="alert" className="mx-3 mt-3 break-words rounded bg-status-waiting/10 p-2 text-[10px] text-status-waiting">
              {hosts.error}
            </div>
          )}
          <RemoteConnectionCards
            profiles={snapshot?.profiles ?? []}
            states={snapshot?.states ?? []}
            selectedRemoteProfileId={snapshot?.selectedRemoteProfileId ?? null}
            busy={hosts.busy}
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
            busy={hosts.busy}
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
