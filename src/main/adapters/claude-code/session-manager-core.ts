import type { SessionManagerHost } from '@main/session/manager/facade-core';

export type ClaudeSessionManagerPort = Pick<
  SessionManagerHost,
  | 'claimAsSdk'
  | 'releaseSdkClaim'
  | 'markRecentlyDeleted'
  | 'expectSdkSession'
  | 'delete'
  | 'getCloseEpoch'
  | 'markClosed'
  | 'unarchive'
  | 'renameSdkSession'
  | 'updateCliSessionId'
>;

/** Bind the Claude adapter to one injected session owner without exposing desktop implementation. */
export function createClaudeSessionManagerPort(
  host: ClaudeSessionManagerPort,
): ClaudeSessionManagerPort {
  return {
    claimAsSdk: (sessionId) => host.claimAsSdk(sessionId),
    releaseSdkClaim: (sessionId) => host.releaseSdkClaim(sessionId),
    markRecentlyDeleted: (sessionId, cliSessionId) =>
      host.markRecentlyDeleted(sessionId, cliSessionId),
    expectSdkSession: (cwd, ttlMs) => host.expectSdkSession(cwd, ttlMs),
    delete: (sessionId) => host.delete(sessionId),
    getCloseEpoch: (sessionId) => host.getCloseEpoch(sessionId),
    markClosed: (sessionId) => host.markClosed(sessionId),
    unarchive: (sessionId) => host.unarchive(sessionId),
    renameSdkSession: (fromSessionId, toSessionId) =>
      host.renameSdkSession(fromSessionId, toSessionId),
    updateCliSessionId: (applicationSid, cliSessionId) =>
      host.updateCliSessionId(applicationSid, cliSessionId),
  };
}
