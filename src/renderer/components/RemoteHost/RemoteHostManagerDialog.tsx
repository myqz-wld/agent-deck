import { useState, type JSX } from 'react';

import type { RemoteHostProfileDto } from '@shared/remote-host';
import type { RemoteHostSnapshotState } from '@renderer/remote-host/use-remote-host-snapshot';
import { CloseIcon } from '../icons';
import { RemoteProfileForm } from './RemoteProfileForm';
import { RemoteProfileSidebar } from './RemoteProfileSidebar';

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
  if (!open) return null;
  const snapshot = hosts.snapshot;
  const remoteProfiles = snapshot?.profiles.filter((profile) => profile.scope === 'remote') ?? [];

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
      <section className="no-drag relative flex h-[min(34rem,85%)] w-[min(48rem,92%)] overflow-hidden rounded-xl border border-deck-border bg-deck-bg-strong shadow-2xl">
        <RemoteProfileSidebar
          profiles={snapshot?.profiles ?? []}
          states={snapshot?.states ?? []}
          selectedRemoteProfileId={snapshot?.selectedRemoteProfileId ?? null}
          busy={hosts.busy}
          onAdd={() => setEditing(null)}
          onEdit={setEditing}
          onSelect={(profileId) => consume(hosts.selectProfile(profileId))}
          onConnect={(profileId) => consume(hosts.connect(profileId))}
          onDisconnect={(profileId) => consume(hosts.disconnect(profileId))}
          onRemove={(profileId) => consume(removeProfile(profileId))}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-deck-border px-4 py-3">
            <div>
              <h2 className="text-[13px] font-medium">远程数据源</h2>
              <p className="mt-0.5 text-[10px] text-deck-muted">管理连接；当前数据源仍由顶部菜单选择。</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-5 w-5 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
              aria-label="关闭远程数据源设置"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </header>
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <div className="max-w-md text-[11px] leading-relaxed text-deck-muted">
              {remoteProfiles.length === 0
                ? '还没有远程连接。点击左侧“添加”开始配置。'
                : '选择左侧连接进行连接、编辑或删除。这里的操作不会自动切换当前页面。'}
              {hosts.error && <div role="alert" className="mt-3 rounded bg-status-waiting/10 p-2 text-status-waiting">{hosts.error}</div>}
            </div>
          </div>
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
