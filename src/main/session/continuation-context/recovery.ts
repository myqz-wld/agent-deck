import { getDb } from '@main/store/db';
import type {
  AdapterSessionMode,
  PermissionMode,
  SessionRecord,
} from '@shared/types';
import {
  createTrustedContinuationInitialTurn,
  type TrustedContinuationInitialTurn,
} from './initial-turn';
import { prepareContinuationContext } from './service';
import { acquireContinuationCheckpointForegroundLease } from './checkpoint-refresh-service';
import {
  assertSessionAdapterId,
  resolveContinuationGeneratorSnapshot,
  resolveContinuationRawRetentionCeiling,
  resolveContinuationTargetSnapshot,
} from './resolver';
import { ContinuationSourceSpoolStore } from './source-spool';
import type {
  PreparedContinuationContext,
  ResolvedContinuationGenerator,
  ResolvedSuccessorSpec,
} from './types';

export const RECOVERY_CONTINUATION_DEADLINE_MS = 30_000;
export const RECOVERY_CONTINUATION_MAX_FOLD_CALLS = 1;
export const RECOVERY_CONTINUATION_MAX_REPAIR_CALLS = 1;

export interface RecoveryRuntimeOverrides {
  cwd?: string;
  provider?: string | null;
  permissionMode?: PermissionMode | null;
  sessionMode?: AdapterSessionMode | null;
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict' | null;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access' | null;
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
}

function resolveTarget(
  session: SessionRecord,
  sourceRuntimeFingerprint: string,
  overrides: RecoveryRuntimeOverrides,
): ResolvedSuccessorSpec {
  const adapter = assertSessionAdapterId(session.agentId);
  const cwd = overrides.cwd ?? session.cwd;
  const provider =
    overrides.provider !== undefined
      ? overrides.provider
      : session.runtimeProvider ?? null;
  const model = overrides.model !== undefined ? overrides.model : session.model ?? null;
  const thinking = overrides.thinking !== undefined ? overrides.thinking : session.thinking ?? null;
  const permissionMode =
    overrides.permissionMode !== undefined
      ? overrides.permissionMode
      : session.permissionMode ?? null;
  const sessionMode =
    overrides.sessionMode !== undefined
      ? overrides.sessionMode
      : session.sessionMode ?? null;
  const extraAllowWrite = [
    ...(overrides.extraAllowWrite !== undefined
      ? overrides.extraAllowWrite ?? []
      : session.extraAllowWrite ?? []),
  ];
  const networkAccessEnabled =
    overrides.networkAccessEnabled !== undefined
      ? overrides.networkAccessEnabled
      : session.networkAccessEnabled ?? null;
  const additionalDirectories = [
    ...(overrides.additionalDirectories !== undefined
      ? overrides.additionalDirectories ?? []
      : session.additionalDirectories ?? []),
  ];
  const sandbox =
    adapter === 'grok-build'
      ? { kind: 'grok' }
      : adapter === 'codex-cli'
      ? {
          kind: 'codex',
          mode:
            overrides.codexSandbox !== undefined
              ? overrides.codexSandbox
              : session.codexSandbox ?? null,
          extraAllowWrite,
        }
      : {
          kind: 'claude',
          mode:
            overrides.claudeCodeSandbox !== undefined
              ? overrides.claudeCodeSandbox
              : session.claudeCodeSandbox ?? null,
          extraAllowWrite,
        };
  return resolveContinuationTargetSnapshot({
    adapter,
    cwd,
    provider,
    model,
    thinking,
    permissionMode,
    sessionMode,
    sandbox,
    networkAccessEnabled,
    additionalDirectories,
    sourceRuntimeFingerprint,
  });
}

/**
 * Synchronous by contract. Callers must finish this function before emitting the current recovery
 * user event, otherwise that mutable event could be duplicated in the historical continuation tail.
 */
export function captureRecoveryContinuation(input: {
  session: SessionRecord;
  overrides?: RecoveryRuntimeOverrides;
}): CapturedRecoveryContinuation {
  const db = getDb();
  const spool = new ContinuationSourceSpoolStore(db);
  const rawRetentionCeilingTokens = resolveContinuationRawRetentionCeiling();
  const generator = resolveContinuationGeneratorSnapshot();
  const metadata = spool.capture({
    sessionId: input.session.id,
    rawRetentionCeilingTokens,
  });
  try {
    const target = resolveTarget(
      input.session,
      metadata.runtimeFingerprint,
      input.overrides ?? {},
    );
    return {
      sourceSessionId: input.session.id,
      spoolId: metadata.spoolId,
      generator,
      target,
      rawRetentionCeilingTokens,
    };
  } catch (error) {
    spool.cleanup(metadata.spoolId);
    throw error;
  }
}

export async function prepareRecoveryContinuation(input: {
  capture: CapturedRecoveryContinuation;
  continuationInstruction: string;
  signal?: AbortSignal;
}): Promise<PreparedRecoveryContinuation> {
  const releaseForeground = await acquireContinuationCheckpointForegroundLease(
    input.capture.sourceSessionId,
  );
  try {
    const prepared = await prepareContinuationContext({
      purpose: 'recovery',
      sourceSessionId: input.capture.sourceSessionId,
      continuationInstruction: input.continuationInstruction,
      generator: input.capture.generator,
      target: input.capture.target,
      source: { mode: 'immutable-spool', spoolId: input.capture.spoolId },
      limits: {
        rawRetentionCeilingTokens: input.capture.rawRetentionCeilingTokens,
        deadlineMs: RECOVERY_CONTINUATION_DEADLINE_MS,
        maxFoldCalls: RECOVERY_CONTINUATION_MAX_FOLD_CALLS,
        maxRepairCalls: RECOVERY_CONTINUATION_MAX_REPAIR_CALLS,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      prepared,
      turn: createTrustedContinuationInitialTurn(prepared, input.capture.sourceSessionId),
    };
  } finally {
    releaseForeground();
  }
}

/** Idempotent for already-cleaned/missing rows. */
export function cleanupRecoveryContinuation(capture: CapturedRecoveryContinuation): void {
  new ContinuationSourceSpoolStore(getDb()).cleanup(capture.spoolId);
}
