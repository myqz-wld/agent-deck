import type { SessionThinkingLevel } from '@shared/session-metadata';
import type { ResolvedContextCapacity } from '@shared/types/context-window';
import type {
  AdapterSessionMode,
  SessionAdapterId,
} from '@shared/types/session';
import type {
  ContinuationCheckpoint,
  ContinuationFact,
} from './checkpoint-schema';

export type ContinuationPurpose = 'handoff' | 'recovery';

export interface ResolvedContinuationGenerator {
  adapter: SessionAdapterId;
  provider?: string | null;
  model: string | null;
  thinking: SessionThinkingLevel;
  /** Immutable capacity snapshot resolved together with this generator configuration. */
  contextCapacity: ResolvedContextCapacity;
  configFingerprint: string;
}

export interface ResolvedSuccessorSpec {
  adapter: SessionAdapterId;
  provider?: string | null;
  model: string | null;
  thinking: SessionThinkingLevel | null;
  sandbox: unknown;
  permissionMode: string | null;
  sessionMode?: AdapterSessionMode | null;
  networkAccessEnabled: boolean | null;
  additionalDirectories: string[];
  /** Immutable capacity snapshot; deliberately excluded from runtimeFingerprint. */
  contextCapacity: ResolvedContextCapacity;
  runtimeFingerprint: string;
}

export interface ContinuationPreparationLimits {
  rawRetentionCeilingTokens: number;
  deadlineMs: number;
  maxFoldCalls: number;
  maxRepairCalls: number;
}

export interface PrepareContinuationContextInput {
  purpose: ContinuationPurpose;
  sourceSessionId: string;
  continuationInstruction: string;
  generator: ResolvedContinuationGenerator;
  target: ResolvedSuccessorSpec;
  source: { mode: 'capture' } | { mode: 'immutable-spool'; spoolId: string };
  limits: ContinuationPreparationLimits;
  signal?: AbortSignal;
}

export interface ContinuationSourceBoundary {
  eventRevision: number;
  rebuildAfterRevision: number;
  maxEventId: number | null;
}

export interface ContinuationWarning {
  code:
    | 'checkpoint-generation-failed'
    | 'checkpoint-repair-failed'
    | 'checkpoint-projected'
    | 'coverage-gap'
    | 'context-wrapper-excluded'
    | 'raw-boundary-truncated'
    | 'raw-history-omitted'
    | 'checkpoint-omitted'
    | 'target-capacity-fallback'
    | 'instruction-only'
    | 'spool-resource-guard';
  message: string;
}

export type ContinuationQuality =
  | 'full'
  | 'projected'
  | 'coverage-gap'
  | 'raw-only'
  | 'instruction-only';

export interface CheckpointProjection {
  formatVersion: 1;
  canonicalHash: string;
  sourceEventRevision: number;
  facts: Partial<Record<Exclude<keyof ContinuationCheckpoint, 'formatVersion'>, ContinuationFact[]>>;
  omittedFacts: number;
}

export interface PreparedContinuationContext {
  version: 2;
  providerPrompt: string;
  persistedUserText: string;
  source: ContinuationSourceBoundary;
  checkpoint: {
    id: number | null;
    throughRevision: number;
    formatVersion: number;
    refreshed: boolean;
  };
  projection: {
    canonicalHash: string | null;
    omittedFacts: number;
  };
  quality: ContinuationQuality;
  metrics: {
    rawRetentionCeilingTokens: number;
    targetPromptCapacityTokens: number;
    checkpointProjectionBudgetTokens: number;
    generatorFoldInputBudgetTokens: number;
    estimatedPromptTokens: number;
    checkpointTokens: number;
    rawTailTokens: number;
    includedUserMessages: number;
    truncatedBoundaryMessages: number;
    foldCalls: number;
    repairCalls: number;
    elapsedMs: number;
    uncoveredRevisionRange: { from: number; to: number } | null;
  };
  warnings: ContinuationWarning[];
  preparationHash: string;
  /** Internal cache/spool handle; never expose it through renderer or public MCP results. */
  spoolId: string;
}

/** One immutable fold rendered for the primary target policy and, when needed, one smaller retry. */
export interface PreparedContinuationCandidates {
  primary: PreparedContinuationContext;
  lowerBudgetRetry: PreparedContinuationContext | null;
}

export interface RawContinuationUserInput {
  eventId: number;
  effectiveRevision: number;
  ts: number;
  text: string;
  attachments: Array<{ name?: string; path?: string; mimeType?: string }>;
  origin: 'user' | 'cross-session';
  truncated: boolean;
  omittedEstimatedTokens: number;
}

export interface NormalizedContinuationEvent {
  eventId: number;
  effectiveRevision: number;
  kind: string;
  ts: number;
  payload: unknown;
  sourceBytes: number;
  sourceHash: string;
  truncated: boolean;
}
