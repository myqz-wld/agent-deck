import { useState, type JSX } from 'react';

import type { RemoteHostProfileDto } from '@shared/remote-host';
import type { RemoteHostSnapshotState } from '@renderer/remote-host/use-remote-host-snapshot';
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
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 p-6">
      <section className="relative flex h-[min(34rem,90vh)] w-[min(48rem,94vw)] overflow-hidden rounded-lg border border-white/15 bg-[#17191f] shadow-2xl">
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
          <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">远程数据源</h2>
              <p className="mt-0.5 text-[10px] text-deck-muted">Server Core 与 Relay 是部署拓扑；页面始终复用 Local/Remote 数据源模式。</p>
            </div>
            <button type="button" onClick={onClose} className="rounded px-2 py-1 text-deck-muted hover:bg-white/10" aria-label="关闭远程数据源设置">×</button>
          </header>
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <div className="max-w-md text-[11px] leading-relaxed text-deck-muted">
              SSH 私钥与 known_hosts 路径只保存在主进程。切换回 Local 不会断开远程连接，也不会停止远程 Core 或 session。
              {hosts.error && <div role="alert" className="mt-3 rounded bg-red-500/10 p-2 text-red-200">{hosts.error}</div>}
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
