import { create } from 'zustand';
import type {
  AgentEvent,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  PermissionRequest,
  SessionRecord,
  SummaryRecord,
} from '@shared/types';

interface State {
  sessions: Map<string, SessionRecord>;
  selectedSessionId: string | null;
  view: 'live' | 'history' | 'settings';
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
  setSessions: (records: SessionRecord[]) => void;
  upsertSession: (record: SessionRecord) => void;
  removeSession: (id: string) => void;
  pushEvent: (event: AgentEvent) => void;
  pushSummary: (summary: SummaryRecord) => void;
  setSummaries: (sessionId: string, summaries: SummaryRecord[]) => void;
  setLatestSummaries: (map: Record<string, SummaryRecord>) => void;
  setRecentEvents: (sessionId: string, events: AgentEvent[]) => void;
  selectSession: (id: string | null) => void;
  setView: (view: 'live' | 'history' | 'settings') => void;
  resolvePermission: (sessionId: string, requestId: string) => void;
  resolveAskQuestion: (sessionId: string, requestId: string) => void;
  resolveExitPlanMode: (sessionId: string, requestId: string) => void;
  /** 重建 pending 列表（HMR / 重启后从主进程拉一次，覆盖该 session 的 pending）。 */
  setPendingRequests: (
    sessionId: string,
    permissions: PermissionRequest[],
    askQuestions: AskUserQuestionRequest[],
    exitPlanModes: ExitPlanModeRequest[],
  ) => void;
  /** 全量灌入 pending（启动时一次性同步多个 session）。 */
  setPendingRequestsAll: (
    map: Record<
      string,
      {
        permissions: PermissionRequest[];
        askQuestions: AskUserQuestionRequest[];
        exitPlanModes: ExitPlanModeRequest[];
      }
    >,
  ) => void;
  /** SDK fallback：tempKey → realId 整体迁移所有 by-session 状态，selectedId 跟着改。 */
  renameSession: (fromId: string, toId: string) => void;
}

const RECENT_LIMIT = 30;
const EMPTY_REQUESTS: PermissionRequest[] = [];
const EMPTY_ASK_QUESTIONS: AskUserQuestionRequest[] = [];
const EMPTY_EXIT_PLAN_MODES: ExitPlanModeRequest[] = [];

function isPermissionRequest(payload: unknown): payload is PermissionRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'permission-request' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

function isAskUserQuestion(payload: unknown): payload is AskUserQuestionRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'ask-user-question' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

function isExitPlanMode(payload: unknown): payload is ExitPlanModeRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'exit-plan-mode' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

function isPermissionCancelled(payload: unknown): payload is { requestId: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'permission-cancelled' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

function isAskQuestionCancelled(payload: unknown): payload is { requestId: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'ask-question-cancelled' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

function isExitPlanCancelled(payload: unknown): payload is { requestId: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'exit-plan-cancelled' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

export { EMPTY_REQUESTS, EMPTY_ASK_QUESTIONS, EMPTY_EXIT_PLAN_MODES };

export const useSessionStore = create<State>((set) => ({
  sessions: new Map(),
  selectedSessionId: null,
  view: 'live',
  recentEventsBySession: new Map(),
  summariesBySession: new Map(),
  latestSummaryBySession: new Map(),
  pendingPermissionsBySession: new Map(),
  pendingAskQuestionsBySession: new Map(),
  pendingExitPlanModesBySession: new Map(),

  setSessions: (records) => {
    const m = new Map<string, SessionRecord>();
    for (const r of records) m.set(r.id, r);
    set({ sessions: m });
  },

  upsertSession: (record) =>
    set((state) => {
      const m = new Map(state.sessions);
      m.set(record.id, record);
      return { sessions: m };
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
      return {
        sessions: m,
        pendingPermissionsBySession: p,
        pendingAskQuestionsBySession: a,
        pendingExitPlanModesBySession: x,
        selectedSessionId: state.selectedSessionId === id ? null : state.selectedSessionId,
      };
    }),

  pushEvent: (event) =>
    set((state) => {
      const m = new Map(state.recentEventsBySession);
      const arr = m.get(event.sessionId) ?? [];
      const next = [event, ...arr].slice(0, RECENT_LIMIT);
      m.set(event.sessionId, next);

      let pendingMap = state.pendingPermissionsBySession;
      let askMap = state.pendingAskQuestionsBySession;
      let exitMap = state.pendingExitPlanModesBySession;
      if (event.kind === 'waiting-for-user') {
        if (isPermissionRequest(event.payload)) {
          const req = event.payload;
          const list = state.pendingPermissionsBySession.get(event.sessionId) ?? [];
          // 去重：同一 requestId 的请求只保留一条，避免主进程 / IPC / StrictMode 的
          // 重复触发让用户看到「两条」实际是同一条的复制——点一个会把两条一起 filter 掉。
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
        } else if (isPermissionCancelled(event.payload)) {
          // SDK 端 abort：从 pending 列表移除，banner / 活动流自然不再可点
          const reqId = event.payload.requestId;
          const cur = state.pendingPermissionsBySession.get(event.sessionId);
          if (cur?.some((r) => r.requestId === reqId)) {
            pendingMap = new Map(state.pendingPermissionsBySession);
            pendingMap.set(
              event.sessionId,
              cur.filter((r) => r.requestId !== reqId),
            );
          }
        } else if (isAskQuestionCancelled(event.payload)) {
          const reqId = event.payload.requestId;
          const cur = state.pendingAskQuestionsBySession.get(event.sessionId);
          if (cur?.some((r) => r.requestId === reqId)) {
            askMap = new Map(state.pendingAskQuestionsBySession);
            askMap.set(
              event.sessionId,
              cur.filter((r) => r.requestId !== reqId),
            );
          }
        } else if (isExitPlanCancelled(event.payload)) {
          const reqId = event.payload.requestId;
          const cur = state.pendingExitPlanModesBySession.get(event.sessionId);
          if (cur?.some((r) => r.requestId === reqId)) {
            exitMap = new Map(state.pendingExitPlanModesBySession);
            exitMap.set(
              event.sessionId,
              cur.filter((r) => r.requestId !== reqId),
            );
          }
        }
      }
      return {
        recentEventsBySession: m,
        pendingPermissionsBySession: pendingMap,
        pendingAskQuestionsBySession: askMap,
        pendingExitPlanModesBySession: exitMap,
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
      return { summariesBySession: m, latestSummaryBySession: latestMap };
    }),

  setSummaries: (sessionId, summaries) =>
    set((state) => {
      const m = new Map(state.summariesBySession);
      m.set(sessionId, summaries);
      const latestMap = new Map(state.latestSummaryBySession);
      if (summaries.length > 0) latestMap.set(sessionId, summaries[0]);
      return { summariesBySession: m, latestSummaryBySession: latestMap };
    }),

  setLatestSummaries: (map) =>
    set((state) => {
      const next = new Map(state.latestSummaryBySession);
      for (const [sid, s] of Object.entries(map)) next.set(sid, s);
      return { latestSummaryBySession: next };
    }),

  setRecentEvents: (sessionId, events) =>
    set((state) => {
      const m = new Map(state.recentEventsBySession);
      m.set(sessionId, events);
      return { recentEventsBySession: m };
    }),

  selectSession: (id) => set({ selectedSessionId: id }),
  setView: (view) => set({ view }),

  resolvePermission: (sessionId, requestId) =>
    set((state) => {
      const list = state.pendingPermissionsBySession.get(sessionId);
      if (!list) return {};
      const next = list.filter((r) => r.requestId !== requestId);
      const m = new Map(state.pendingPermissionsBySession);
      if (next.length === 0) m.delete(sessionId);
      else m.set(sessionId, next);
      return { pendingPermissionsBySession: m };
    }),

  resolveAskQuestion: (sessionId, requestId) =>
    set((state) => {
      const list = state.pendingAskQuestionsBySession.get(sessionId);
      if (!list) return {};
      const next = list.filter((r) => r.requestId !== requestId);
      const m = new Map(state.pendingAskQuestionsBySession);
      if (next.length === 0) m.delete(sessionId);
      else m.set(sessionId, next);
      return { pendingAskQuestionsBySession: m };
    }),

  resolveExitPlanMode: (sessionId, requestId) =>
    set((state) => {
      const list = state.pendingExitPlanModesBySession.get(sessionId);
      if (!list) return {};
      const next = list.filter((r) => r.requestId !== requestId);
      const m = new Map(state.pendingExitPlanModesBySession);
      if (next.length === 0) m.delete(sessionId);
      else m.set(sessionId, next);
      return { pendingExitPlanModesBySession: m };
    }),

  setPendingRequests: (sessionId, permissions, askQuestions, exitPlanModes) =>
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
      return {
        pendingPermissionsBySession: p,
        pendingAskQuestionsBySession: a,
        pendingExitPlanModesBySession: x,
      };
    }),

  setPendingRequestsAll: (map) =>
    set(() => {
      const p = new Map<string, PermissionRequest[]>();
      const a = new Map<string, AskUserQuestionRequest[]>();
      const x = new Map<string, ExitPlanModeRequest[]>();
      for (const [sid, { permissions, askQuestions, exitPlanModes }] of Object.entries(map)) {
        if (permissions.length > 0) p.set(sid, permissions);
        if (askQuestions.length > 0) a.set(sid, askQuestions);
        if (exitPlanModes.length > 0) x.set(sid, exitPlanModes);
      }
      return {
        pendingPermissionsBySession: p,
        pendingAskQuestionsBySession: a,
        pendingExitPlanModesBySession: x,
      };
    }),

  renameSession: (fromId, toId) =>
    set((state) => {
      if (fromId === toId) return {};
      const moveMapKey = <V,>(src: Map<string, V>): Map<string, V> => {
        if (!src.has(fromId)) return src;
        const next = new Map(src);
        const v = next.get(fromId)!;
        next.delete(fromId);
        next.set(toId, v);
        return next;
      };
      // sessions 这张表里 record 自身的 id 也要同步改
      const sessions = new Map(state.sessions);
      const fromRec = sessions.get(fromId);
      if (fromRec) {
        sessions.delete(fromId);
        sessions.set(toId, { ...fromRec, id: toId });
      }
      return {
        sessions,
        recentEventsBySession: moveMapKey(state.recentEventsBySession),
        summariesBySession: moveMapKey(state.summariesBySession),
        latestSummaryBySession: moveMapKey(state.latestSummaryBySession),
        pendingPermissionsBySession: moveMapKey(state.pendingPermissionsBySession),
        pendingAskQuestionsBySession: moveMapKey(state.pendingAskQuestionsBySession),
        pendingExitPlanModesBySession: moveMapKey(state.pendingExitPlanModesBySession),
        selectedSessionId: state.selectedSessionId === fromId ? toId : state.selectedSessionId,
      };
    }),
}));

