import { useEffect, useRef, useState, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import { ArchiveIcon } from './icons';
import { errorMessage } from '@renderer/lib/error-message';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { LocalHistorySummaryCard } from './LocalHistorySummaryCard';
import { RemoteSessionSummaryCard } from './RemoteSessionSummaryCard';

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
  remoteSource?: RemoteSessionSourceView;
}

/**
 * 关键字输入到查询触发的延迟（毫秒）。
 * 避免用户每敲一个字就触发一次 SQL 查询。后端三字符以上走 trigram FTS，短关键词只查
 * sessions 的标题 / 目录；两种路径都不需要扫描 events.payload_json。
 */
const KEYWORD_DEBOUNCE_MS = 300;

export function HistoryPanel({ onSelect, remoteSource }: Props): JSX.Element {
  return remoteSource
    ? <RemoteHistoryPanel source={remoteSource} onSelect={onSelect} />
    : <LocalHistoryPanel onSelect={onSelect} />;
}

function LocalHistoryPanel({ onSelect }: Pick<Props, 'onSelect'>): JSX.Element {
  const [filters, setFilters] = useState<Filters>({});
  /** 输入框的实时值（用户每打一个字就更新），与 filters.keyword 解耦避免每次输入都触发 reload */
  const [keywordInput, setKeywordInput] = useState('');
  const [rows, setRows] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    try {
      // 走 preload 强类型 facade 而不是 ipcInvokeRaw —— 避免 channel 名 typo 静默 fail
      // 用 filtersRef.current 而非 filters：让 listener 路径（空 deps 注册一次）也能拿最新 filters
      const r = await window.api.listSessionHistory(filtersRef.current);
      if (cur !== reqIdRef.current) return; // 过期请求，丢弃结果
      setRows(r);
    } catch (err) {
      if (cur === reqIdRef.current) {
        setError(`历史会话读取失败：${errorMessage(err)}`);
      }
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
    setError(null);
    try {
      await window.api.archiveSession(id);
      await reload();
    } catch (err) {
      setError(`归档失败：${errorMessage(err)}`);
    }
  };
  const unarchive = async (id: string): Promise<void> => {
    setError(null);
    try {
      await window.api.unarchiveSession(id);
      await reload();
    } catch (err) {
      setError(`取消归档失败：${errorMessage(err)}`);
    }
  };
  const remove = async (id: string): Promise<void> => {
    setError(null);
    try {
      const ok = await window.api.confirmDialog({
        title: '删除会话',
        message: '确定要删除该会话吗？',
        detail: '此操作无法撤销，相关事件、文件改动和总结也会删除。',
        okLabel: '删除',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
      await window.api.deleteSession(id);
      await reload();
    } catch (err) {
      setError(`删除失败：${errorMessage(err)}`);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-deck-border px-3 py-2">
        <div className="flex gap-1.5">
          <input
            type="text"
            placeholder="搜索标题、工作区、事件或总结…"
            title="长工具输出仅搜索开头和结尾各 2,048 个字符"
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
            <ArchiveIcon className="mr-1 inline h-3 w-3" />仅归档
          </button>
        </div>
        <p className="mt-0.5 text-[9px] text-deck-muted/70">
          长工具输出仅搜索开头和结尾各 2,048 个字符。
        </p>
        {error && (
          <div className="rounded bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
            {error}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-deck px-3 py-2">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">没有匹配结果</div>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {rows.map((s) => (
              <li key={s.id}>
                <LocalHistorySummaryCard
                  session={s}
                  onSelect={() => onSelect(s.id)}
                  onArchive={() => archive(s.id)}
                  onUnarchive={() => unarchive(s.id)}
                  onDelete={() => remove(s.id)}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function RemoteHistoryPanel({
  source,
  onSelect,
}: {
  source: RemoteSessionSourceView;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [keyword, setKeyword] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const canMutate = source.usable && source.capabilities.has('sessions.history.write');
  useEffect(() => {
    setKeyword('');
  }, [source.identity]);
  useEffect(() => {
    const timer = setTimeout(() => source.setHistoryQuery(keyword.trim()), KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword, source.setHistoryQuery]);
  const run = async (
    label: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    setActionError(null);
    try {
      await action();
      source.refresh();
    } catch (reason) {
      setActionError(`${label}失败：${errorMessage(reason)}`);
    }
  };
  const remove = async (session: RemoteSessionSourceView['historySessions'][number]): Promise<void> => {
    setActionError(null);
    try {
      const ok = await window.api.confirmDialog({
        title: '删除会话',
        message: '确定要删除该会话吗？',
        detail: '此操作无法撤销，相关事件、文件改动和总结也会删除。',
        okLabel: '删除',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
      await run('删除', () => source.deleteHistorySession(session));
    } catch (reason) {
      setActionError(`删除失败：${errorMessage(reason)}`);
    }
  };
  const rows = source.historySessions;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-deck-border px-3 py-2">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索标题、工作区、事件或总结…"
            title="长工具输出仅搜索开头和结尾各 2,048 个字符"
            className="no-drag flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
          />
          <button
            type="button"
            disabled={!canMutate}
            title={canMutate ? '仅显示已归档会话' : '当前远端版本暂不支持修改历史会话'}
            onClick={() => source.setHistoryArchivedOnly(!source.historyArchivedOnly)}
            className={`no-drag rounded px-2 py-1 text-[10px] ${
              source.historyArchivedOnly
                ? 'bg-white/15 text-deck-text'
                : 'bg-white/[0.03] text-deck-muted hover:bg-white/[0.06]'
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <ArchiveIcon className="mr-1 inline h-3 w-3" />仅归档
          </button>
        </div>
        <p className="mt-0.5 text-[9px] text-deck-muted/70">
          长工具输出仅搜索开头和结尾各 2,048 个字符。
        </p>
        {actionError && (
          <div role="alert" className="rounded bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
            {actionError}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-deck px-3 py-2">
        {source.historyLoadError && source.historySessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-status-waiting/90">
            {source.historyLoadError}
          </div>
        ) : source.historyLoading && source.historySessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">
            {source.historyQuery ? '没有匹配结果' : '没有历史会话'}
          </div>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {rows.map((session) => (
              <li key={`${source.identity}:${session.id}`}>
                <RemoteSessionSummaryCard
                  session={session}
                  history
                  onSelect={() => onSelect(session.id)}
                  {...(canMutate ? {
                    onArchive: () => run('归档', () => source.archiveHistorySession(session)),
                    onUnarchive: () => run(
                      '取消归档',
                      () => source.unarchiveHistorySession(session),
                    ),
                    onDelete: () => remove(session),
                  } : {})}
                />
              </li>
            ))}
            {source.hasMoreHistorySessions && (
              <li>
                <button
                  type="button"
                  disabled={source.historyPaginationBusy ?? source.busy}
                  onClick={() => void source.loadMoreHistorySessions()}
                  className="w-full rounded border border-dashed border-white/10 px-3 py-2 text-[10px] text-deck-muted hover:bg-white/[0.04] disabled:opacity-40"
                >
                  加载更多历史会话
                </button>
              </li>
            )}
            {source.historyLoadError && (
              <li className="text-[10px] text-status-waiting/90">{source.historyLoadError}</li>
            )}
          </ol>
        )}
      </div>
    </div>
  );
}
