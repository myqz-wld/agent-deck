import type { PermissionMode } from '@main/adapters/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import log from '@main/utils/logger';

const logger = log.scope('mcp-spawn');

/** Best-effort metadata writes that never weaken the spawn transaction itself. */
export function persistSpawnSessionMetadata(input: {
  sessionId: string;
  canSetPermissionMode: boolean;
  effectivePermissionMode: PermissionMode | undefined;
  teammateDisplayName: string | null;
}): void {
  if (input.canSetPermissionMode && input.effectivePermissionMode) {
    try {
      sessionManager.recordCreatedPermissionMode(
        input.sessionId,
        input.effectivePermissionMode,
      );
    } catch (error) {
      logger.warn('[mcp spawn_session] permission metadata write failed', safeDiagnostic({
        phase: 'session-metadata',
        step: 'permission-mode',
        outcome: 'failed',
        targetSessionId: input.sessionId,
        error,
      }));
    }
  }
  if (!input.teammateDisplayName) return;
  try {
    sessionRepo.setTitle(input.sessionId, input.teammateDisplayName);
  } catch (error) {
    logger.warn('[mcp spawn_session] title metadata write failed', safeDiagnostic({
      phase: 'session-metadata',
      step: 'title',
      outcome: 'failed',
      targetSessionId: input.sessionId,
      error,
    }));
  }
}
