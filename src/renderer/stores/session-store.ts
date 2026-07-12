import { create } from 'zustand';
import type {
  AgentEvent,
  AskUserQuestionRequest,
  DiffReviewRequest,
  ExitPlanModeRequest,
  PermissionRequest,
  SessionRecord,
  SummaryRecord,
} from '@shared/types';
import {
  isAskQuestionCancelled,
  isAskUserQuestion,
  isDiffReview,
  isDiffReviewCancelled,
  isExitPlanCancelled,
  isExitPlanMode,
  isPermissionCancelled,
  isPermissionRequest,
} from './event-type-guards';
import {
  dedupeRecentEvents,
  upsertEvent,
} from './session-store-events';
import {
  moveRequestBucket,
  pendingRequestMapsFromSnapshot,
  pruneMapByValidIds,
} from './session-store-maps';
import {
  bumpRenamedSessionRevisions,
  bumpSessionRevision,
} from './session-store-revisions';
import {
  moveLatestSummary,
  moveSessionEvents,
  moveSessionSummaries,
} from './session-store-rename';

interface State {
  sessions: Map<string, SessionRecord>;
  selectedSessionId: string | null;
  recentEventsBySession: Map<string, AgentEvent[]>;
  summariesBySession: Map<string, SummaryRecord[]>;
  /** 每个会话的最新一条 summary —— 用于在 SessionCard 上展示「在干嘛」 */
  latestSummaryBySession: Map<string, SummaryRecord>;
  /** 等待用户允许/拒绝的工具调用，key = sessionId, value = 该会话当前未响应的请求列表 */
  pendingPermissionsBySession: Map<string, PermissionRequest[]>;
  /** 等待用户回答的 AskUserQuestion，独立于权限请求，UI 上单独渲染 */
  pendingAskQuestionsBySession: Map<string, AskUserQuestionRequest[]>;
  /** 等待用户批准/继续规划的 ExitPlanMode，独立于权限请求，UI 上单独渲染（markdown plan + 二选一按钮） */
  pendingExitPlanModesBySession: Map<string, ExitPlanModeRequest[]>;
  /** 等待用户查看/确认的 MCP diff 片段，独立于权限请求，UI 上单独渲染。 */
  pendingDiffReviewsBySession: Map<string, DiffReviewRequest[]>;
  /** 只由实时 session 事件推进；启动快照用它拒绝晚到的旧响应。 */
  sessionRevision: number;
  /** 只由实时 AgentEvent 推进；按会话隔离，避免其他活跃会话阻塞历史快照。 */
  eventRevisionsBySession: Map<string, number>;
  /** 只由实时总结推进；防止慢列表快照覆盖新总结。 */
  summaryRevisionsBySession: Map<string, number>;
  /** 只由实时 pending 增删推进；快照写入本身不改变版本。 */
  pendingRevisionsBySession: Map<string, number>;
  setSessions: (records: SessionRecord[]) => void;
  upsertSession: (record: SessionRecord) => void;
  removeSession: (id: string) => void;
  pushEvent: (event: AgentEvent) => void;
  pushSummary: (summary: SummaryRecord) => void;
  setSummaries: (sessionId: string, summaries: SummaryRecord[]) => void;
  setLatestSummaries: (map: Record<string, SummaryRecord>) => void;
  setRecentEvents: (sessionId: string, events: AgentEvent[]) => void;
  selectSession: (id: string | null) => void;
  resolvePermission: (sessionId: string, requestId: string) => void;
  resolveAskQuestion: (sessionId: string, requestId: string) => void;
  resolveExitPlanMode: (sessionId: string, requestId: string) => void;
  resolveDiffReview: (sessionId: string, requestId: string) => void;
  /** 重建 pending 列表（HMR / 重启后从主进程拉一次，覆盖该 session 的 pending）。 */
  setPendingRequests: (
    sessionId: string,
    permissions: PermissionRequest[],
    askQuestions: AskUserQuestionRequest[],
    exitPlanModes: ExitPlanModeRequest[],
    diffReviews: DiffReviewRequest[],
  ) => void;
  /** 全量灌入 pending（启动时一次性同步多个 session）。 */
  setPendingRequestsAll: (
    map: Record<
      string,
      {
        permissions: PermissionRequest[];
        askQuestions: AskUserQuestionRequest[];
        exitPlanModes: ExitPlanModeRequest[];
        diffReviews?: DiffReviewRequest[];
      }
    >,
  ) => void;
  /** SDK fallback：tempKey → realId 整体迁移所有 by-session 状态，selectedId 跟着改。 */
  renameSession: (fromId: string, toId: string) => void;
}

/**
 * 最近事件保留上限。`pushEvent` 拼新事件后切到这个长度，`setRecentEvents` 也会同步切，
 * 让初次 listEvents 拉的历史与后续 push 的渲染窗口对齐。
 *
 * REVIEW_4 H4：之前 RECENT_LIMIT=30 + activity-feed 调 listEvents(100)，导致用户切到一个
 * 有 100 条历史的会话刚渲染完，下一条新事件来 70 条历史从 UI 蒸发。提升到 200 与
 * SessionListEvents 默认 limit (200) 对齐；200 条普通文本事件常驻内存 < 1MB，可接受。
 */
export const RECENT_LIMIT = 200;
export const EMPTY_REQUESTS: PermissionRequest[] = [];
export const EMPTY_ASK_QUESTIONS: AskUserQuestionRequest[] = [];
export const EMPTY_EXIT_PLAN_MODES: ExitPlanModeRequest[] = [];
export const EMPTY_DIFF_REVIEWS: DiffReviewRequest[] = [];

export const useSessionStore = create<State>((set) => ({
  sessions: new Map(),
  selectedSessionId: null,
  recentEventsBySession: new Map(),
  summariesBySession: new Map(),
  latestSummaryBySession: new Map(),
  pendingPermissionsBySession: new Map(),
  pendingAskQuestionsBySession: new Map(),
  pendingExitPlanModesBySession: new Map(),
  pendingDiffReviewsBySession: new Map(),
  sessionRevision: 0,
  eventRevisionsBySession: new Map(),
  summaryRevisionsBySession: new Map(),
  pendingRevisionsBySession: new Map(),

  setSessions: (records) => {
    // 全量替换会话列表（启动 / HMR / history 视图初始拉）。
    // 同时按新 id 集合 prune 所有 by-session 衍生缓存，否则被 history 清理 / 删除掉的
    // 会话会留 orphan 在 7 张 Map 里（renameSession / removeSession 已对齐这个范式）。
    set((state) => {
      const m = new Map<string, SessionRecord>();
      for (const r of records) m.set(r.id, r);
      const validIds = new Set(records.map((r) => r.id));
      return {
        sessions: m,
        recentEventsBySession: pruneMapByValidIds(state.recentEventsBySession, validIds),
        summariesBySession: pruneMapByValidIds(state.summariesBySession, validIds),
        latestSummaryBySession: pruneMapByValidIds(state.latestSummaryBySession, validIds),
        pendingPermissionsBySession: pruneMapByValidIds(state.pendingPermissionsBySession, validIds),
        pendingAskQuestionsBySession: pruneMapByValidIds(state.pendingAskQuestionsBySession, validIds),
        pendingExitPlanModesBySession: pruneMapByValidIds(state.pendingExitPlanModesBySession, validIds),
        pendingDiffReviewsBySession: pruneMapByValidIds(state.pendingDiffReviewsBySession, validIds),
        selectedSessionId:
          state.selectedSessionId !== null && !validIds.has(state.selectedSessionId)
            ? null
            : state.selectedSessionId,
      };
    });
  },

  upsertSession: (record) =>
    set((state) => {
      const m = new Map(state.sessions);
      m.set(record.id, record);
      return { sessions: m, sessionRevision: state.sessionRevision + 1 };
    }),

  removeSession: (id) =>
    set((state) => {
      const m = new Map(state.sessions);
      m.delete(id);
      const p = new Map(state.pendingPermissionsBySession);
      p.delete(id);
      const a = new Map(state.pendingAskQuestionsBySession);
      a.delete(id);
      const x = new Map(state.pendingExitPlanModesBySession);
      x.delete(id);
      const d = new Map(state.pendingDiffReviewsBySession);
      d.delete(id);
      // 必须把所有 by-session 缓存的 key 一并清掉，否则长期使用 / 历史清理后
      // recentEvents（30 条/会话）与 summaries 会驻留在 renderer 内存里，
      // 没有 sessions key 反查也永远清不到。
      const re = new Map(state.recentEventsBySession);
      re.delete(id);
      const su = new Map(state.summariesBySession);
      su.delete(id);
      const ls = new Map(state.latestSummaryBySession);
      ls.delete(id);
      return {
        sessions: m,
        pendingPermissionsBySession: p,
        pendingAskQuestionsBySession: a,
        pendingExitPlanModesBySession: x,
        pendingDiffReviewsBySession: d,
        recentEventsBySession: re,
        summariesBySession: su,
        latestSummaryBySession: ls,
        selectedSessionId: state.selectedSessionId === id ? null : state.selectedSessionId,
        sessionRevision: state.sessionRevision + 1,
        eventRevisionsBySession: bumpSessionRevision(state.eventRevisionsBySession, id),
        summaryRevisionsBySession: bumpSessionRevision(state.summaryRevisionsBySession, id),
        pendingRevisionsBySession: bumpSessionRevision(state.pendingRevisionsBySession, id),
      };
    }),

  pushEvent: (event) =>
    set((state) => {
      const m = new Map(state.recentEventsBySession);
      const arr = m.get(event.sessionId) ?? [];
      const next = upsertEvent(arr, event, RECENT_LIMIT);
      m.set(event.sessionId, next);

      let pendingMap = state.pendingPermissionsBySession;
      let askMap = state.pendingAskQuestionsBySession;
      let exitMap = state.pendingExitPlanModesBySession;
      let diffMap = state.pendingDiffReviewsBySession;
      const eventRevisions = bumpSessionRevision(state.eventRevisionsBySession, event.sessionId);
      const pendingRevisions =
        event.kind === 'waiting-for-user'
          ? bumpSessionRevision(state.pendingRevisionsBySession, event.sessionId)
          : state.pendingRevisionsBySession;
      if (event.kind === 'waiting-for-user') {
        if (isPermissionRequest(event.payload)) {
          const req = event.payload;
          const list = state.pendingPermissionsBySession.get(event.sessionId) ?? [];
          if (!list.some((r) => r.requestId === req.requestId)) {
            pendingMap = new Map(state.pendingPermissionsBySession);
            pendingMap.set(event.sessionId, [...list, req]);
          }
        } else if (isAskUserQuestion(event.payload)) {
          const req = event.payload;
          const list = state.pendingAskQuestionsBySession.get(event.sessionId) ?? [];
          if (!list.some((r) => r.requestId === req.requestId)) {
            askMap = new Map(state.pendingAskQuestionsBySession);
            askMap.set(event.sessionId, [...list, req]);
          }
        } else if (isExitPlanMode(event.payload)) {
          const req = event.payload;
          const list = state.pendingExitPlanModesBySession.get(event.sessionId) ?? [];
          if (!list.some((r) => r.requestId === req.requestId)) {
            exitMap = new Map(state.pendingExitPlanModesBySession);
            exitMap.set(event.sessionId, [...list, req]);
          }
        } else if (isDiffReview(event.payload)) {
          const req = event.payload;
          const list = state.pendingDiffReviewsBySession.get(event.sessionId) ?? [];
          if (!list.some((r) => r.requestId === req.requestId)) {
            diffMap = new Map(state.pendingDiffReviewsBySession);
            diffMap.set(event.sessionId, [...list, req]);
          }
        } else if (isPermissionCancelled(event.payload)) {
          const reqId = event.payload.requestId;
          const cur = state.pendingPermissionsBySession.get(event.sessionId);
          if (cur?.some((r) => r.requestId === reqId)) {
            pendingMap = new Map(state.pendingPermissionsBySession);
            // deep-review H2 LOW：filter 后空数组 delete key（与 resolvePermission/setPendingRequests
            // 的 length===0 → delete 对齐；旧实现 set([]) 留空 key 内存微泄漏 + 与同文件约定不一致）。
            const next = cur.filter((r) => r.requestId !== reqId);
            if (next.length === 0) pendingMap.delete(event.sessionId);
            else pendingMap.set(event.sessionId, next);
          }
        } else if (isAskQuestionCancelled(event.payload)) {
          const reqId = event.payload.requestId;
          const cur = state.pendingAskQuestionsBySession.get(event.sessionId);
          if (cur?.some((r) => r.requestId === reqId)) {
            askMap = new Map(state.pendingAskQuestionsBySession);
            const next = cur.filter((r) => r.requestId !== reqId);
            if (next.length === 0) askMap.delete(event.sessionId);
            else askMap.set(event.sessionId, next);
          }
        } else if (isExitPlanCancelled(event.payload)) {
          const reqId = event.payload.requestId;
          const cur = state.pendingExitPlanModesBySession.get(event.sessionId);
          if (cur?.some((r) => r.requestId === reqId)) {
            exitMap = new Map(state.pendingExitPlanModesBySession);
            const next = cur.filter((r) => r.requestId !== reqId);
            if (next.length === 0) exitMap.delete(event.sessionId);
            else exitMap.set(event.sessionId, next);
          }
        } else if (isDiffReviewCancelled(event.payload)) {
          const reqId = event.payload.requestId;
          const cur = state.pendingDiffReviewsBySession.get(event.sessionId);
          if (cur?.some((r) => r.requestId === reqId)) {
            diffMap = new Map(state.pendingDiffReviewsBySession);
            const next = cur.filter((r) => r.requestId !== reqId);
            if (next.length === 0) diffMap.delete(event.sessionId);
            else diffMap.set(event.sessionId, next);
          }
        }
      }
      return {
        recentEventsBySession: m,
        pendingPermissionsBySession: pendingMap,
        pendingAskQuestionsBySession: askMap,
        pendingExitPlanModesBySession: exitMap,
        pendingDiffReviewsBySession: diffMap,
        eventRevisionsBySession: eventRevisions,
        pendingRevisionsBySession: pendingRevisions,
      };
    }),

  pushSummary: (summary) =>
    set((state) => {
      const m = new Map(state.summariesBySession);
      const arr = m.get(summary.sessionId) ?? [];
      m.set(summary.sessionId, [summary, ...arr]);

      // 同步更新 latestSummary（按 ts 比较，避免乱序覆盖更新的）
      const latestMap = new Map(state.latestSummaryBySession);
      const cur = latestMap.get(summary.sessionId);
      if (!cur || summary.ts >= cur.ts) {
        latestMap.set(summary.sessionId, summary);
      }
      return {
        summariesBySession: m,
        latestSummaryBySession: latestMap,
        summaryRevisionsBySession: bumpSessionRevision(
          state.summaryRevisionsBySession,
          summary.sessionId,
        ),
      };
    }),

  setSummaries: (sessionId, summaries) =>
    set((state) => {
      const m = new Map(state.summariesBySession);
      m.set(sessionId, summaries);
      const latestMap = new Map(state.latestSummaryBySession);
      // 空数组也要清掉 latest，否则 SessionCard 会继续显示已被服务端删除的旧 summary
      // （REVIEW_2 修：原本只有 length>0 才 set，length===0 路径漏了 delete）
      if (summaries.length > 0) latestMap.set(sessionId, summaries[0]);
      else latestMap.delete(sessionId);
      return { summariesBySession: m, latestSummaryBySession: latestMap };
    }),

  setLatestSummaries: (map) =>
    set((state) => {
      const next = new Map(state.latestSummaryBySession);
      for (const [sid, s] of Object.entries(map)) {
        if (!state.sessions.has(sid)) continue;
        // REVIEW_35 LOW-B5：与 pushSummary (line 287-289) 对齐做 ts 比较，避免启动 IIFE
        // 顺序问题：listSessions IPC 等 await 期间 summarizer 跑出 fresh summary → emit
        // summary-added → pushSummary 写 latestMap[sid]=fresh → 后到的 setLatestSummaries
        // 用 snapshot_older 覆盖回老 summary，UI 显示 stale 直到下次 push。
        const cur = next.get(sid);
        if (!cur || s.ts >= cur.ts) next.set(sid, s);
      }
      return { latestSummaryBySession: next };
    }),

  setRecentEvents: (sessionId, events) =>
    set((state) => {
      const m = new Map(state.recentEventsBySession);
      // REVIEW_4 H4：与 pushEvent 同样切到 RECENT_LIMIT —— listEvents 调用方传 200，
      // 这里再切一刀防止 push 后立刻 slice(0,30) 让 70 条历史秒蒸发。
      //
      // REVIEW_52 A1 + REVIEW_54：dedup tool-use-start / tool-use-end by toolUseId
      // （与 upsertEvent 同款语义）。listForSession SQL `ORDER BY ts DESC, id DESC`
      // （event-repo.ts F3 修），第一次出现即最新。
      // - tool-use-start：codex item.updated 历史路径在 DB 已有 N 条冗余（v022 + A2
      //   migration 落地后这些会被 cleanup 但 A1 仍兜底拉历史路径）
      // - tool-use-end：codex thread restart/resume/重连同 item.id 重发 item.completed
      //   导致 DB 同 toolUseId 多行（v025 + B2 migration 落地后写入侧 dedup 兜住，本
      //   read-side dedup 仍兜历史已写入的 N 行 + 防 React key collision 点不开 bug）
      // toolUseId 缺失/非 string/空字符串时不 dedup（fallback 不漏渲染，与 upsertEvent
      // 守门一致）。tool-use-start 与 tool-use-end 各自独立 seen set（同 toolUseId 的
      // start + end 是不同 kind 不能互相挤掉，每对仍独立两行）。
      m.set(sessionId, dedupeRecentEvents(events, RECENT_LIMIT));
      return { recentEventsBySession: m };
    }),

  selectSession: (id) => set({ selectedSessionId: id }),

  resolvePermission: (sessionId, requestId) =>
    set((state) => {
      const list = state.pendingPermissionsBySession.get(sessionId);
      if (!list) return {};
      const next = list.filter((r) => r.requestId !== requestId);
      const m = new Map(state.pendingPermissionsBySession);
      if (next.length === 0) m.delete(sessionId);
      else m.set(sessionId, next);
      return {
        pendingPermissionsBySession: m,
        pendingRevisionsBySession: bumpSessionRevision(state.pendingRevisionsBySession, sessionId),
      };
    }),

  resolveAskQuestion: (sessionId, requestId) =>
    set((state) => {
      const list = state.pendingAskQuestionsBySession.get(sessionId);
      if (!list) return {};
      const next = list.filter((r) => r.requestId !== requestId);
      const m = new Map(state.pendingAskQuestionsBySession);
      if (next.length === 0) m.delete(sessionId);
      else m.set(sessionId, next);
      return {
        pendingAskQuestionsBySession: m,
        pendingRevisionsBySession: bumpSessionRevision(state.pendingRevisionsBySession, sessionId),
      };
    }),

  resolveExitPlanMode: (sessionId, requestId) =>
    set((state) => {
      const list = state.pendingExitPlanModesBySession.get(sessionId);
      if (!list) return {};
      const next = list.filter((r) => r.requestId !== requestId);
      const m = new Map(state.pendingExitPlanModesBySession);
      if (next.length === 0) m.delete(sessionId);
      else m.set(sessionId, next);
      return {
        pendingExitPlanModesBySession: m,
        pendingRevisionsBySession: bumpSessionRevision(state.pendingRevisionsBySession, sessionId),
      };
    }),

  resolveDiffReview: (sessionId, requestId) =>
    set((state) => {
      const list = state.pendingDiffReviewsBySession.get(sessionId);
      if (!list) return {};
      const next = list.filter((r) => r.requestId !== requestId);
      const m = new Map(state.pendingDiffReviewsBySession);
      if (next.length === 0) m.delete(sessionId);
      else m.set(sessionId, next);
      return {
        pendingDiffReviewsBySession: m,
        pendingRevisionsBySession: bumpSessionRevision(state.pendingRevisionsBySession, sessionId),
      };
    }),

  setPendingRequests: (sessionId, permissions, askQuestions, exitPlanModes, diffReviews) =>
    set((state) => {
      const p = new Map(state.pendingPermissionsBySession);
      if (permissions.length === 0) p.delete(sessionId);
      else p.set(sessionId, permissions);
      const a = new Map(state.pendingAskQuestionsBySession);
      if (askQuestions.length === 0) a.delete(sessionId);
      else a.set(sessionId, askQuestions);
      const x = new Map(state.pendingExitPlanModesBySession);
      if (exitPlanModes.length === 0) x.delete(sessionId);
      else x.set(sessionId, exitPlanModes);
      const d = new Map(state.pendingDiffReviewsBySession);
      if (diffReviews.length === 0) d.delete(sessionId);
      else d.set(sessionId, diffReviews);
      return {
        pendingPermissionsBySession: p,
        pendingAskQuestionsBySession: a,
        pendingExitPlanModesBySession: x,
        pendingDiffReviewsBySession: d,
      };
    }),

  setPendingRequestsAll: (map) =>
    set(() => {
      // 调用方先用 pendingRevisionsBySession 守住请求窗口；稳定的全量快照可安全替换，
      // 同时清掉 HMR 后主进程已不再等待的旧请求。
      return pendingRequestMapsFromSnapshot(map);
    }),

  renameSession: (fromId, toId) =>
    set((state) => {
      if (fromId === toId) return {};
      // deep-review H2 MED（双方）：M4 防御原对 by-session Map 用「toId 已存在则跳过 set + fromId
      // 已 delete」→ toId 预先有一小段（CLI fork 后 realId 上先到一条 event/pending）时，fromId 的
      // 200 条 recentEvents / summaries / pending 被静默整张丢弃。改为 **merge**：events/summaries
      // 按值拼接（fromId 在前保时间线）后截断 RECENT_LIMIT；pending 按 requestId union。fromId 几乎
      // 总是全新 realId 不触发冲突（claude：toId 预存极罕见），但 merge 让任意 IPC 到达顺序无数据丢失。
      // sessions 这张表里 record 自身的 id 也要同步改
      const sessions = new Map(state.sessions);
      const fromRec = sessions.get(fromId);
      if (fromRec) {
        sessions.delete(fromId);
        // M4：toId 已有 record（emit 乱序时 upsert 先到 / 其他路径已 upsert）则保留较新 record，
        // 不用 fromRec 覆盖；toId 不存在才用 fromRec 兜底设 id 为 toId。
        if (!sessions.has(toId)) {
          sessions.set(toId, { ...fromRec, id: toId });
        }
      }
      return {
        sessions,
        recentEventsBySession: moveSessionEvents(state.recentEventsBySession, fromId, toId, RECENT_LIMIT),
        summariesBySession: moveSessionSummaries(state.summariesBySession, fromId, toId),
        latestSummaryBySession: moveLatestSummary(state.latestSummaryBySession, fromId, toId),
        pendingPermissionsBySession: moveRequestBucket(state.pendingPermissionsBySession, fromId, toId),
        pendingAskQuestionsBySession: moveRequestBucket(state.pendingAskQuestionsBySession, fromId, toId),
        pendingExitPlanModesBySession: moveRequestBucket(state.pendingExitPlanModesBySession, fromId, toId),
        pendingDiffReviewsBySession: moveRequestBucket(state.pendingDiffReviewsBySession, fromId, toId),
        selectedSessionId: state.selectedSessionId === fromId ? toId : state.selectedSessionId,
        sessionRevision: state.sessionRevision + 1,
        eventRevisionsBySession: bumpRenamedSessionRevisions(
          state.eventRevisionsBySession,
          fromId,
          toId,
        ),
        summaryRevisionsBySession: bumpRenamedSessionRevisions(
          state.summaryRevisionsBySession,
          fromId,
          toId,
        ),
        pendingRevisionsBySession: bumpRenamedSessionRevisions(
          state.pendingRevisionsBySession,
          fromId,
          toId,
        ),
      };
    }),
}));
