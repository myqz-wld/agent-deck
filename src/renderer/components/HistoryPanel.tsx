import { useEffect, useState, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import { ipcInvokeRaw } from '@renderer/lib/ipc';
import { StatusBadge } from './StatusBadge';

interface Filters {
  agentId?: string;
  cwd?: string;
  fromTs?: number;
  toTs?: number;
  keyword?: string;
  archivedOnly?: boolean;
}

interface Props {
  onSelect: (id: string) => void;
}

export function HistoryPanel({ onSelect }: Props): JSX.Element {
  const [filters, setFilters] = useState<Filters>({});
  const [rows, setRows] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = async (): Promise<void> => {
    setLoading(true);
    try {
      const r = (await ipcInvokeRaw('session:list-history', filters)) as SessionRecord[];
      setRows(r);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [
    filters.agentId,
    filters.cwd,
    filters.fromTs,
    filters.toTs,
    filters.keyword,
    filters.archivedOnly,
  ]);

  const archive = async (id: string): Promise<void> => {
    await window.api.archiveSession(id);
    await reload();
  };
  const unarchive = async (id: string): Promise<void> => {
    await window.api.unarchiveSession(id);
    await reload();
  };
  const remove = async (id: string): Promise<void> => {
    const ok = await window.api.confirmDialog({
      title: '删除会话',
      message: '确定要删除该会话？',
      detail: '该操作不可恢复，将连同所有事件、文件改动、总结一并删除。',
      okLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    await window.api.deleteSession(id);
    await reload();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-deck-border px-3 py-2">
        <div className="flex gap-1.5">
          <input
            type="text"
            placeholder="关键字搜索 cwd / 标题 / 事件 / 总结…"
            className="no-drag flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
            value={filters.keyword ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, keyword: e.target.value || undefined }))
            }
          />
          <button
            type="button"
            onClick={() =>
              setFilters((f) => ({ ...f, archivedOnly: !f.archivedOnly }))
            }
            className={`no-drag rounded px-2 py-1 text-[10px] ${
              filters.archivedOnly
                ? 'bg-white/15 text-deck-text'
                : 'bg-white/[0.03] text-deck-muted hover:bg-white/[0.06]'
            }`}
          >
            仅归档
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-deck px-3 py-2">
        {loading ? (
          <div className="text-[11px] text-deck-muted">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="text-[11px] text-deck-muted">无匹配的历史会话</div>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {rows.map((s) => (
              <li
                key={s.id}
                className="rounded-md border border-deck-border bg-white/[0.02] px-3 py-2 hover:bg-white/[0.05]"
              >
                <div className="flex items-center gap-2">
                  <StatusBadge
                    activity={s.activity}
                    lifecycle={s.lifecycle}
                    archived={s.archivedAt !== null}
                  />
                  <div
                    onClick={() => onSelect(s.id)}
                    className="flex-1 cursor-pointer truncate text-[12px] font-medium hover:text-white"
                  >
                    {s.title}
                  </div>
                  <span className="text-[9px] text-deck-muted/60">{s.agentId}</span>
                </div>
                <div className="mt-0.5 truncate text-[10px] text-deck-muted">{s.cwd}</div>
                <div className="mt-0.5 flex items-center justify-between text-[10px] text-deck-muted/70">
                  <span>
                    {new Date(s.lastEventAt).toLocaleString('zh-CN', { hour12: false })} ·{' '}
                    {s.archivedAt !== null ? `已归档 (${s.lifecycle})` : s.lifecycle}
                  </span>
                  <span className="flex gap-2">
                    {s.archivedAt !== null ? (
                      <button
                        type="button"
                        className="hover:text-deck-text"
                        onClick={() => void unarchive(s.id)}
                      >
                        取消归档
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="hover:text-deck-text"
                        onClick={() => void archive(s.id)}
                      >
                        归档
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-status-waiting/80 hover:text-status-waiting"
                      onClick={() => void remove(s.id)}
                    >
                      删除
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
