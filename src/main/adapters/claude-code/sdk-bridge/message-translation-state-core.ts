import { CLAUDE_DEFAULT_BUCKET } from '@shared/model-normalize';
import {
  normalizeStoredPermissionMode,
  type PermissionMode,
} from '@shared/types';

export interface ClaudeMessageTranslationStateOwner {
  applicationSid: string;
  permissionMode: PermissionMode;
}

export interface ClaudeMessageTranslationStateRecord {
  model?: string | null;
  permissionMode?: unknown;
}

export interface ClaudeMessageTranslationStateHost {
  read(sessionId: string): ClaudeMessageTranslationStateRecord | null;
  setPermissionMode(sessionId: string, mode: PermissionMode): void;
  publishUpdated(sessionId: string): void;
}

function hasExplicitModel(model: string | null | undefined): model is string {
  return model != null && model.trim() !== '';
}

export function resolveClaudeFallbackModelCore(
  owner: ClaudeMessageTranslationStateOwner,
  sessionId: string,
  host: ClaudeMessageTranslationStateHost,
): string {
  try {
    const model =
      host.read(owner.applicationSid)?.model ?? host.read(sessionId)?.model ?? null;
    return hasExplicitModel(model) ? model : CLAUDE_DEFAULT_BUCKET;
  } catch {
    return CLAUDE_DEFAULT_BUCKET;
  }
}

/** Synchronize an authoritative SDK init/status mode into the live cache and desktop record. */
export function syncClaudeReportedPermissionModeCore(
  owner: ClaudeMessageTranslationStateOwner,
  sessionId: string,
  reportedMode: unknown,
  host: ClaudeMessageTranslationStateHost,
): void {
  const next = normalizeStoredPermissionMode(reportedMode);
  if (!next) return;

  // allowDangerouslySkipPermissions reports its underlying CLI mode as default. Preserve the
  // application-owned bypass state until an explicit mode transition updates the live cache.
  if (owner.permissionMode === 'bypassPermissions' && next === 'default') return;

  owner.permissionMode = next;
  const current = host.read(sessionId);
  if (!current || current.permissionMode === next) return;
  host.setPermissionMode(sessionId, next);
  host.publishUpdated(sessionId);
}

export function claudeCompactFailureTextCore(message: {
  compact_result?: unknown;
  compact_error?: unknown;
}): string | null {
  if (message.compact_result !== 'failed') return null;
  const detail =
    typeof message.compact_error === 'string' && message.compact_error.trim()
      ? message.compact_error.trim()
      : 'unknown error';
  return `⚠ 上下文压缩失败：${detail}`;
}
