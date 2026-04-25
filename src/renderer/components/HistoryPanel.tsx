import { useEffect, useRef, useState, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
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

/**
 * 关键字输入到查询触发的延迟（毫秒）。
 * 避免用户每敲一个字就触发一次 SQL 查询：events.payload_json 上的 LIKE %kw% 是
 * 全表扫描 + 全文字符串匹配，几千条事件后每次输入都会卡 200~500ms。
 * 后端 session-repo 也额外加了"短关键词只搜 title"的过滤兜底。
 */
const KEYWORD_DEBOUNCE_MS = 300;

export function HistoryPanel({ onSelect }: Props): JSX.Element {
  const [filters, setFilters] = useState<Filters>({});
  /** 输入框的实时值（用户每打一个字就更新），与 filters.keyword 解耦避免每次输入都触发 reload */
  const [keywordInput, setKeywordInput] = useState('');
  const [rows, setRows] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  /** reload 序列号：每次发起递增；then 回调先比较序列号，过期请求直接丢弃。
   * REVIEW_2 修：旧筛选慢请求返回会覆盖新筛选结果（搜索 / 切「仅归档」时列表回跳到过期数据）。 */
  const reqIdRef = useRef(0);
  /** REVIEW_7 M2：filters 的 ref 镜像。
   * 下面 listener 用空 deps 数组注册（注释 76-77 说明原因：reload 重建 listener 会让中间事件漏掉），
   * 但 reload 闭包里读 `filters` 会被锁死成首次 mount 时的快照 → 用户改了 filter 后
   * rename/upsert 触发的 reload 仍按旧 filters 查询。让 reload 一律走 ref 拿最新 filters。 */
  const filtersRef = useRef<Filters>(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  // keywordInput → filters.keyword 的 debounce 桥接：用户停止输入 300ms 后才提交查询
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => ({ ...f, keyword: keywordInput || undefined }));
    }, KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [keywordInput]);

  const reload = async (): Promise<void> => {
    const cur = ++reqIdRef.current;
    setLoading(true);
    try {
      // 走 preload 强类型 facade 而不是 ipcInvokeRaw —— 避免 channel 名 typo 静默 fail
      // 用 filtersRef.current 而非 filters：让 listener 路径（空 deps 注册一次）也能拿最新 filters
      const r = await window.api.listSessionHistory(filtersRef.current);
      if (cur !== reqIdRef.current) return; // 过期请求，丢弃结果
      setRows(r);
    } finally {
      if (cur === reqIdRef.current) setLoading(false);
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

  // CHANGELOG_31：监听 session-renamed / session-upserted 触发 reload。
  // 触发场景：
  //   - rename：CHANGELOG_27/28 fork 兜底走 sessionManager.renameSdkSession 把 OLD_ID record 删除（DB 内）
  //     + 子表迁到 NEW_ID（lifecycle=active 不在 history 视图），HistoryPanel.rows 缓存的旧 OLD_ID record
  //     需 reload 才能消失，不然用户看到「会话明明已经在实时聊上了，但历史列表里还有」体感矛盾
  //   - upsert：hook 抢先复活 closed 会话 / SDK 创建新 SDK 会话等会让某条 history record 变成 active，
  //     同样需要从历史列表移除
  // debounce 200ms 避免 event burst 时多次 reload；用 ref 持有定时器，每次新事件来重置
  // 不在 deps 数组里加 reload —— reload 内部用 reqIdRef 自己防过期请求，重新创建 listener 会让
  // 中间产生的 event 漏掉，反而更糟
  const reloadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const trigger = (): void => {
      if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
      reloadDebounceRef.current = setTimeout(() => {
        void reload();
      }, 200);
    };
    const offRen = window.api.onSessionRenamed(trigger);
    const offUps = window.api.onSessionUpserted(trigger);
    return () => {
      if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
      offRen();
      offUps();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
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
                onClick={() => onSelect(s.id)}
                className="cursor-pointer rounded-md border border-deck-border bg-white/[0.02] px-3 py-2 hover:bg-white/[0.05]"
              >
                <div className="flex items-center gap-2">
                  <StatusBadge
                    activity={s.activity}
                    lifecycle={s.lifecycle}
                    archived={s.archivedAt !== null}
                  />
                  {/* CHANGELOG_29：与 SessionCard / SessionDetail.SourceBadge 风格一致的「内/外」标签 ——
                      历史 tab 同样是用户主要查找入口，列表里就要能预判这条点进去能不能继续聊
                      （SDK=内 可以；其他 source=外 走 CliFooter 只读，不能在 detail 里发消息）。
                      REVIEW_7 L2：tooltip 显示真实 source 名（而非固定写「外部终端 CLI」）；
                      未来加入新 adapter 时，本标签 + SessionDetail 渲染分支需要同步加判断。 */}
                  <span
                    className={`inline-flex h-4 items-center rounded-sm px-1 text-[9px] font-medium leading-none ${
                      s.source === 'sdk'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-white/10 text-deck-muted'
                    }`}
                    title={
                      s.source === 'sdk'
                        ? '应用内创建（SDK 通道，可在 detail 里继续聊）'
                        : `外部 ${s.source ?? 'cli'} 通道（只读，detail 不可发消息）`
                    }
                  >
                    {s.source === 'sdk' ? '内' : '外'}
                  </span>
                  <div className="flex-1 truncate text-[12px] font-medium hover:text-white">
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
                        onClick={(e) => {
                          e.stopPropagation();
                          void unarchive(s.id);
                        }}
                      >
                        取消归档
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="hover:text-deck-text"
                        onClick={(e) => {
                          e.stopPropagation();
                          void archive(s.id);
                        }}
                      >
                        归档
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-status-waiting/80 hover:text-status-waiting"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(s.id);
                      }}
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
