import type { EnrolledFeishuCredential, FeishuGatewayClock, FeishuMessageEvent, NotificationEvent, SessionConsoleView } from '@gateways/im';
import type { FeishuMessageProgressPort, FeishuProcessingTarget } from '@gateways/im/message-progress';
import { boundedFeishuOperation } from './bounded-operation';
import { FeishuGatewayError } from '@gateways/im/errors';
import type { FeishuSourceRegistry } from './source-registry';

export interface FeishuReactionResponse {
  code?: number;
  data?: { reaction_id?: string; operator?: { operator_id: string; operator_type: 'app' | 'user' } };
}
export interface FeishuReactionApiPort {
  addReaction(messageId: string, emoji: string): Promise<FeishuReactionResponse>;
  deleteReaction(messageId: string, reactionId: string): Promise<FeishuReactionResponse>;
}

type State = 'processing' | 'waiting' | 'completed' | 'failed';
const EMOJI: Record<State, string> = { processing: 'Typing', waiting: 'OneSecond', completed: 'DONE', failed: 'CrossMark' };
interface Entry {
  eventId: string; messageId: string; chatId: string; credential: EnrolledFeishuCredential;
  target?: FeishuProcessingTarget; started: boolean; lastRevision: number;
  desired: State | null; applied: State | null; reactionId: string | null;
  updatedAt: number; attempts: number; dirty: boolean; busy: boolean; ambiguousAdd: boolean;
}

/** Bounded, memory-only feedback. No message bodies or provider message ids enter the database. */
export class FeishuMessageReactions implements FeishuMessageProgressPort {
  private readonly entries = new Map<string, Entry>();
  private readonly jobs = new Set<Promise<void>>();
  private sweepTimer: ReturnType<FeishuGatewayClock['setTimer']> | null = null;
  private closed = false;

  constructor(private readonly api: FeishuReactionApiPort, private readonly sources: FeishuSourceRegistry,
    private readonly clock: FeishuGatewayClock, private readonly appId: string,
    private readonly authorized: (credential: EnrolledFeishuCredential) => boolean,
    private readonly reportCode: (code: string) => void) {}

  private report(code: string): void {
    try { this.reportCode(code); } catch { /* Diagnostics cannot break optional feedback. */ }
  }

  begin(event: FeishuMessageEvent, credential: EnrolledFeishuCredential): void {
    if (this.closed || this.entries.has(event.eventId)) return;
    const source = this.sources.get(event.eventId);
    if (!source || source.kind !== 'message' || source.chatId !== event.chatId || !this.authorized(credential)) return;
    if ([...this.entries.values()].some(e => e.messageId === source.messageId)) return;
    this.sweep();
    if (this.entries.size >= 128) return;
    const entry: Entry = { eventId: event.eventId, messageId: source.messageId, chatId: event.chatId,
      credential: { ...credential }, started: false, lastRevision: -1, desired: 'processing',
      applied: null, reactionId: null, updatedAt: this.clock.now(), attempts: 0, dirty: false, busy: false, ambiguousAdd: false };
    this.entries.set(event.eventId, entry);
    this.schedule(entry);
    if (!this.sweepTimer) this.armSweep();
  }

  accepted(eventId: string, view: SessionConsoleView): void {
    const entry = this.entries.get(eventId);
    if (!entry || this.closed) return;
    if (view.errorCode) { this.set(entry, 'failed'); return; }
    if (view.processing) {
      entry.target = { ...view.processing };
      entry.started ||= view.processing.afterRevision !== undefined;
    } else this.set(entry, 'completed');
  }

  failed(eventId: string, retryable: boolean): void {
    if (this.closed) return;
    const entry = this.entries.get(eventId);
    // A timed-out Core acceptance is ambiguous; only a provider completion can mark it done.
    if (entry && !retryable) this.set(entry, 'failed');
  }

  notification(credential: EnrolledFeishuCredential, chatId: string, event: NotificationEvent, pending?: boolean): void {
    if (this.closed) return;
    for (const entry of this.entries.values()) {
      if (!this.matches(entry, credential, chatId) || entry.desired === 'completed' || entry.desired === 'failed' || entry.desired === null) continue;
      if (event.renamedSession && entry.target?.sessionId === event.renamedSession.fromId) {
        entry.target.sessionId = event.renamedSession.toId;
      }
      if (event.persisted?.role === 'user' && event.persisted.correlationId === `feishu:${entry.eventId}` && event.entityId) {
        entry.target = { sessionId: event.entityId, correlationId: event.persisted.correlationId };
        entry.started = true;
      }
      if (!entry.started || event.entityId !== entry.target?.sessionId ||
        event.revision <= (entry.target.afterRevision ?? -1) || event.revision < entry.lastRevision) continue;
      entry.lastRevision = event.revision;
      if (event.persisted?.kind === 'finished') {
        this.set(entry, event.persisted.ok === true ? 'completed' : 'failed');
      } else if (event.persisted?.kind === 'session-end' || event.kind === 'session.failed') this.set(entry, 'failed');
      else if (pending !== undefined) this.set(entry, pending ? 'waiting' : 'processing');
    }
  }

  resumed(credential: EnrolledFeishuCredential, chatId: string, sessionId: string): void {
    for (const entry of this.entries.values()) {
      if (this.matches(entry, credential, chatId) && entry.target?.sessionId === sessionId && entry.desired === 'waiting') {
        this.set(entry, 'processing');
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sweepTimer?.cancel();
    this.sweepTimer = null;
    for (const entry of this.entries.values()) {
      if (entry.desired !== 'completed' && entry.desired !== 'failed') this.set(entry, null);
    }
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
    this.entries.clear();
  }

  private matches(entry: Entry, credential: EnrolledFeishuCredential, chatId: string): boolean {
    return entry.chatId === chatId && entry.credential.instanceId === credential.instanceId &&
      entry.credential.credentialId === credential.credentialId;
  }

  private set(entry: Entry, state: State | null): void {
    if (entry.desired === state) return;
    entry.desired = state;
    entry.updatedAt = this.clock.now();
    entry.attempts = 0;
    this.schedule(entry);
  }

  private schedule(entry: Entry): void {
    entry.dirty = true;
    this.pump();
  }

  private pump(): void {
    for (const entry of this.entries.values()) {
      if (this.jobs.size >= 4) break;
      if (!entry.dirty || entry.busy || entry.ambiguousAdd) continue;
      entry.dirty = false;
      entry.busy = true;
      const job = this.update(entry).catch(() => this.report('reaction_failed')).finally(() => {
        this.jobs.delete(job);
        entry.busy = false;
        this.pump();
      });
      this.jobs.add(job);
    }
  }

  private async update(entry: Entry): Promise<void> {
    try {
      if (!this.authorized(entry.credential)) entry.desired = null;
      while (entry.applied !== entry.desired) {
        entry.dirty = false;
        if (entry.reactionId) {
          const result = await this.call(this.api.deleteReaction(entry.messageId, entry.reactionId));
          if (result.code !== 0 && result.code !== 231003) throw new Error('Reaction removal failed');
          entry.reactionId = null;
          entry.applied = null;
        }
        const state = entry.desired;
        if (state === null) break;
        const promise = this.api.addReaction(entry.messageId, EMOJI[state]);
        let timedOut = false;
        void promise.then(async result => {
          if (!timedOut) return;
          // Do not issue another add while its predecessor's outcome is unknown: Feishu can
          // return the same reaction id to a retry, so late cleanup could delete the new state.
          if (this.owned(result)) {
            try { await this.call(this.api.deleteReaction(entry.messageId, result.data!.reaction_id!)); }
            catch { this.report('reaction_cleanup_failed'); return; }
          }
          entry.ambiguousAdd = false;
          if (!this.closed && this.entries.get(entry.eventId) === entry) this.schedule(entry);
        }, () => {
          if (timedOut) {
            entry.ambiguousAdd = false;
            if (!this.closed && this.entries.get(entry.eventId) === entry && entry.attempts < 3) this.schedule(entry);
          }
        }).catch(() => this.report('reaction_cleanup_failed'));
        let result: FeishuReactionResponse;
        try { result = await this.call(promise); } catch (error) {
          timedOut = error instanceof FeishuGatewayError && error.message === 'Reaction deadline elapsed';
          entry.ambiguousAdd = timedOut;
          throw error;
        }
        if (!this.owned(result)) { this.report(result.code === 99991672 ? 'reaction_permission_missing' : 'reaction_rejected'); return; }
        entry.reactionId = result.data!.reaction_id!;
        entry.applied = state;
      }
      entry.attempts = 0;
    } catch {
      this.report('reaction_unavailable');
      if (++entry.attempts < 3 && !this.closed && !entry.ambiguousAdd) {
        this.clock.setTimer(() => { if (this.entries.get(entry.eventId) === entry && !this.closed) this.schedule(entry); }, 1_000);
      }
    }
  }

  private owned(result: FeishuReactionResponse): boolean {
    return result?.code === 0 && typeof result.data?.reaction_id === 'string' && result.data.reaction_id.length > 0 &&
      result.data.operator?.operator_type === 'app' && result.data.operator.operator_id === this.appId;
  }

  private call<T>(promise: Promise<T>): Promise<T> {
    return boundedFeishuOperation(promise, this.clock, 4_000, 'Reaction deadline elapsed');
  }

  private armSweep(): void {
    this.sweepTimer = this.clock.setTimer(() => {
      this.sweepTimer = null;
      this.sweep();
      if (!this.closed && this.entries.size) this.armSweep();
    }, 60_000);
  }

  private sweep(): void {
    for (const [key, entry] of this.entries) {
      const age = this.clock.now() - entry.updatedAt;
      if (age > 60 * 60_000 && entry.ambiguousAdd) this.entries.delete(key);
      else if (age > 60 * 60_000 && (entry.desired === 'processing' || entry.desired === 'waiting')) this.set(entry, null);
      else if (age > 5 * 60_000 && entry.applied === entry.desired && !entry.dirty && !entry.busy &&
        (entry.desired === null || entry.desired === 'completed' || entry.desired === 'failed')) this.entries.delete(key);
    }
  }
}
