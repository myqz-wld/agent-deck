import { createHash } from 'node:crypto';
import {
  AgentDeckClientErrorCode, isCoreMethodGranted, parseFeishuAssistantsRegisterParams,
  parseFeishuAssistantsRegisterResult, type CoreMethod, type JsonValue,
} from '@contracts/index';
import { DaemonRequestError, type DaemonCoreRuntime, type DaemonRequestInput,
  type DaemonRequestResult } from '@hosts/daemon';
import type { SessionRecord } from '@shared/types';
import { MAX_FEISHU_ASSISTANT_IDENTITIES, type FeishuAssistantStore } from './feishu-assistant-store';
import type { ServerCoreIssueMetadataPort } from './issue-runtime';

const METHOD = 'feishu.assistants.register' as const;

/** Feishu's authenticated owner projects existing assistant identities without changing sessions. */
export class ServerCoreFeishuAssistantsRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];
  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly store: FeishuAssistantStore,
    private readonly metadata: ServerCoreIssueMetadataPort,
    private readonly sessions: { get(id: string): SessionRecord | null },
  ) {
    this.supportedMethods = Object.freeze([...new Set([...base.supportedMethods, METHOD])]);
    if (base.subscribe) this.subscribe = base.subscribe.bind(base);
  }
  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }
  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (input.method !== METHOD) return this.base.execute(input);
    if (input.access.kind !== 'authenticated-client' || input.access.authority !== 'owner-equivalent' ||
      input.access.surface !== 'feishu' || !isCoreMethodGranted(input.access, METHOD)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Feishu owner access is required');
    }
    if (input.signal.aborted) throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request cancelled');
    if (!input.idempotencyKey) throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Stable idempotency is required');
    let params;
    try { params = parseFeishuAssistantsRegisterParams(input.params); }
    catch { throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Invalid assistant identities'); }
    const identity = { connectionScope: input.access.connectionScope, accessSurface: input.access.surface,
      method: METHOD, idempotencyKey: input.idempotencyKey,
      requestFingerprint: createHash('sha256').update(JSON.stringify(params)).digest('hex') };
    const claim = this.metadata.claimMutation(identity);
    if (claim.state === 'completed') return {
      result: parseFeishuAssistantsRegisterResult(claim.result) as unknown as JsonValue, revision: claim.revision,
    };
    if (claim.state === 'conflict') throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Assistant registration key changed');
    let writing = false;
    try {
      const current = this.store.read();
      const registeredSessionIds = params.sessionIds.filter(id => {
        const session = this.sessions.get(id);
        return session?.source === 'sdk' && !session.hiddenFromHistory;
      });
      // Purpose survives closure and unsubscribe; remove only identities whose session was deleted.
      const next = [...new Set([...current.filter(id => this.sessions.get(id)), ...registeredSessionIds])].sort();
      if (next.length > MAX_FEISHU_ASSISTANT_IDENTITIES) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Assistant identity capacity reached');
      }
      let revision = this.metadata.currentRevision();
      if (JSON.stringify([...current].sort()) !== JSON.stringify(next)) {
        writing = true;
        this.store.write(next);
        revision = this.metadata.appendChange('feishu.assistants.registered', null, { count: next.length });
      }
      // Set union has no provider side effects: an interrupted identical request can reconcile here.
      const result = { registeredSessionIds, revision };
      this.metadata.completeMutation(identity, result, revision);
      return { result, revision };
    } catch (error) {
      if (!writing && claim.state === 'claimed') this.metadata.releaseMutationClaim(identity);
      throw error;
    }
  }
}
