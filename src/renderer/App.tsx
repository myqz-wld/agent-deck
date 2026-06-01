import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { FloatingFrame } from './components/FloatingFrame';
import { SessionList } from './components/SessionList';
import { SessionDetail } from './components/SessionDetail';
import { HistoryPanel } from './components/HistoryPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { NewSessionDialog } from './components/NewSessionDialog';
import { AssetsLibraryDialog } from './components/AssetsLibraryDialog';
import { PendingTab } from './components/PendingTab';
import { TeamHub } from './components/TeamHub';
import { IssuesPanel } from './components/IssuesPanel';
import { useSessionStore } from './stores/session-store';
import { useEventBridge } from './hooks/use-event-bridge';
import { registerBuiltinDiffRenderers } from './components/diff/install';
import { selectLiveSessions, selectPendingBuckets, sumPendingBuckets } from './lib/session-selectors';
import type { AppSettings, SessionRecord } from '@shared/types';

registerBuiltinDiffRenderers();

type View = 'live' | 'history' | 'pending' | 'teams' | 'issues';

export function App(): JSX.Element {
  useEventBridge();
  const sessions = useSessionStore((s) => s.sessions);
  const selectedId = useSessionStore((s) => s.selectedSessionId);
  const select = useSessionStore((s) => s.selectSession);
  const setPendingAll = useSessionStore((s) => s.setPendingRequestsAll);

  const [view, setView] = useState<View>('live');
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Header「📚 资产库」按钮控制（CHANGELOG_57 C5）。SettingsDialog 内的「在资产库中查看」按钮
   *  也走这条 state——点击时 SettingsDialog 自关 + AssetsLibrary 自开（CHANGELOG_58 起两个
   *  section 文案统一为「在资产库中查看 ↗」）。 */
  const [assetsLibraryOpen, setAssetsLibraryOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
  // Phase 5 Step 5.6（plan mcp-bug-and-feature-batch-20260513）：从 transparentWhenPinned
  // 重命名 + 解耦 alwaysOnTop。透明视觉独立于 pin —— 不再 (pinned && transparentWhenPinned)
  // 共同决定 frosted-frame 透明态，而是 windowTransparent 单字段决定。
  const [windowTransparent, setWindowTransparent] = useState(true);
  const [compact, setCompact] = useState(false);
  const [historySession, setHistorySession] = useState<SessionRecord | null>(null);
  /** REVIEW_7 L1：historySession 的 ref 镜像，让 onSessionRenamed listener 能在 updater
   * callback 外读最新值。setState updater callback 必须 pure，不能调 setView/select 副作用
   * （StrictMode dev 双调）；改用 ref 比较后副作用走 listener 顶层。 */
  const historySessionRef = useRef<SessionRecord | null>(null);
  useEffect(() => {
    historySessionRef.current = historySession;
  }, [historySession]);
  // deep-review H2 LOW：history row 快速连点 A→B 时，A 的 getSession 若后 resolve 会覆盖 B 的
  // 选择（旧响应覆盖新选择）。递增 seq，then 内只接受最新 seq 的响应。
  const historySelectSeqRef = useRef(0);

  // 初始化：从设置读取 alwaysOnTop / windowTransparent，并同步主进程（让 vibrancy 跟透明开关匹配）
  // deep-review H2 LOW：cancelled flag 防 StrictMode 双 mount / unmount 后 setState（App 根组件
  // 实战不 unmount，dev StrictMode 双调会 warn；与 H1 同款守门）。
  useEffect(() => {
    let cancelled = false;
    void window.api.getSettings().then((s) => {
      if (cancelled) return;
      const settings = s as AppSettings;
      setPinned(settings.alwaysOnTop);
      setWindowTransparent(settings.windowTransparent);
      void window.api.setAlwaysOnTop(settings.alwaysOnTop);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 启动时同步主进程当前还在等的 pending 请求 —— renderer HMR / 重启后 store 是空的，
  // 但主进程的 SDK 仍在 await 用户响应；不拉一次的话 PermissionRow 会被错渲成「已处理」，
  // 按钮不显示，用户授权不了 → SDK 死锁。
  // 注：setPendingAll 现为 merge（非整表替换，deep-review H2 MED）→ IPC 在途期间 live event
  // 新增的 pending 不被快照抹掉。
  useEffect(() => {
    let cancelled = false;
    void window.api.listAdapterPendingAll('claude-code').then((map) => {
      if (cancelled) return;
      setPendingAll(map);
    });
    return () => {
      cancelled = true;
    };
  }, [setPendingAll]);

  // 监听全局快捷键 Cmd+Alt+P：主进程已切换 alwaysOnTop+vibrancy，这里同步 UI 与持久化设置
  useEffect(() => {
    const off = window.api.onPinToggled((next) => {
      setPinned(next);
      void window.api.setSettings({ alwaysOnTop: next });
    });
    return off;
  }, []);

  // 监听全局快捷键 Cmd+Alt+T：主进程已切换 windowTransparent + vibrancy（不依赖 pin 状态），
  // 这里同步本地 state（驱动 FloatingFrame 透明态）与持久化设置（settings handler 内
  // setWindowTransparent 同 value 二次调用 idempotent 安全）。
  useEffect(() => {
    const off = window.api.onTransparentToggled((next) => {
      setWindowTransparent(next);
      void window.api.setSettings({ windowTransparent: next });
    });
    return off;
  }, []);

  // CHANGELOG_124 R1 fix REVIEW_45 MED-1：toggleMaximize / toggleDefault (Cmd+Alt+= / -)
  // 退出 compact 态时主进程 emit IpcEvent.CompactToggled — 同步本地 compact state 避免
  // 按钮 label `{compact ? '▢' : '─'}` 与实际窗口尺寸反转（用户先点 ▢ 折叠 → 按 Cmd+Alt+= 后
  // 窗口实际 max 但按钮仍显示 ▢ → 用户点 ▢ 反而又把窗口收成 compact）。
  useEffect(() => {
    const off = window.api.onCompactToggled((next) => {
      setCompact(next);
    });
    return off;
  }, []);

  // CLI 子命令新建会话后跳转：切到「实时」并选中新 sessionId。
  // 主进程在 createSession resolve 后才 emit，所以 renderer 此时一般已 mount；
  // 仅在 createSession 极快返回（如 --resume）时可能丢失，可接受。
  useEffect(() => {
    const off = window.api.onSessionFocusRequest((sid) => {
      setView('live');
      select(sid);
    });
    return off;
  }, [select]);

  useEffect(() => {
    if (view !== 'history') setHistorySession(null);
  }, [view]);

  // CHANGELOG_27 / REVIEW_6：sdk-bridge.consume 检测 CLI fork（resume 路径下 SDK 给的
  // realId ≠ opts.resume）→ 触发 sessionManager.renameSdkSession(OLD_ID, NEW_ID) →
  // emit session-renamed → store.renameSession 把 sessions Map / selectedSessionId 切到 NEW_ID。
  // 但本组件的 historySession 是用户点历史会话进 detail 时设的本地 state（一次 fetch 拷贝），
  // store 不知道它，所以要单独 listen session-renamed：
  //
  // CHANGELOG_29：rename 一旦发生说明这条会话已被 SDK 重新激活（active），用户视觉上还卡在
  // 「历史」tab 不合理 —— 主动切到「实时」+ 清掉 historySession 本地 state，detail 通过
  // store.selectedSessionId（renameSession 已切到 NEW_ID）自然接力，体感是「我点的会话被
  // 自动放到实时面板继续聊」，符合 CLAUDE.md「凡让用户感觉像新开会话 / 跳回列表都是 bug」总纲
  //
  // REVIEW_7 L1：副作用（setView / select）从 setHistorySession updater 内挪到 listener 顶层，
  // 用 historySessionRef 比较。updater callback 必须 pure，StrictMode dev 双调原方案会让
  // setView/select 各执行 2 次（虽然第二次 noop 但反模式）。
  useEffect(() => {
    const off = window.api.onSessionRenamed(({ from, to }) => {
      const prev = historySessionRef.current;
      if (prev && prev.id === from) {
        setView('live');
        select(to);
        setHistorySession(null);
      }
    });
    return off;
  }, [select]);

  // R3.E7：删 onTeamPermissionResolved 监听（老 inbox 协议下线）

  const togglePin = async (): Promise<void> => {
    const next = !pinned;
    setPinned(next);
    await window.api.setAlwaysOnTop(next);
    await window.api.setSettings({ alwaysOnTop: next });
  };

  const toggleCompact = async (): Promise<void> => {
    const next = await window.api.toggleCompact();
    setCompact(next);
  };

  // sessions Map 在新建会话 / SDK rename / CLI focus-request 时序变化时可能短暂不含 selectedId
  // —— select(sid) 是同步立即生效，但 session-upserted 经主进程 webContents.send 异步到达 renderer 慢一拍。
  // 直接从 sessions.get 派生 detailSession 会让它闪一帧变 null → UI 跳回 SessionList → upsert 到达后再跳回 detail，
  // 用户体感像「刷新跳转」。stickySelected 缓存最近一次成功 get 到的 record，
  // sessions 暂时不含 selectedId 时仍渲染缓存；只在 selectedId 显式置 null（点返回 / 被删除）时清缓存。
  const selectedFromMap = selectedId ? sessions.get(selectedId) ?? null : null;
  const [stickySelected, setStickySelected] = useState<SessionRecord | null>(null);
  useEffect(() => {
    if (selectedId === null) setStickySelected(null);
    else if (selectedFromMap) setStickySelected(selectedFromMap);
    // selectedId 有值但 selectedFromMap 为 null → 保持缓存，等 upsert 到达
  }, [selectedId, selectedFromMap]);
  // history 视图入 detail 走 historySession 这条独立的本地 state（一次 fetch 拷贝），
  // 它不会跟随 sessions Map 自动刷新。如果用户在 history detail 里发消息触发自动 resume，
  // 后端会把这条历史 record 从 closed 复活到 active 并广播 session-upserted —— store.sessions
  // 已经有最新 record 但 historySession 仍是 fetch 时的 closed 拷贝，detail 里 SourceBadge /
  // ComposerSdk 等的判断都还按旧 record 走，用户体感「点恢复后好像没什么变化 / 像在另一处冒了条新会话」。
  // 优先从 sessions Map 取最新；fallback 到 historySession 是兜底（id 在 store 里还没 upsert 的瞬间）。
  const detailSession =
    view === 'history'
      ? historySession
        ? sessions.get(historySession.id) ?? historySession
        : null
      : (selectedFromMap ?? stickySelected);

  const stats = useMemo(() => {
    // 与 SessionList 的 grouped 共用同一份过滤口径（archivedAt === null && lifecycle ∈ {active, dormant}），
    // 否则当前运行时归档 / lifecycle 转 closed 的会话会留在 store Map 里被多算，
    // 与下方实时列表「活跃 + 休眠」之和对不上。详见 session-selectors.ts。
    const arr = selectLiveSessions(sessions);
    return {
      total: arr.length,
      waiting: arr.filter((s) => s.activity === 'waiting').length,
      working: arr.filter((s) => s.activity === 'working').length,
    };
  }, [sessions]);

  // pending 计数：把所有 session 上挂着的权限/提问/计划批准数加起来。
  // 复用 selectPendingBuckets 与 PendingTab 同口径（均过滤 archived + lifecycle ∈ {active,dormant}），
  // 避免 chip 数 ≠ tab 内显示数；CHANGELOG_31 之后归档会话即便仍有 pending 也不该骚扰用户。
  // 三类 pending（PermissionRequest / AskUserQuestion / ExitPlanMode）一起算 ——
  // ExitPlanMode 也走 canUseTool 拦截，UX 上就是同一类「待处理」，漏算会让 chip 与 tab 对不上。
  const pendingPermsMap = useSessionStore((s) => s.pendingPermissionsBySession);
  const pendingAsksMap = useSessionStore((s) => s.pendingAskQuestionsBySession);
  const pendingExitsMap = useSessionStore((s) => s.pendingExitPlanModesBySession);
  const pending = useMemo(
    () =>
      sumPendingBuckets(
        selectPendingBuckets(sessions, pendingPermsMap, pendingAsksMap, pendingExitsMap),
      ),
    [sessions, pendingPermsMap, pendingAsksMap, pendingExitsMap],
  );

  const jumpToPending = (): void => {
    if (pending === 0) return;
    setView('pending');
    // 清掉当前 selected：detailSession 在 view!=='history' 时优先级高于 view 分支渲染
    // （main 区域 detailSession ? <SessionDetail/> : ...），不清就被 SessionDetail 盖住看不到 PendingTab
    select(null);
  };

  const onHistorySelect = async (id: string): Promise<void> => {
    const seq = ++historySelectSeqRef.current;
    const s = (await window.api.getSession(id)) as SessionRecord | null;
    // 旧响应（用户已点了别的 row）丢弃：只有最新一次请求的响应才 setHistorySession。
    if (seq !== historySelectSeqRef.current) return;
    if (s) setHistorySession(s);
  };

  return (
    <FloatingFrame transparent={windowTransparent}>
      <div className="flex h-full flex-col">
        <header className="drag-region flex h-9 shrink-0 items-center gap-2 pl-[78px] pr-2.5">
          <div className="min-w-0 flex-1 truncate">
            <span className="text-[11px] font-medium tracking-wide">Agent Deck</span>
            <span className="ml-1.5 text-[10px] text-deck-muted/70">
              {stats.total} 会话
              {stats.waiting > 0 && (
                <span className="ml-1.5 text-status-waiting">· {stats.waiting} 等待</span>
              )}
              {stats.working > 0 && (
                <span className="ml-1.5 text-status-working">· {stats.working} 进行中</span>
              )}
            </span>
            {pending > 0 && (
              <button
                type="button"
                onClick={jumpToPending}
                title="打开待处理列表"
                className="no-drag ml-2 rounded bg-status-waiting/25 px-1.5 py-0.5 text-[10px] text-status-waiting hover:bg-status-waiting/40"
              >
                ⚠️ {pending} 待处理
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 no-drag">
            <IconButton title="新建会话" onClick={() => setNewSessionOpen(true)}>
              ＋
            </IconButton>
            <Divider />
            <TabButton active={view === 'live'} onClick={() => setView('live')}>
              实时
            </TabButton>
            <TabButton
              active={view === 'pending'}
              onClick={() => {
                setView('pending');
                // 与 jumpToPending 同因：不清 selectedSessionId，
                // App.tsx:99 的 detailSession 仍非空 → main 区域优先渲 SessionDetail
                // 把 PendingTab 盖掉，详情页里点这个 tab 看起来"无反应"。
                select(null);
              }}
              badge={pending > 0 ? pending : undefined}
            >
              待处理
            </TabButton>
            <TabButton active={view === 'history'} onClick={() => setView('history')}>
              历史
            </TabButton>
            <TabButton
              active={view === 'teams'}
              onClick={() => {
                setView('teams');
                // 切到 teams tab 时清掉 selectedSessionId，否则 detailSession 优先级
                // 高于 view 判断会盖掉 TeamHub。同 PendingTab 同模式。
                select(null);
              }}
            >
              团队
            </TabButton>
            <TabButton
              active={view === 'issues'}
              onClick={() => {
                setView('issues');
                // 与 teams / pending 同模式：切到 issues tab 时清 selectedSessionId
                select(null);
              }}
            >
              问题
            </TabButton>
            <Divider />
            <IconButton
              title={pinned ? '取消置顶' : '置顶'}
              onClick={() => void togglePin()}
              active={pinned}
            >
              {pinned ? '📌' : '📍'}
            </IconButton>
            <IconButton
              title={compact ? '展开' : '折叠'}
              onClick={() => void toggleCompact()}
            >
              {compact ? '▢' : '─'}
            </IconButton>
            <IconButton title="资产库" onClick={() => setAssetsLibraryOpen(true)}>
              📚
            </IconButton>
            <IconButton title="设置" onClick={() => setSettingsOpen(true)}>
              ⚙
            </IconButton>
          </div>
        </header>

        <main className="flex-1 overflow-hidden">
          {detailSession ? (
            <SessionDetail
              session={detailSession}
              onClose={() => {
                if (view === 'history') setHistorySession(null);
                else select(null);
              }}
            />
          ) : view === 'live' ? (
            <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2">
              <SessionList />
            </div>
          ) : view === 'pending' ? (
            <PendingTab
              onOpenSession={(sid) => {
                setView('live');
                select(sid);
              }}
            />
          ) : view === 'teams' ? (
            <TeamHub
              onOpenSession={(sid) => {
                setView('live');
                select(sid);
              }}
            />
          ) : view === 'issues' ? (
            <IssuesPanel
              onOpenSession={(sid) => {
                setView('live');
                select(sid);
              }}
            />
          ) : (
            <HistoryPanel onSelect={(id) => void onHistorySelect(id)} />
          )}
        </main>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          // 用户可能在 dialog 里改了 windowTransparent；main 已经实时切 vibrancy，
          // 但 renderer CSS 层的 frosted-frame 颜色判定走 windowTransparent 单字段（Phase 5
          // Step 5.6 解耦后），这里 re-fetch 一次让 CSS 透明态与设置对齐（无 settings broadcast
          // 通道时的轻量兜底）。
          void window.api.getSettings().then((s) => {
            const settings = s as AppSettings;
            setWindowTransparent(settings.windowTransparent);
          });
        }}
      />
      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        onCreated={(id) => {
          setView('live');
          select(id);
        }}
      />
      <AssetsLibraryDialog
        open={assetsLibraryOpen}
        onClose={() => setAssetsLibraryOpen(false)}
      />
    </FloatingFrame>
  );
}

function TabButton({
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[10px] transition ${
        active ? 'bg-white/15 text-deck-text' : 'text-deck-muted hover:bg-white/8'
      }`}
    >
      {children}
      {badge && badge > 0 ? (
        <span className="ml-1 rounded bg-status-waiting/30 px-1 py-px text-[9px] font-medium tabular-nums text-status-waiting">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function IconButton({
  title,
  onClick,
  active,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-5 w-5 items-center justify-center rounded text-[10px] transition ${
        active
          ? 'bg-white/12 text-deck-text'
          : 'text-deck-muted hover:bg-white/8 hover:text-deck-text'
      }`}
    >
      {children}
    </button>
  );
}

function Divider(): JSX.Element {
  return <span className="mx-0.5 h-3 w-px bg-white/10" />;
}
