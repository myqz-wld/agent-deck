import type { InternalSession } from './types';

export type ClaudeStreamResumeMode = 'resume-cli' | 'fresh-cli-reuse-app';

export interface ClaudeStreamSessionIdentityHost {
  warn(message: string): void;
  renameSdkSession(fromSessionId: string, toSessionId: string): void;
  updateCliSessionId(applicationSid: string, cliSessionId: string): void;
}

export interface ClaudeStreamFirstIdInput {
  readonly sessions: Map<string, InternalSession>;
  readonly internal: InternalSession;
  readonly tempKey: string;
  readonly incomingId: string;
  readonly applicationResumeId?: string;
  readonly effectiveResumeCliSid?: string;
  readonly resumeMode?: ClaudeStreamResumeMode;
  readonly onFirstId: (sessionId: string) => void;
}

/** Adopt one first provider identity without confusing stable application and mutable CLI ids. */
export function adoptClaudeStreamFirstIdCore(
  input: ClaudeStreamFirstIdInput,
  host: ClaudeStreamSessionIdentityHost,
): string | null {
  const {
    sessions,
    internal,
    tempKey,
    incomingId,
    applicationResumeId,
    effectiveResumeCliSid: requestedCliSid,
    resumeMode,
    onFirstId,
  } = input;
  const isNewSpawn = !applicationResumeId && resumeMode !== 'fresh-cli-reuse-app';
  if (isNewSpawn && (internal.expectedClose || sessions.get(tempKey) !== internal)) {
    host.warn(
      `[sdk-bridge] first-id arrived after new session was closed; ` +
        `incoming=${incomingId} temp=${tempKey}; skipping mutation`,
    );
    return null;
  }
  if (internal.cliSessionId !== null && internal.cliSessionId !== incomingId) {
    host.warn(
      `[sdk-bridge] late first-id arrived after fallback; ` +
        `incoming=${incomingId} fallback=${internal.cliSessionId}; skipping mutation`,
    );
    return null;
  }

  const isNormalResume = !!applicationResumeId && resumeMode !== 'fresh-cli-reuse-app';
  const isPhantomResumeId =
    isNormalResume &&
    requestedCliSid === internal.applicationSid &&
    incomingId !== internal.applicationSid;
  const realId = isPhantomResumeId ? internal.applicationSid : incomingId;

  if (isPhantomResumeId) {
    internal.cliSessionId = internal.applicationSid;
    host.warn(
      `[sdk-bridge] CLI resume emitted runtime id ${incomingId} for application sid ` +
        `${internal.applicationSid}; preserving application sid as cli_session_id`,
    );
    onFirstId(realId);
  } else {
    internal.cliSessionId = realId;
  }

  if (!isPhantomResumeId && tempKey !== realId) {
    if (isNewSpawn) {
      sessions.delete(tempKey);
      sessions.set(realId, internal);
      internal.applicationSid = realId;
      host.renameSdkSession(tempKey, realId);
    } else if (resumeMode === 'fresh-cli-reuse-app') {
      host.updateCliSessionId(internal.applicationSid, realId);
    }
  }

  if (
    !isPhantomResumeId &&
    resumeMode !== 'fresh-cli-reuse-app' &&
    requestedCliSid &&
    requestedCliSid !== realId
  ) {
    host.warn(
      `[sdk-bridge] CLI forked: requested cli sid=${requestedCliSid} but got realId=${realId}; ` +
        `updating cli_session_id column on application sid ${internal.applicationSid} (走 manager 黑名单链)`,
    );
    host.updateCliSessionId(internal.applicationSid, realId);
  }

  if (!isPhantomResumeId) onFirstId(realId);
  return realId;
}
