import type { CreateSessionOptions, QueuedAgentMessage } from '@main/adapters/types';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { prepareHandOffContinuation } from '@main/session/continuation-context/handoff';
import type { ContinuationSpoolMetadata } from '@main/session/continuation-context/source-spool';
import type { HandOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import type { DeliverHandOffLateMessagesInput } from '@main/session/hand-off/late-message-delivery';
import type {
  HandOffSourceCutoverCheck,
  HandOffSourceCutoverResult,
} from '@main/session/hand-off/source-precondition';
import type {
  resolveHandOffTarget,
  revalidateHandOffTarget,
} from '@main/session/hand-off/target-resolver';
import type { SessionAdapterId, SessionRecord, UploadedAttachmentRef } from '@shared/types';
import type { transferHandOffResources } from './resource-transfer-coordinator';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';
import type { TrustedContinuationSessionCandidate } from '@main/adapters/trusted-continuation';

export interface HandOffTargetValidationError {
  error: string;
  hint: string;
}

/** Test seams for hand_off_session. Production uses the unified continuation preparation,
 * authenticated trusted-turn executor, resource coordinator, and no-self-interrupt finalizer. */
export interface HandOffSessionHandlerDeps {
  cutoverCoordinator?: HandOffCutoverCoordinator;
  cwdIsDirectory?: (path: string) => boolean;
  worktreeTransition?: (
    sessionId: string,
  ) => WorktreeTransitionRecord | null;
  sourceRuntimeCwd?: (sessionId: string) => string | null;
  sourceMaxEventId?: (sessionId: string) => number | null;
  sourceRuntimeFingerprint?: (sessionId: string) => string | null;
  snapshotQueuedMessages?: (source: SessionRecord) => QueuedAgentMessage[];
  validateTargetAdapter?: (
    adapter: SessionAdapterId,
  ) => HandOffTargetValidationError | null;
  resolveTarget?: typeof resolveHandOffTarget;
  revalidateTarget?: typeof revalidateHandOffTarget;
  prepareContinuation?: typeof prepareHandOffContinuation;
  spoolMetadata?: (spoolId: string) => ContinuationSpoolMetadata;
  sourcePreconditionCheck?: (input: HandOffSourceCutoverCheck) => HandOffSourceCutoverResult;
  createSuccessor?: (
    target: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ) => Promise<TrustedContinuationSessionCandidate>;
  rollbackRejectedSuccessor?: (sessionId: string) => Promise<void>;
  readinessDeadlineMs?: number;
  deliverLateMessages?: (
    input: DeliverHandOffLateMessagesInput,
  ) => Promise<UploadedAttachmentRef[]>;
  drainMessageDeliveries?: (sourceSessionId: string) => Promise<boolean>;
  transferResources?: typeof transferHandOffResources;
  closeSuccessor?: (sessionId: string) => Promise<void>;
  finalizeSource?: (input: {
    source: SessionRecord;
    successorSessionId: string;
    resourceTransfer: ReturnType<typeof transferHandOffResources>;
  }) => void | Promise<void>;
  cleanupSpool?: (spoolId: string) => void;
}
