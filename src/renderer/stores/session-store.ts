import { create } from 'zustand';
import type {
  AgentEvent,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  PermissionRequest,
  SessionRecord,
  SummaryRecord,
} from '@shared/types';
import {
  isAskQuestionCancelled,
  isAskUserQuestion,
  isExitPlanCancelled,
  isExitPlanMode,
  isPermissionCancelled,
  isPermissionRequest,
} from './event-type-guards';

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

// 8 个 isXxx type guards 已迁出到 ./event-type-guards.ts（CHANGELOG_52 Step 2，纯 type guard 无副作用）

/**
 * 把新事件插入 recentEvents 数组。**仅 tool-use-start 同 toolUseId 走 in-place 替换**，
 * 其它 kind 都按 unshift 倒序追加（与原行为字节级一致）。
 *
 * 替换语义（CHANGELOG_<X> A1）：codex item.updated 增量重发同 toolUseId 的 tool-use-start，
 * 让 UI 实时显示 aggregated_output 增长。如果不替换：
 *   1. 30 秒长 command 推几十条 tool-use-start 撑爆 RECENT_LIMIT 把上下文挤掉
 *   2. React eventKey 虽然 dedup（相同 key 视作同 row），但 store 内存仍多份冗余
 * 替换后：tool-use-start 在数组里就一份，位置不变（保时间线），payload 更新到最新。
 *
 * 替换边界：仅 `kind === 'tool-use-start'` + payload.toolUseId 是非空 string 时生效。
 *   - claude SDK 的 tool-use-start 有 toolUseId（hook 通道也透传）→ 同样受益
 *   - tool-use-end 不替换：终态事件，每对 start/end 独立行
 *   - 其它 kind（message / thinking / file-changed 等）多次 push 是不同事件，按时间排
 *
 * 不动 hookOrigin / source 字段；ts 也用新事件的 ts（替换为最新一次更新时间）。
 */
function upsertEvent(arr: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (event.kind === 'tool-use-start') {
    const tid = (event.payload as { toolUseId?: unknown })?.toolUseId;
    if (typeof tid === 'string' && tid) {
      const idx = arr.findIndex(
        (e) =>
          e.kind === 'tool-use-start' &&
          (e.payload as { toolUseId?: unknown })?.toolUseId === tid,
      );
      if (idx >= 0) {
        const next = arr.slice();
        next[idx] = event;
        return next;
      }
    }
  }
  return [event, ...arr].slice(0, RECENT_LIMIT);
}

// EMPTY_REQUESTS / EMPTY_ASK_QUESTIONS / EMPTY_EXIT_PLAN_MODES 已在文件上方导出

export const useSessionStore = create<State>((set) => ({
  sessions: new Map(),
  selectedSessionId: null,
  recentEventsBySession: new Map(),
  summariesBySession: new Map(),
  latestSummaryBySession: new Map(),
  pendingPermissionsBySession: new Map(),
  pendingAskQuestionsBySession: new Map(),
  pendingExitPlanModesBySession: new Map(),

  setSessions: (records) => {
    // 全量替换会话列表（启动 / HMR / history 视图初始拉）。
    // 同时按新 id 集合 prune 所有 by-session 衍生缓存，否则被 history 清理 / 删除掉的
    // 会话会留 orphan 在 7 张 Map 里（renameSession / removeSession 已对齐这个范式）。
    set((state) => {
      const m = new Map<string, SessionRecord>();
      for (const r of records) m.set(r.id, r);
      const validIds = new Set(records.map((r) => r.id));
      const prune = <V>(src: Map<string, V>): Map<string, V> => {
        let changed = false;
        for (const k of src.keys()) {
          if (!validIds.has(k)) {
            changed = true;
            break;
          }
        }
        if (!changed) return src;
        const next = new Map<string, V>();
        for (const [k, v] of src) if (validIds.has(k)) next.set(k, v);
        return next;
      };
      return {
        sessions: m,
        recentEventsBySession: prune(state.recentEventsBySession),
        summariesBySession: prune(state.summariesBySession),
        latestSummaryBySession: prune(state.latestSummaryBySession),
        pendingPermissionsBySession: prune(state.pendingPermissionsBySession),
        pendingAskQuestionsBySession: prune(state.pendingAskQuestionsBySession),
        pendingExitPlanModesBySession: prune(state.pendingExitPlanModesBySession),
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
        recentEventsBySession: re,
        summariesBySession: su,
        latestSummaryBySession: ls,
        selectedSessionId: state.selectedSessionId === id ? null : state.selectedSessionId,
      };
    }),

  pushEvent: (event) =>
    set((state) => {
      const m = new Map(state.recentEventsBySession);
      const arr = m.get(event.sessionId) ?? [];
      const next = upsertEvent(arr, event);
      m.set(event.sessionId, next);

      let pendingMap = state.pendingPermissionsBySession;
      let askMap = state.pendingAskQuestionsBySession;
      let exitMap = state.pendingExitPlanModesBySession;
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
        } else if (isPermissionCancelled(event.payload)) {
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
      m.set(sessionId, events.slice(0, RECENT_LIMIT));
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
        // REVIEW_7 M4：toId 已有 entry（IPC 顺序乱序、其他路径已积累）时不覆盖，
        // 保留 toId 已有数据避免数据丢失（fork / fallback 场景下 NEW_ID 几乎是新 id 不会触发，
        // 但加这道防御让 renameSession 对任意 IPC 到达顺序鲁棒，不依赖未文档化的同步保证）。
        if (!next.has(toId)) {
          next.set(toId, v);
        }
        return next;
      };
      // sessions 这张表里 record 自身的 id 也要同步改
      const sessions = new Map(state.sessions);
      const fromRec = sessions.get(fromId);
      if (fromRec) {
        sessions.delete(fromId);
        // REVIEW_7 M4：toId 已有 record（emit 乱序时 upsert 先到 / 其他路径已 upsert）则保留较新 record，
        // 不用 fromRec 覆盖；toId 不存在才用 fromRec 兜底设 id 为 toId。
        if (!sessions.has(toId)) {
          sessions.set(toId, { ...fromRec, id: toId });
        }
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

