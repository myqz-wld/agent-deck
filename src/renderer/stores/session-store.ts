import { create } from 'zustand';
import type {
  AskUserQuestionRequest,
  DiffReviewRequest,
  ExitPlanModeRequest,
  PermissionRequest,
  SessionRecord,
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
  clearAttachmentPayloadSession,
  renameAttachmentPayloadSession,
} from '@renderer/hooks/image-attachments/payload-sidecar';
import {
  moveComposerSession,
  pruneComposerSessions,
  removeComposerSession,
} from './session-store-composer';
import {
  createComposerStoreActions,
  createComposerStoreFields,
} from './session-store-composer-actions';
import type { SessionStoreState } from './session-store-state';
import {
  moveLatestSummary,
  moveSessionEvents,
  moveSessionSummaries,
  normalizeSummaries,
  upsertSummary,
} from './session-store-rename';

/** Matches the main-process list-events window so live pushes do not shrink history. */
export const RECENT_LIMIT = 200;
export const EMPTY_REQUESTS: PermissionRequest[] = [];
export const EMPTY_ASK_QUESTIONS: AskUserQuestionRequest[] = [];
export const EMPTY_EXIT_PLAN_MODES: ExitPlanModeRequest[] = [];
export const EMPTY_DIFF_REVIEWS: DiffReviewRequest[] = [];

export const useSessionStore = create<SessionStoreState>((set) => ({
  sessions: new Map(),
  selectedSessionId: null,
  recentEventsBySession: new Map(),
  summariesBySession: new Map(),
  latestSummaryBySession: new Map(),
  pendingPermissionsBySession: new Map(),
  pendingAskQuestionsBySession: new Map(),
  pendingExitPlanModesBySession: new Map(),
  pendingDiffReviewsBySession: new Map(),
  pendingInitialized: false,
  sessionRevision: 0,
  eventRevisionsBySession: new Map(),
  summaryRevisionsBySession: new Map(),
  pendingRevisionsBySession: new Map(),
  ...createComposerStoreFields(),

  setSessions: (records) => {
    let releasedComposerIds: string[] = [];
    set((state) => {
      const m = new Map<string, SessionRecord>();
      for (const r of records) m.set(r.id, r);
      const validIds = new Set(records.map((r) => r.id));
      const composers = pruneComposerSessions(
        state.composerBySession,
        state.composerAliases,
        validIds,
      );
      releasedComposerIds = composers.releasedSessionIds;
      return {
        sessions: m,
        recentEventsBySession: pruneMapByValidIds(state.recentEventsBySession, validIds),
        summariesBySession: pruneMapByValidIds(state.summariesBySession, validIds),
        latestSummaryBySession: pruneMapByValidIds(state.latestSummaryBySession, validIds),
        pendingPermissionsBySession: pruneMapByValidIds(state.pendingPermissionsBySession, validIds),
        pendingAskQuestionsBySession: pruneMapByValidIds(state.pendingAskQuestionsBySession, validIds),
        pendingExitPlanModesBySession: pruneMapByValidIds(state.pendingExitPlanModesBySession, validIds),
        pendingDiffReviewsBySession: pruneMapByValidIds(state.pendingDiffReviewsBySession, validIds),
        composerBySession: composers.composerBySession,
        composerAliases: composers.composerAliases,
        selectedSessionId:
          state.selectedSessionId !== null && !validIds.has(state.selectedSessionId)
            ? null
            : state.selectedSessionId,
      };
    });
    for (const sessionId of releasedComposerIds) clearAttachmentPayloadSession(sessionId);
  },

  upsertSession: (record) =>
    set((state) => {
      const m = new Map(state.sessions);
      m.set(record.id, record);
      return { sessions: m, sessionRevision: state.sessionRevision + 1 };
    }),

  removeSession: (id) => {
    let releasedComposerId = id;
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
      const re = new Map(state.recentEventsBySession);
      re.delete(id);
      const su = new Map(state.summariesBySession);
      su.delete(id);
      const ls = new Map(state.latestSummaryBySession);
      ls.delete(id);
      const composers = removeComposerSession(
        state.composerBySession,
        state.composerAliases,
        id,
      );
      releasedComposerId = composers.resolvedId;
      return {
        sessions: m,
        pendingPermissionsBySession: p,
        pendingAskQuestionsBySession: a,
        pendingExitPlanModesBySession: x,
        pendingDiffReviewsBySession: d,
        recentEventsBySession: re,
        summariesBySession: su,
        latestSummaryBySession: ls,
        composerBySession: composers.composerBySession,
        composerAliases: composers.composerAliases,
        selectedSessionId: state.selectedSessionId === id ? null : state.selectedSessionId,
        sessionRevision: state.sessionRevision + 1,
        eventRevisionsBySession: bumpSessionRevision(state.eventRevisionsBySession, id),
        summaryRevisionsBySession: bumpSessionRevision(state.summaryRevisionsBySession, id),
        pendingRevisionsBySession: bumpSessionRevision(state.pendingRevisionsBySession, id),
      };
    });
    clearAttachmentPayloadSession(releasedComposerId);
  },

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
      const nextSummaries = upsertSummary(arr, summary);
      m.set(summary.sessionId, nextSummaries);

      const latestMap = new Map(state.latestSummaryBySession);
      const latest = nextSummaries[0];
      if (latest) latestMap.set(summary.sessionId, latest);
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
      const normalized = normalizeSummaries(summaries, sessionId);
      m.set(sessionId, normalized);
      const latestMap = new Map(state.latestSummaryBySession);
      if (normalized.length > 0) latestMap.set(sessionId, normalized[0]!);
      else latestMap.delete(sessionId);
      return { summariesBySession: m, latestSummaryBySession: latestMap };
    }),

  setLatestSummaries: (map) =>
    set((state) => {
      const next = new Map(state.latestSummaryBySession);
      for (const [sid, s] of Object.entries(map)) {
        if (!state.sessions.has(sid)) continue;
        const cur = next.get(sid);
        if (!cur || s.ts >= cur.ts) next.set(sid, s);
      }
      return { latestSummaryBySession: next };
    }),

  setRecentEvents: (sessionId, events) =>
    set((state) => {
      const m = new Map(state.recentEventsBySession);
      // History rows and live rows share the same bounded tool-use deduplication.
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
    set(() => ({ ...pendingRequestMapsFromSnapshot(map), pendingInitialized: true })),

  markPendingInitialized: () => set({ pendingInitialized: true }),

  renameSession: (fromId, toId) => {
    if (fromId === toId) return;
    set((state) => {
      const sessions = new Map(state.sessions);
      const fromRec = sessions.get(fromId);
      if (fromRec) {
        sessions.delete(fromId);
        if (!sessions.has(toId)) {
          sessions.set(toId, { ...fromRec, id: toId });
        }
      }
      const composers = moveComposerSession(
        state.composerBySession,
        state.composerAliases,
        fromId,
        toId,
      );
      return {
        sessions,
        recentEventsBySession: moveSessionEvents(state.recentEventsBySession, fromId, toId, RECENT_LIMIT),
        summariesBySession: moveSessionSummaries(state.summariesBySession, fromId, toId),
        latestSummaryBySession: moveLatestSummary(state.latestSummaryBySession, fromId, toId),
        pendingPermissionsBySession: moveRequestBucket(state.pendingPermissionsBySession, fromId, toId),
        pendingAskQuestionsBySession: moveRequestBucket(state.pendingAskQuestionsBySession, fromId, toId),
        pendingExitPlanModesBySession: moveRequestBucket(state.pendingExitPlanModesBySession, fromId, toId),
        pendingDiffReviewsBySession: moveRequestBucket(state.pendingDiffReviewsBySession, fromId, toId),
        composerBySession: composers.composerBySession,
        composerAliases: composers.composerAliases,
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
    });
    renameAttachmentPayloadSession(fromId, toId);
  },

  ...createComposerStoreActions(set),
}));
