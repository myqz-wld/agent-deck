import type { AgentEvent, AgentToolKind, GrokUsageWatermark } from '@shared/types';

import type { GrokLiveRateState } from './live-token-rate';

export type GrokUsageSource = 'none' | 'standard' | 'extension';

export interface PendingGrokStandardUsage {
  resolve: (emit: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GrokTranslationState {
  toolNames: Map<string, string>;
  toolKinds: Map<string, AgentToolKind>;
  startedToolIds: Set<string>;
  thinkingToolIds: Set<string>;
  pendingText: {
    kind: 'message' | 'thinking';
    messageId: string | null;
    chunks: string[];
  } | null;
  assistantObservedForCurrentTurn: boolean;
  /** Full assistant text observed on live ACP for suffix-only native-history recovery. */
  currentAssistantText: string;
  lastUsage: GrokUsageWatermark | null;
  /** False only for a recovered legacy session that has no persisted cumulative baseline yet. */
  standardUsageBaselineReady: boolean;
  standardUsageObservedForCurrentTurn: boolean;
  extensionUsageForCurrentTurn: boolean;
  usageSource: GrokUsageSource;
  pendingStandardUsage: PendingGrokStandardUsage | null;
  /** Absolute/accounted cumulative frontier captured before the current turn. */
  turnStartUsage: GrokUsageWatermark | null;
  /** Stable local id used until the provider extension reveals its prompt id. */
  currentTurnUsageId: string | null;
  /** Wall-clock boundary used only to disambiguate an explicitly older late extension. */
  currentTurnStartedAt: number | null;
  /** Optional ACP user-message id. It is a correlation hint, never assumed to equal prompt_id. */
  currentProviderPromptId: string | null;
  currentExtensionPromptId: string | null;
  currentExtensionUsage: GrokUsageWatermark | null;
  /** Exact standard event retained during the short extension grace window. */
  currentStandardUsageEvent: AgentEvent | null;
  /** Raw cumulative fields reported by ACP for the retained standard event. */
  currentStandardUsageSnapshot: GrokUsageWatermark | null;
  /** Standard rows awaiting a provider prompt id, oldest first. */
  uncorrelatedStandardUsage: AgentEvent[];
  /** Bounded provider prompt-id snapshots for idempotent progressive extension updates. */
  extensionUsageByPromptId: Map<string, GrokUsageWatermark>;
  /** Canonical per-turn usage already represented by each provider prompt row. */
  canonicalUsageByPromptId: Map<string, GrokUsageWatermark>;
  /** Prompt rows whose incremental corrections may safely advance the cumulative frontier. */
  baselineTrackedPromptIds: Set<string>;
  /** Per-prompt metrics already covered by an exact cumulative snapshot with unknown turn delta. */
  frontierCoveredMetricScopeByPromptId: Map<string, number>;
  /** Bounded prompt ids belonging to turns that are no longer current. */
  completedProviderPromptIds: Set<string>;
  liveRate: GrokLiveRateState | null;
}
