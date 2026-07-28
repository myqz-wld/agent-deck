import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import log from '@main/utils/logger';

const logger = log.scope('claude-native-fork');

export interface ClaudeForkCleanupSdk {
  deleteSession(sessionId: string, options: { dir: string }): Promise<void>;
}

export interface ClaudeForkChildStore {
  get(sessionId: string): { cliSessionId?: string | null } | null;
  delete(sessionId: string): void;
}

export interface ClaudeForkCleanupIssue {
  phase: 'inspect-row' | 'close-child' | 'delete-row' | 'delete-native';
  targetId: string;
}

export class ClaudeForkDiscardError extends Error {
  readonly issues: readonly ClaudeForkCleanupIssue[];
  readonly residualState = ['claude-fork-child-artifacts'] as const;

  constructor(issues: readonly ClaudeForkCleanupIssue[]) {
    super(
      `Claude fork discard incomplete during ${[
        ...new Set(issues.map((issue) => issue.phase)),
      ].join(', ')}`,
    );
    this.name = 'ClaudeForkDiscardError';
    this.issues = issues;
  }
}

export function createClaudeForkCleanup(input: {
  providerName: string;
  cwd: string;
  sourceIds: ReadonlySet<string>;
  applicationChildIds: Set<string>;
  nativeChildIds: Set<string>;
  closeChild(sessionId: string): Promise<void>;
  deleteChild?(sessionId: string): Promise<void>;
  store: ClaudeForkChildStore;
  sdk: ClaudeForkCleanupSdk;
}): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return () => {
    cleanupPromise ??= runClaudeForkCleanup(input);
    return cleanupPromise;
  };
}

async function runClaudeForkCleanup(input: {
  providerName: string;
  cwd: string;
  sourceIds: ReadonlySet<string>;
  applicationChildIds: Set<string>;
  nativeChildIds: Set<string>;
  closeChild(sessionId: string): Promise<void>;
  deleteChild?(sessionId: string): Promise<void>;
  store: ClaudeForkChildStore;
  sdk: ClaudeForkCleanupSdk;
}): Promise<void> {
  const issues: ClaudeForkCleanupIssue[] = [];
  const recordIssue = (
    phase: ClaudeForkCleanupIssue['phase'],
    targetId: string,
    error: unknown,
  ): void => {
    issues.push({ phase, targetId });
    logger.warn('[claude-fork] cleanup step failed', safeDiagnostic({
      phase,
      outcome: 'failed',
      providerName: input.providerName,
      targetId,
      error,
    }));
  };

  for (const childId of input.applicationChildIds) {
    if (input.sourceIds.has(childId)) continue;
    try {
      const nativeId = input.store.get(childId)?.cliSessionId;
      if (nativeId && !input.sourceIds.has(nativeId)) input.nativeChildIds.add(nativeId);
    } catch (error) {
      recordIssue('inspect-row', childId, error);
    }
  }
  for (const childId of input.applicationChildIds) {
    if (input.sourceIds.has(childId)) continue;
    try {
      await input.closeChild(childId);
    } catch (error) {
      recordIssue('close-child', childId, error);
    }
  }
  for (const childId of input.applicationChildIds) {
    if (input.sourceIds.has(childId)) continue;
    try {
      if (input.deleteChild) await input.deleteChild(childId);
      else input.store.delete(childId);
    } catch (error) {
      recordIssue('delete-row', childId, error);
    }
  }
  for (const nativeId of input.nativeChildIds) {
    if (input.sourceIds.has(nativeId)) continue;
    try {
      await input.sdk.deleteSession(nativeId, { dir: input.cwd });
    } catch (error) {
      recordIssue('delete-native', nativeId, error);
    }
  }
  if (issues.length > 0) throw new ClaudeForkDiscardError(issues);
}
