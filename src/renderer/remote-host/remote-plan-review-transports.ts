import { SESSION_EVENT_MAX_ITEMS } from '@contracts/index';
import type {
  RemoteHostPlanReviewTargetDto,
} from '@shared/remote-host';
import type { AgentEvent } from '@shared/types';
import type { PlanDeepReviewTransport } from '@renderer/plan-review/transport';

import { RemoteUserIntentLedger } from './remote-intent-ledger';
import type { RemotePendingPresentation } from './source-types';

interface Context {
  activeProfileId: string | null;
  capabilities: ReadonlySet<string>;
  dataRevision: number;
  identity: string;
  currentIdentity(): string;
}

interface Entry {
  context: Context;
  presentation: RemotePendingPresentation;
  revision: number;
  transport: PlanDeepReviewTransport;
}

const MAX_TRANSPORTS = 128;

function target(entry: Entry): Omit<RemoteHostPlanReviewTargetDto, 'intentId'> {
  const { context, presentation } = entry;
  if (
    !context.activeProfileId || context.currentIdentity() !== context.identity ||
    presentation.sourceIdentity !== context.identity
  ) throw new Error('计划审阅的数据源已切换，请刷新后重试。');
  if (
    !context.capabilities.has('plan-review') || !context.capabilities.has('pending.read') ||
    !context.capabilities.has('events.replay')
  ) {
    throw new Error('远程 Core 不支持隔离的计划审阅。');
  }
  return {
    profileId: context.activeProfileId,
    sessionId: presentation.request.sessionId,
    requestId: presentation.request.id,
    expectedRevision: entry.revision,
  };
}

/** Bounded source-qualified Remote transports; each tracks the latest Core mutation revision. */
export class RemotePlanReviewTransports {
  private readonly entries = new Map<string, Entry>();
  private readonly intents = new RemoteUserIntentLedger();

  retainSources(sourceIdentities: ReadonlySet<string>): void {
    this.intents.retainSources(sourceIdentities);
    for (const [key, entry] of this.entries) {
      if (!sourceIdentities.has(entry.presentation.sourceIdentity)) this.entries.delete(key);
    }
  }

  get(
    context: Context,
    presentation: RemotePendingPresentation,
    agentId: string,
  ): PlanDeepReviewTransport | null {
    if (
      agentId === 'grok-build' || !context.capabilities.has('plan-review') ||
      !context.capabilities.has('pending.read') || !context.capabilities.has('events.replay')
    ) return null;
    const key = `${presentation.sourceIdentity}\u0000${presentation.request.sessionId}` +
      `\u0000${presentation.request.id}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= MAX_TRANSPORTS) {
        const oldest = this.entries.keys().next().value as string | undefined;
        if (oldest) this.entries.delete(oldest);
      }
      entry = this.createEntry(key, context, presentation);
      this.entries.set(key, entry);
    } else {
      entry.context = context;
      entry.presentation = presentation;
      entry.revision = Math.max(entry.revision, presentation.revision);
    }
    return entry.transport;
  }

  private createEntry(
    key: string,
    context: Context,
    presentation: RemotePendingPresentation,
  ): Entry {
    const entry = { context, presentation, revision: presentation.revision } as Entry;
    entry.transport = {
      identity: key,
      get revision() { return entry.context.dataRevision; },
      start: async () => {
        const payload = target(entry);
        const result = await this.intents.run(entry.context.identity, 'plan-review-start', payload,
          (intentId) => window.api.startRemoteHostPlanReview({ ...payload, intentId }));
        entry.revision = result.revision;
        return { sessionId: result.sessionId, agentId: result.agentId };
      },
      ask: async (question) => {
        const payload = { ...target(entry), question };
        const result = await this.intents.run(entry.context.identity, 'plan-review-ask', payload,
          (intentId) => window.api.askRemoteHostPlanReview({ ...payload, intentId }));
        entry.revision = result.revision;
      },
      generateFeedback: async () => {
        const payload = target(entry);
        const result = await this.intents.run(
          entry.context.identity,
          'plan-review-feedback',
          payload,
          (intentId) => window.api.generateRemoteHostPlanReviewFeedback({ ...payload, intentId }),
        );
        entry.revision = result.revision;
        return { feedback: result.feedback };
      },
      listEvents: async (sessionId): Promise<AgentEvent[]> => {
        const base = target(entry);
        const expectedIdentity = entry.context.identity;
        const result = await window.api.listRemoteHostEvents({
          profileId: base.profileId,
          sessionId,
          limit: SESSION_EVENT_MAX_ITEMS,
        });
        if (entry.context.currentIdentity() !== expectedIdentity) {
          throw new Error('计划审阅的数据源已切换，请刷新后重试。');
        }
        return result.events;
      },
    };
    return entry;
  }
}
