import { createHash } from 'node:crypto';
import { AgentDeckClientErrorCode, parseSessionNameUpdate, parseSessionNameUpdateResult,
  type JsonValue, type SessionNameUpdateParams, type SessionNameUpdateResult } from '@contracts/index';
import { DaemonRequestError } from '@hosts/daemon';
import type { SessionRecord } from '@shared/types';
import type { ServerCoreIssueMetadataPort } from './issue-runtime';

export interface SessionNameMutationScope {
  connectionScope: string;
  accessSurface: 'desktop' | 'feishu';
  idempotencyKey: string;
}

export class ServerCoreSessionNameService {
  constructor(private readonly sessions: {
    get(id: string): SessionRecord | null;
    setTitle(id: string, title: string): void;
  }, private readonly metadata: ServerCoreIssueMetadataPort) {}

  update(raw: SessionNameUpdateParams, scope: SessionNameMutationScope): SessionNameUpdateResult {
    const params = parseSessionNameUpdate(raw);
    if (!scope.idempotencyKey) throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Stable name-update identity is required');
    const identity = { ...scope, method: 'session.name.update',
      // A retried owner command may reread the title; its intended target/name stay stable.
      requestFingerprint: createHash('sha256').update(JSON.stringify({ sessionId: params.sessionId, title: params.title })).digest('hex') };
    const claim = this.metadata.claimMutation(identity);
    if (claim.state === 'completed') return parseSessionNameUpdateResult(claim.result);
    if (claim.state === 'conflict') throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Name-update request identity changed');
    let written = false;
    try {
      const session = this.sessions.get(params.sessionId);
      if (!session || session.hiddenFromHistory) throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Named session is unavailable');
      if (session.lifecycle === 'closed' || session.archivedAt !== null) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Open the session before renaming it');
      }
      const current = session.title || null;
      if (current !== params.expectedTitle && current !== params.title) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Session name changed; read the current title before renaming');
      }
      let revision = this.metadata.currentRevision();
      if (current !== params.title) {
        written = true;
        this.sessions.setTitle(params.sessionId, params.title);
        revision = this.metadata.appendChange('session.name.updated', params.sessionId, { sessionId: params.sessionId });
      }
      const result = { sessionId: params.sessionId, title: params.title, revision };
      this.metadata.completeMutation(identity, result as unknown as JsonValue, revision);
      return result;
    } catch (error) {
      if (!written && claim.state === 'claimed') this.metadata.releaseMutationClaim(identity);
      throw error;
    }
  }
}
