import { create } from 'zustand';
import type { PlanDeepReviewSession } from '@shared/types';

export interface PlanDeepReviewQuote {
  id: number;
  text: string;
}

export interface PlanDeepReviewDraftState {
  child: PlanDeepReviewSession | null;
  startError: string | null;
  question: string;
  questionBusy: boolean;
  questionError: string | null;
  planQuotes: PlanDeepReviewQuote[];
  feedback: string;
  feedbackDraftBusy: boolean;
  feedbackDraftError: string | null;
  feedbackDraftGenerated: boolean;
}

type DraftPatch =
  | Partial<PlanDeepReviewDraftState>
  | ((current: PlanDeepReviewDraftState) => Partial<PlanDeepReviewDraftState>);

interface PlanDeepReviewStore {
  drafts: Map<string, PlanDeepReviewDraftState>;
  patchDraft: (requestId: string, patch: DraftPatch) => void;
  patchExistingDraft: (requestId: string, patch: DraftPatch) => void;
  clearDraft: (requestId: string) => void;
}

const EMPTY_QUOTES: PlanDeepReviewQuote[] = [];

function applyPatch(
  current: PlanDeepReviewDraftState,
  patch: DraftPatch,
): PlanDeepReviewDraftState {
  const delta = typeof patch === 'function' ? patch(current) : patch;
  return { ...current, ...delta };
}

export const EMPTY_PLAN_DEEP_REVIEW_DRAFT: PlanDeepReviewDraftState = {
  child: null,
  startError: null,
  question: '',
  questionBusy: false,
  questionError: null,
  planQuotes: EMPTY_QUOTES,
  feedback: '',
  feedbackDraftBusy: false,
  feedbackDraftError: null,
  feedbackDraftGenerated: false,
};

export const usePlanDeepReviewStore = create<PlanDeepReviewStore>((set) => ({
  drafts: new Map(),

  patchDraft: (requestId, patch) => {
    set((state) => {
      const current = state.drafts.get(requestId) ?? EMPTY_PLAN_DEEP_REVIEW_DRAFT;
      const drafts = new Map(state.drafts);
      drafts.set(requestId, applyPatch(current, patch));
      return { drafts };
    });
  },

  patchExistingDraft: (requestId, patch) => {
    set((state) => {
      const current = state.drafts.get(requestId);
      if (!current) return state;
      const drafts = new Map(state.drafts);
      drafts.set(requestId, applyPatch(current, patch));
      return { drafts };
    });
  },

  clearDraft: (requestId) => {
    set((state) => {
      if (!state.drafts.has(requestId)) return state;
      const drafts = new Map(state.drafts);
      drafts.delete(requestId);
      return { drafts };
    });
  },
}));
