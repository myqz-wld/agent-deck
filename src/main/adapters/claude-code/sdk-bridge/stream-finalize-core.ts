import type { AgentEvent } from '@shared/types';
import { cleanupGatewaySandboxSettingsCore } from './create-session/gateway-sandbox-settings-core';
import { resetTurnUsageAccounting } from './authoritative-reasoning-usage';
import {
  clearClaudeLiveTokenEstimateCore,
  type ClaudeLiveRateHost,
} from './live-token-rate-core';
import { rejectUnsettledClaudeTrustedContinuation } from './trusted-continuation-observer';
import type { InternalSession } from './types';

export interface ClaudeStreamFinalizeContext {
  readonly sessions: Map<string, InternalSession>;
  readonly emit: (event: AgentEvent) => void;
}

export interface ClaudeStreamFinalizeHost extends ClaudeLiveRateHost {
  readonly agentId: string;
  now(): number;
  releaseSdkClaim(sessionId: string): void;
}

/** Retire every stream-owned capability while preserving resumable dormant-session semantics. */
export function finalizeClaudeStreamCore(
  ctx: ClaudeStreamFinalizeContext,
  internal: InternalSession,
  tempKey: string,
  host: ClaudeStreamFinalizeHost,
): void {
  rejectUnsettledClaudeTrustedContinuation(internal);
  try {
    const sid = internal.applicationSid;
    for (const entry of internal.pendingPermissions.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolver({ behavior: 'deny', message: 'session ended', interrupt: true });
    }
    internal.pendingPermissions.clear();

    for (const entry of internal.pendingAskUserQuestions.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolver({
        answers: [{ question: '__session_ended__', selected: [], other: '会话已结束' }],
      });
    }
    internal.pendingAskUserQuestions.clear();

    for (const entry of internal.pendingExitPlanModes.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolver({ decision: 'keep-planning', feedback: '会话已结束' });
    }
    internal.pendingExitPlanModes.clear();
    internal.pendingFileChangeIntents.clear();
    resetTurnUsageAccounting(internal);
    clearClaudeLiveTokenEstimateCore(internal, sid, host.now(), host);

    ctx.emit({
      sessionId: sid,
      agentId: host.agentId,
      kind: 'session-end',
      payload: { reason: 'sdk-stream-ended' },
      ts: host.now(),
      source: 'sdk',
    });
    if (ctx.sessions.get(sid) === internal) ctx.sessions.delete(sid);
    if (ctx.sessions.get(tempKey) === internal) ctx.sessions.delete(tempKey);
    host.releaseSdkClaim(sid);

    // Natural stream completion is resumable. Release a distinct CLI claim without adding the
    // recently-deleted tombstone used by an explicit close.
    const cliSid = internal.cliSessionId;
    if (cliSid && cliSid !== sid && cliSid !== tempKey) {
      host.releaseSdkClaim(cliSid);
    }
  } finally {
    cleanupGatewaySandboxSettingsCore(internal);
    internal.resolveStreamDrained();
  }
}
