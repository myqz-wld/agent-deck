import type {
  AdapterSessionMode,
  PermissionMode,
  SessionRecord,
} from '@shared/types';
import type { TrustedContinuationInitialTurn } from './initial-turn';
import type {
  PreparedContinuationContext,
  ResolvedContinuationGenerator,
  ResolvedSuccessorSpec,
} from './types';

export interface RecoveryRuntimeOverrides {
  cwd?: string;
  provider?: string | null;
  permissionMode?: PermissionMode | null;
  sessionMode?: AdapterSessionMode | null;
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict' | null;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access' | null;
  grokSandbox?: string | null;
  model?: string | null;
  thinking?: string | null;
  extraAllowWrite?: readonly string[] | null;
  networkAccessEnabled?: boolean | null;
  additionalDirectories?: readonly string[] | null;
}

export interface CapturedRecoveryContinuation {
  sourceSessionId: string;
  spoolId: string;
  generator: ResolvedContinuationGenerator;
  target: ResolvedSuccessorSpec;
  rawRetentionCeilingTokens: number;
}

export interface PreparedRecoveryContinuation {
  prepared: PreparedContinuationContext;
  turn: TrustedContinuationInitialTurn;
  lowerBudgetRetry: {
    prepared: PreparedContinuationContext;
    turn: TrustedContinuationInitialTurn;
  } | null;
}

export interface RecoveryContinuationHost {
  captureContinuation(input: {
    session: SessionRecord;
    overrides?: RecoveryRuntimeOverrides;
  }): CapturedRecoveryContinuation;
  prepareContinuation(input: {
    capture: CapturedRecoveryContinuation;
    continuationInstruction: string;
    signal?: AbortSignal;
  }): Promise<PreparedRecoveryContinuation>;
  cleanupContinuation(capture: CapturedRecoveryContinuation): void;
}
