import { useEffect, useState, type JSX } from 'react';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';

export function RemoteSessionCreateDialog({
  open,
  source,
  onClose,
}: {
  open: boolean;
  source: RemoteSessionSourceView;
  onClose: () => void;
}): JSX.Element | null {
  const [adapterId, setAdapterId] = useState('claude-code');
  const [projectRef, setProjectRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setProjectRef((current) =>
      source.projects.some((project) => project.projectRef === current)
        ? current
        : source.projects[0]?.projectRef ?? '');
  }, [open, source.identity, source.projects]);
  if (!open) return null;

  const create = async (): Promise<void> => {
    setError(null);
    try {
      await source.createSession(adapterId, projectRef);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const canCreate = source.usable && source.capabilities.has('session-console.create');
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 p-4">
      <section className="w-full max-w-lg rounded-lg border border-white/15 bg-[#17191f] p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">新建远程 session</h2>
          <button type="button" onClick={onClose} className="rounded px-2 text-deck-muted hover:bg-white/10">×</button>
        </div>
        <p className="mt-1 text-[10px] text-deck-muted">项目使用远程 Core 提供的不透明 projectRef，本地页面不会接收远程 cwd。</p>
        <label className="mt-3 block text-[11px] text-deck-muted">
          Adapter
          <select value={adapterId} onChange={(event) => setAdapterId(event.target.value)} className="mt-1 w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-deck-text">
            <option value="claude-code">Claude Code</option>
            <option value="codex-cli">Codex</option>
            <option value="grok-build">Grok Build</option>
          </select>
        </label>
        <label className="mt-3 block text-[11px] text-deck-muted">
          项目
          <select value={projectRef} onChange={(event) => setProjectRef(event.target.value)} className="mt-1 w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-deck-text">
            {source.projects.map((project) => <option key={project.projectId} value={project.projectRef}>{project.title ?? project.alias}</option>)}
          </select>
        </label>
        {source.hasMoreProjects && (
          <button
            type="button"
            disabled={source.busy}
            onClick={() => void source.loadMoreProjects()}
            className="mt-2 rounded px-2 py-1 text-[10px] text-deck-muted hover:bg-white/8 disabled:opacity-40"
          >
            加载更多项目
          </button>
        )}
        {!canCreate && <div className="mt-3 rounded bg-amber-500/10 p-2 text-[10px] text-amber-100">当前远程 Core 未连接或未提供 session 创建能力。</div>}
        {error && <div role="alert" className="mt-3 rounded bg-red-500/10 p-2 text-[10px] text-red-200">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-[11px] text-deck-muted hover:bg-white/10">取消</button>
          <button type="button" disabled={!canCreate || !projectRef || source.busy} onClick={() => void create()} className="rounded bg-blue-500 px-3 py-1.5 text-[11px] text-white disabled:opacity-40">创建</button>
        </div>
      </section>
    </div>
  );
}
