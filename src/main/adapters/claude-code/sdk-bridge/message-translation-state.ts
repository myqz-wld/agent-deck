import type { InternalSession } from './types';
import {
  claudeCompactFailureTextCore,
  resolveClaudeFallbackModelCore,
  syncClaudeReportedPermissionModeCore,
} from './message-translation-state-core';
import { desktopClaudeMessageTranslationStateHost } from './message-translation-state-host';

export const claudeCompactFailureText = claudeCompactFailureTextCore;

export function resolveClaudeFallbackModel(
  internal: InternalSession,
  sessionId: string,
): string {
  return resolveClaudeFallbackModelCore(
    internal,
    sessionId,
    desktopClaudeMessageTranslationStateHost,
  );
}

export function syncClaudeReportedPermissionMode(
  internal: InternalSession,
  sessionId: string,
  reportedMode: unknown,
): void {
  syncClaudeReportedPermissionModeCore(
    internal,
    sessionId,
    reportedMode,
    desktopClaudeMessageTranslationStateHost,
  );
}
