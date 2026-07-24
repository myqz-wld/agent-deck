import { adapterRegistry } from '@main/adapters/registry';
import type { SessionAdapterId } from '@shared/types';
import type { HandOffTargetValidationError } from './_deps';

export function validateHandOffTargetAdapter(
  adapterId: SessionAdapterId,
): HandOffTargetValidationError | null {
  const adapter = adapterRegistry.get(adapterId);
  if (!adapter?.createSession || !adapter.capabilities.canCreateSession) {
    return {
      error: `adapter "${adapterId}" does not support session creation`,
      hint: 'Choose an enabled adapter with session-creation capability: claude-code, deepseek-claude-code, codex-cli, or grok-build.',
    };
  }
  if (!adapter.createTrustedContinuationSession) {
    return {
      error: `adapter "${adapterId}" does not support trusted continuation turns`,
      hint: 'Update or enable the target adapter before retrying hand_off_session. The source session remains active.',
    };
  }
  return null;
}
