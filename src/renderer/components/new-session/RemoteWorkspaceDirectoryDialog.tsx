import { useEffect, useState, type JSX } from 'react';

import type { WorkspaceDirectoryListResult } from '@contracts/index';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';

import { ArrowLeftIcon, CloseIcon, FolderOpenIcon } from '../icons';

interface Props {
  initialDirectory: string;
  source: RemoteSessionSourceView;
  onClose(): void;
  onSelect(directory: string): void;
}

function parentDirectory(directory: string): string {
  if (directory === '.') return '.';
  const segments = directory.split('/');
  segments.pop();
  return segments.length === 0 ? '.' : segments.join('/');
}

function visiblePath(directory: string): string {
  return directory === '.' ? 'Workspace' : `Workspace / ${directory}`;
}

export function RemoteWorkspaceDirectoryDialog({
  initialDirectory,
  source,
  onClose,
  onSelect,
}: Props): JSX.Element {
  const [directory, setDirectory] = useState(initialDirectory.trim() || '.');
  const [page, setPage] = useState<WorkspaceDirectoryListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRead = source.usable && source.capabilities.has('session-console.read');

  useEffect(() => {
    let stale = false;
    if (!canRead) {
      setLoading(false);
      setPage(null);
      setError(source.usable
        ? '当前 Remote Core 未提供 Workspace 目录读取能力。'
        : '当前 Remote Worker 尚未连接，无法读取 Workspace 目录。');
      return () => { stale = true; };
    }
    setLoading(true);
    setError(null);
    setPage(null);
    void source.listWorkspaceDirectories(directory).then((result) => {
      if (!stale) setPage(result);
    }).catch((reason: unknown) => {
      if (!stale) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!stale) setLoading(false);
    });
    return () => { stale = true; };
    // Source actions are fenced by source.identity; object identity changes with unrelated data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, directory, source.identity]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="no-drag flex max-h-[72%] w-[360px] flex-col overflow-hidden rounded-xl border border-deck-border bg-deck-bg-strong shadow-2xl">
        <header className="flex items-center justify-between border-b border-deck-border px-4 py-3">
          <div>
            <h3 className="text-[13px] font-medium">选择 Workspace 目录</h3>
            <p className="mt-0.5 text-[10px] text-deck-muted">只显示 Remote Workspace 内的目录</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭目录选择"
            className="flex h-5 w-5 items-center justify-center rounded text-deck-muted hover:bg-white/10"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-deck-border px-3 py-2">
          <button
            type="button"
            onClick={() => setDirectory(parentDirectory(directory))}
            disabled={directory === '.' || loading}
            aria-label="返回上一级"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 disabled:opacity-30"
          >
            <ArrowLeftIcon className="h-3.5 w-3.5" />
          </button>
          <div className="min-w-0 truncate rounded bg-white/[0.04] px-2 py-1 text-[11px] text-deck-fg">
            {visiblePath(directory)}
          </div>
        </div>

        <div className="min-h-[170px] flex-1 overflow-y-auto p-2 scrollbar-deck">
          {loading && <div className="px-2 py-3 text-[11px] text-deck-muted">正在读取目录…</div>}
          {!loading && error && (
            <div role="alert" className="rounded bg-status-waiting/10 px-2 py-2 text-[11px] text-status-waiting">
              {error}
            </div>
          )}
          {!loading && page && page.directories.length === 0 && (
            <div className="px-2 py-3 text-[11px] text-deck-muted">此目录下没有子目录</div>
          )}
          {!loading && page?.directories.map((entry) => (
            <button
              key={entry.directory}
              type="button"
              onClick={() => setDirectory(entry.directory)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-white/[0.07]"
            >
              <FolderOpenIcon className="h-3.5 w-3.5 shrink-0 text-deck-muted" />
              <span className="min-w-0 truncate">{entry.name}</span>
            </button>
          ))}
          {!loading && page?.truncated && (
            <div className="mt-2 rounded bg-white/[0.035] px-2 py-1 text-[10px] text-deck-muted">
              目录较多，仅显示前 {page.directories.length} 项；可手动输入更深层的相对目录。
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-deck-border px-4 py-3">
          <span className="text-[10px] text-deck-muted">不会向客户端暴露服务器绝对路径</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-1 text-[11px] text-deck-muted hover:bg-white/5">
              取消
            </button>
            <button
              type="button"
              disabled={!canRead || !page || loading}
              onClick={() => page && onSelect(page.directory)}
              className="rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
            >
              选择此目录
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
