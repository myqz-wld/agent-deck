import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { FloatingFrame } from './components/FloatingFrame';
import { SettingsDialog } from './components/SettingsDialog';
import { NewSessionDialog } from './components/NewSessionDialog';
import { AssetsLibraryDialog } from './components/AssetsLibraryDialog';
import { AppHeader, type AppView } from './components/AppHeader';
import { useSessionStore } from './stores/session-store';
import { useEventBridge } from './hooks/use-event-bridge';
import { useIssuesBridge } from './hooks/use-issues-bridge';
import { useStartupDataPreload } from './hooks/use-startup-data-preload';
import { registerBuiltinDiffRenderers } from './components/diff/install';
import { selectLiveSessions, selectPendingBuckets, sumPendingBuckets } from './lib/session-selectors';
import { loadStableSnapshot } from './lib/load-stable-snapshot';
import { MAX_CALLER_ARCHIVE_FAILURE_REASON_LENGTH } from '@shared/types';
import type { AppSettings, CallerArchiveFailedEvent, SessionRecord } from '@shared/types';
import log from '@renderer/utils/logger';
import { AppArchiveFailureBanner } from './AppArchiveFailureBanner';
import { AppWorkspace } from './AppWorkspace';
import { useRemoteHostSnapshot } from './remote-host/use-remote-host-snapshot';
import { useRemoteSessionSource } from './remote-host/use-remote-session-source';
import { clearDetailForSourceView } from './remote-host/source-navigation';
import { RemoteHostManagerDialog } from './components/RemoteHost/RemoteHostManagerDialog';
registerBuiltinDiffRenderers();
const logger = log.scope('renderer-app');
function boundedArchiveReason(reason: string): string {
  if (reason.length <= MAX_CALLER_ARCHIVE_FAILURE_REASON_LENGTH) return reason;
  return `${reason.slice(0, MAX_CALLER_ARCHIVE_FAILURE_REASON_LENGTH - 1)}…`;
}

export function App(): JSX.Element {
  useEventBridge();
  useIssuesBridge();
  useStartupDataPreload();
  const remoteHosts = useRemoteHostSnapshot();
  const remoteSource = useRemoteSessionSource(remoteHosts);
  const remoteMode = remoteHosts.snapshot?.sourceMode === 'remote';
  const remoteIssuesAvailable = remoteSource.capabilities.has('issues');
  const setRemoteSourceMode = remoteHosts.setSourceMode;
  const sessions = useSessionStore((s) => s.sessions);
  const selectedId = useSessionStore((s) => s.selectedSessionId);
  const select = useSessionStore((s) => s.selectSession);
  const setPendingAll = useSessionStore((s) => s.setPendingRequestsAll);

  const [view, setView] = useState<AppView>('live');
  useEffect(() => {
    if (
      remoteMode &&
      (view === 'teams' || view === 'data' || (view === 'issues' && !remoteIssuesAvailable))
    ) {
      setView('live');
    }
  }, [remoteIssuesAvailable, remoteMode, view]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assetsLibraryOpen, setAssetsLibraryOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [remoteProfilesOpen, setRemoteProfilesOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
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
  const [archiveFailure, setArchiveFailure] = useState<CallerArchiveFailedEvent | null>(null);
  const [archiveRetryError, setArchiveRetryError] = useState<string | null>(null);
  const [archiveRetrying, setArchiveRetrying] = useState(false);
  const archiveFailureGeneration = useRef(0);

  useEffect(() => window.api.onCallerArchiveFailed((payload) => {
    archiveFailureGeneration.current += 1;
    setArchiveFailure({ ...payload, reason: boundedArchiveReason(payload.reason) });
    setArchiveRetryError(null);
    setArchiveRetrying(false);
  }), []);

  // 初始化：从设置读取 alwaysOnTop / windowTransparent，并同步主进程（让 vibrancy 跟透明开关匹配）
  // deep-review H2 LOW：cancelled flag 防 StrictMode 双 mount / unmount 后 setState（App 根组件
  // 实战不 unmount，dev StrictMode 双调会 warn；与 H1 同款守门）。
  useEffect(() => {
    let cancelled = false;
    void window.api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const settings = s as AppSettings;
        setPinned(settings.alwaysOnTop);
        setWindowTransparent(settings.windowTransparent);
        void window.api.setAlwaysOnTop(settings.alwaysOnTop).catch((err: unknown) => {
          logger.warn('[app] applying initial always-on-top setting failed', err);
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) logger.warn('[app] initial settings read failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 启动时同步主进程仍在等待的请求。请求期间若收到实时增删，版本守门会丢弃旧快照并重拉；
  // 稳定后再全量替换，既不会抹掉新请求，也不会复活已取消请求。
  useEffect(() => {
    let cancelled = false;
    void loadStableSnapshot({
      readVersion: () => useSessionStore.getState().pendingRevisionsBySession,
      load: async () => {
        const adapters = await window.api.listAdapters();
        const snapshots = await Promise.all(
          adapters.map(async (adapter) => {
            try {
              return await window.api.listAdapterPendingAll(adapter.id);
            } catch (err) {
              throw new Error(`listAdapterPendingAll(${adapter.id}) failed`, { cause: err });
            }
          }),
        );
        const combined: Parameters<typeof setPendingAll>[0] = {};
        for (const snapshot of snapshots) Object.assign(combined, snapshot);
        return combined;
      },
      apply: setPendingAll,
      isCancelled: () => cancelled,
    })
      .then((result) => {
        if (result === 'unstable') {
          logger.warn('[app] pending snapshot stayed unstable; kept live state');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) logger.warn('[app] initial pending snapshot failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [setPendingAll]);

  // 监听全局快捷键 Cmd+Alt+P：主进程已切换 alwaysOnTop+vibrancy，这里同步 UI 与持久化设置
  useEffect(() => {
    const off = window.api.onPinToggled((next) => {
      setPinned(next);
      void window.api.setSettings({ alwaysOnTop: next }).catch((err: unknown) => {
        logger.warn('[app] persisting pin shortcut failed', err);
      });
    });
    return off;
  }, []);

  // 监听全局快捷键 Cmd+Alt+T：主进程已切换 windowTransparent + vibrancy（不依赖 pin 状态），
  // 这里同步本地 state（驱动 FloatingFrame 透明态）与持久化设置（settings handler 内
  // setWindowTransparent 同 value 二次调用 idempotent 安全）。
  useEffect(() => {
    const off = window.api.onTransparentToggled((next) => {
      setWindowTransparent(next);
      void window.api.setSettings({ windowTransparent: next }).catch((err: unknown) => {
        logger.warn('[app] persisting transparency shortcut failed', err);
      });
    });
    return off;
  }, []);

  // CHANGELOG_124 R1 fix REVIEW_45 MED-1：toggleMaximize / toggleDefault (Cmd+Alt+= / -)
  // 退出 compact 态时主进程 emit IpcEvent.CompactToggled — 同步本地 compact state 避免
  // 展开/折叠按钮状态与实际窗口尺寸反转（用户先点折叠 → 按 Cmd+Alt+= 后窗口实际 max，
  // 但按钮仍显示折叠状态 → 用户再次点击反而又把窗口收成 compact）。
  useEffect(() => {
    const off = window.api.onCompactToggled((next) => {
      setCompact(next);
    });
    return off;
  }, []);

  // CLI / hand-off 创建会话后跳转。先挂实时监听，再领取主进程保留的最新请求，
  // 覆盖窗口冷启动和 renderer HMR 尚未挂载监听器的空档。
  useEffect(() => {
    let cancelled = false;
    let focusRequestSeq = 0;
    const focusSession = (sid: string): void => {
      if (cancelled) return;
      void setRemoteSourceMode('local').catch((err: unknown) => {
        logger.warn('[app] switching to Local for a local focus request failed', err);
      });
      setView('live');
      select(sid);
    };
    const consumePendingFocus = (fallback?: string): void => {
      const seq = ++focusRequestSeq;
      void window.api
        .takePendingSessionFocus()
        .then((sid) => {
          if (seq !== focusRequestSeq) return;
          const target = sid ?? fallback;
          if (target) focusSession(target);
        })
        .catch((err: unknown) => {
          if (seq !== focusRequestSeq) return;
          if (fallback) focusSession(fallback);
          if (!cancelled) logger.warn('[app] takePendingSessionFocus failed', err);
        });
    };
    const off = window.api.onSessionFocusRequest((sid) => {
      consumePendingFocus(sid);
    });
    consumePendingFocus();
    return () => {
      cancelled = true;
      off();
    };
  }, [select, setRemoteSourceMode]);

  useEffect(() => {
    if (view !== 'history') {
      // 让离开历史页前发出的 getSession 响应失效，避免稍后回到历史页时误开旧详情。
      historySelectSeqRef.current++;
      setHistorySession(null);
    }
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

  const togglePin = async (): Promise<void> => {
    const next = !pinned;
    setPinned(next);
    try {
      await window.api.setAlwaysOnTop(next);
      await window.api.setSettings({ alwaysOnTop: next });
    } catch (err) {
      logger.warn('[app] toggling always-on-top failed', err);
      try {
        const settings = (await window.api.getSettings()) as AppSettings;
        setPinned(settings.alwaysOnTop);
        await window.api.setAlwaysOnTop(settings.alwaysOnTop);
      } catch (restoreErr) {
        logger.warn('[app] restoring always-on-top state failed', restoreErr);
      }
    }
  };

  const toggleCompact = async (): Promise<void> => {
    try {
      const next = await window.api.toggleCompact();
      setCompact(next);
    } catch (err) {
      logger.warn('[app] toggling compact mode failed', err);
    }
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

  const localStats = useMemo(() => {
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

  // pending 计数：把所有 session 上挂着的权限/提问/计划确认/差异展示数加起来。
  // 复用 selectPendingBuckets 与 PendingTab 同口径（均过滤 archived + lifecycle ∈ {active,dormant}），
  // 避免 chip 数 ≠ tab 内显示数；CHANGELOG_31 之后归档会话即便仍有 pending 也不该骚扰用户。
  // pending（PermissionRequest / AskUserQuestion / ExitPlanMode / diff 展示）一起算 ——
  // ExitPlanMode 也走 canUseTool 拦截，UX 上就是同一类「待处理」，漏算会让 chip 与 tab 对不上。
  const pendingPermsMap = useSessionStore((s) => s.pendingPermissionsBySession);
  const pendingAsksMap = useSessionStore((s) => s.pendingAskQuestionsBySession);
  const pendingExitsMap = useSessionStore((s) => s.pendingExitPlanModesBySession);
  const pendingDiffsMap = useSessionStore((s) => s.pendingDiffReviewsBySession);
  const localPending = useMemo(
    () =>
      sumPendingBuckets(
        selectPendingBuckets(
          sessions,
          pendingPermsMap,
          pendingAsksMap,
          pendingExitsMap,
          pendingDiffsMap,
        ),
      ),
    [sessions, pendingPermsMap, pendingAsksMap, pendingExitsMap, pendingDiffsMap],
  );
  const stats = remoteMode
    ? {
        total: remoteSource.sessionTotal,
        waiting: [...remoteSource.pendingBySession.values()].filter((row) => row.requests.length > 0).length,
        working: remoteSource.sessions.filter((session) => session.status === 'active').length,
      }
    : localStats;
  const pending = remoteMode
    ? [...remoteSource.pendingBySession.values()].reduce((sum, row) => sum + row.requests.length, 0)
    : localPending;

  const jumpToPending = (): void => {
    if (pending === 0) return;
    setView('pending');
    // 清掉当前 selected：detailSession 在 view!=='history' 时优先级高于 view 分支渲染
    // （main 区域 detailSession ? <SessionDetail/> : ...），不清就被 SessionDetail 盖住看不到 PendingTab
    clearDetailForSourceView(remoteMode, 'pending', () => select(null),
      () => remoteSource.selectSession(null));
  };

  const onHistorySelect = async (id: string): Promise<void> => {
    const seq = ++historySelectSeqRef.current;
    try {
      const s = (await window.api.getSession(id)) as SessionRecord | null;
      // 旧响应（用户已点了别的 row）丢弃：只有最新一次请求的响应才 setHistorySession。
      if (seq !== historySelectSeqRef.current) return;
      if (s) setHistorySession(s);
    } catch (err) {
      if (seq === historySelectSeqRef.current) {
        logger.warn('[app] loading history session failed', err);
      }
    }
  };

  const retryCallerArchive = async (): Promise<void> => {
    if (!archiveFailure || archiveFailure.reasonKind === 'row-missing') return;
    const generation = archiveFailureGeneration.current;
    setArchiveRetrying(true);
    setArchiveRetryError(null);
    try {
      await window.api.archiveSession(archiveFailure.sessionId);
      if (generation === archiveFailureGeneration.current) setArchiveFailure(null);
    } catch (error) {
      if (generation === archiveFailureGeneration.current) {
        const reason = error instanceof Error ? error.message : String(error);
        setArchiveRetryError(boundedArchiveReason(reason));
      }
    } finally {
      if (generation === archiveFailureGeneration.current) setArchiveRetrying(false);
    }
  };

  return (
    <FloatingFrame transparent={windowTransparent}>
      <div className="flex h-full flex-col">
        <AppHeader
          view={view}
          stats={stats}
          pending={pending}
          pinned={pinned}
          compact={compact}
          sourceMode={remoteHosts.snapshot?.sourceMode ?? 'local'}
          selectedRemoteProfileId={remoteHosts.snapshot?.selectedRemoteProfileId ?? null}
          remoteProfiles={remoteHosts.snapshot?.profiles ?? []}
          remoteIssuesAvailable={remoteIssuesAvailable}
          onViewChange={(nextView) => {
            setView(nextView);
            clearDetailForSourceView(remoteMode, nextView, () => select(null),
              () => remoteSource.selectSession(null));
          }}
          onSourceChange={(value) => {
            if (value === 'local') {
              void remoteHosts.setSourceMode('local').catch((err: unknown) => logger.warn('[app] source switch failed', err));
              return;
            }
            const profileId = value.startsWith('remote:') ? value.slice('remote:'.length) : '';
            if (profileId) {
              void remoteHosts.selectProfile(profileId)
                .then(() => remoteHosts.setSourceMode('remote'))
                .catch((err: unknown) => logger.warn('[app] source switch failed', err));
            }
          }}
          onOpenRemoteProfiles={() => setRemoteProfilesOpen(true)}
          onOpenPending={jumpToPending}
          onNewSession={() => setNewSessionOpen(true)}
          onTogglePin={() => void togglePin()}
          onToggleCompact={() => void toggleCompact()}
          onOpenLibrary={() => setAssetsLibraryOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {archiveFailure && (
          <AppArchiveFailureBanner
            failure={archiveFailure}
            retryError={archiveRetryError}
            retrying={archiveRetrying}
            onRetry={() => void retryCallerArchive()}
            onDismiss={() => {
              archiveFailureGeneration.current += 1;
              setArchiveFailure(null);
              setArchiveRetryError(null);
            }}
          />
        )}

        <main className="flex-1 overflow-hidden">
          <AppWorkspace
            view={view}
            remoteMode={remoteMode}
            localDetail={detailSession}
            remoteSource={remoteSource}
            onLocalClose={() => {
              if (view === 'history') setHistorySession(null);
              else select(null);
            }}
            onLocalHistorySelect={(id) => void onHistorySelect(id)}
            onOpenLocalSession={select}
            onViewChange={setView}
          />
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
          void window.api
            .getSettings()
            .then((s) => {
              const settings = s as AppSettings;
              setWindowTransparent(settings.windowTransparent);
            })
            .catch((err: unknown) => {
              logger.warn('[app] refreshing transparency setting failed', err);
            });
        }}
      />
      <NewSessionDialog
        open={newSessionOpen}
        remoteSource={remoteMode ? remoteSource : null}
        onClose={() => setNewSessionOpen(false)}
        onCreated={(id) => {
          setView('live');
          if (!remoteMode) select(id);
        }}
      />
      <RemoteHostManagerDialog
        open={remoteProfilesOpen}
        hosts={remoteHosts}
        onClose={() => setRemoteProfilesOpen(false)}
      />
      <AssetsLibraryDialog
        open={assetsLibraryOpen}
        onClose={() => setAssetsLibraryOpen(false)}
      />
    </FloatingFrame>
  );
}
