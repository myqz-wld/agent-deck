import type { SessionThinkingLevel } from '@shared/session-metadata';
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
  model: string | null;
  thinking: SessionThinkingLevel;
  contextWindowTokens: number | null;
  configFingerprint: string;
}

export interface ResolvedSuccessorSpec {
  adapter: SessionAdapterId;
  model: string | null;
  thinking: SessionThinkingLevel | null;
  sandbox: unknown;
  permissionMode: string | null;
  sessionMode?: AdapterSessionMode | null;
  networkAccessEnabled: boolean | null;
  additionalDirectories: string[];
  contextWindowTokens: number | null;
  contextWindowSource?: 'observed' | 'fallback' | null;
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
    | 'legacy-wrapper-excluded'
    | 'legacy-wrapper-unwrapped'
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
  version: 1;
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

export interface RawContinuationUserInput {
  eventId: number;
  effectiveRevision: number;
  ts: number;
  text: string;
  attachments: Array<{ name?: string; path?: string; mimeType?: string }>;
  origin: 'user' | 'cross-session' | 'legacy-unwrapped';
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
