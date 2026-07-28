import type {
  AgentEvent,
  AskUserQuestionRequest,
  DiffReviewRequest,
  ExitPlanModeRequest,
  PermissionRequest,
  SessionRecord,
  SummaryRecord,
} from '@shared/types';
import type {
  ComposerStoreActions,
  ComposerStoreFields,
} from './session-store-composer-actions';

export interface SessionStoreState extends ComposerStoreFields, ComposerStoreActions {
  sessions: Map<string, SessionRecord>;
  selectedSessionId: string | null;
  recentEventsBySession: Map<string, AgentEvent[]>;
  summariesBySession: Map<string, SummaryRecord[]>;
  latestSummaryBySession: Map<string, SummaryRecord>;
  pendingPermissionsBySession: Map<string, PermissionRequest[]>;
  pendingAskQuestionsBySession: Map<string, AskUserQuestionRequest[]>;
  pendingExitPlanModesBySession: Map<string, ExitPlanModeRequest[]>;
  pendingDiffReviewsBySession: Map<string, DiffReviewRequest[]>;
  sessionRevision: number;
  eventRevisionsBySession: Map<string, number>;
  summaryRevisionsBySession: Map<string, number>;
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
  setPendingRequests: (
    sessionId: string,
    permissions: PermissionRequest[],
    askQuestions: AskUserQuestionRequest[],
    exitPlanModes: ExitPlanModeRequest[],
    diffReviews: DiffReviewRequest[],
  ) => void;
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
  renameSession: (fromId: string, toId: string) => void;
}
