import type { CreateSessionOptions } from '@main/adapters/types';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { prepareHandOffContinuation } from '@main/session/continuation-context/handoff';
import type { ContinuationSpoolMetadata } from '@main/session/continuation-context/source-spool';
import type { HandOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import type { HandOffSourceCutoverCheck } from '@main/session/hand-off/executor';
import type { resolveHandOffTarget } from '@main/session/hand-off/target-resolver';
import type { SessionAdapterId, SessionRecord } from '@shared/types';
import type { transferHandOffResources } from './resource-transfer-coordinator';

export interface HandOffTargetValidationError {
  error: string;
  hint: string;
}

/** Test seams for hand_off_session. Production uses the unified continuation preparation,
 * authenticated trusted-turn executor, resource coordinator, and no-self-interrupt finalizer. */
export interface HandOffSessionHandlerDeps {
  cutoverCoordinator?: HandOffCutoverCoordinator;
  cwdIsDirectory?: (path: string) => boolean;
  sourceMaxEventId?: (sessionId: string) => number | null;
  sourceRuntimeFingerprint?: (sessionId: string) => string | null;
  validateTargetAdapter?: (
    adapter: SessionAdapterId,
  ) => HandOffTargetValidationError | null;
  resolveTarget?: typeof resolveHandOffTarget;
  prepareContinuation?: typeof prepareHandOffContinuation;
  spoolMetadata?: (spoolId: string) => ContinuationSpoolMetadata;
  sourcePreconditionMatches?: (input: HandOffSourceCutoverCheck) => boolean;
  createSuccessor?: (
    target: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ) => Promise<string>;
  transferResources?: typeof transferHandOffResources;
  closeSuccessor?: (sessionId: string) => Promise<void>;
  finalizeSource?: (input: {
    source: SessionRecord;
    successorSessionId: string;
    resourceTransfer: ReturnType<typeof transferHandOffResources>;
  }) => void | Promise<void>;
  cleanupSpool?: (spoolId: string) => void;
}
