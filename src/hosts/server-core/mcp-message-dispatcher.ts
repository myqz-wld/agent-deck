import type { AgentAdapter } from '@main/adapters/types';
import type {
  AgentDeckMessageRepo,
  MessageDeliveryLease,
} from '@main/store/agent-deck-message-repo';
import { deliveryLeaseOf } from '@main/store/agent-deck-message-repo';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { AgentDeckMessage, SessionRecord } from '@shared/types';
import { sanitizeWireFieldName } from '@shared/wire-prefix';

const POLL_INTERVAL_MS = 250;
const BATCH_LIMIT = 16;
const DELIVERY_TIMEOUT_MS = 45_000;
const HANDOFF_DRAIN_TIMEOUT_MS = 5_000;

class OutcomeUnknownError extends Error {}
class TerminalDeliveryError extends Error {}

class CoreMessageRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  tryConsume(key: string, now: number): boolean {
    const threshold = now - 60_000;
    const fresh = (this.buckets.get(key) ?? []).filter((value) => value > threshold);
    if (fresh.length >= 60) {
      this.buckets.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.buckets.set(key, fresh);
    return true;
  }

  retryAfterMs(key: string, now: number): number {
    const first = this.buckets.get(key)?.[0];
    return first === undefined ? 0 : Math.max(0, 60_000 - (now - first));
  }

  reset(): void {
    this.buckets.clear();
  }
}

export interface ServerCoreMcpMessageDispatcherOptions {
  readonly sessions: { get(sessionId: string): SessionRecord | null };
  readonly teams: Pick<
    AgentDeckTeamRepo,
    'findActiveMembershipIn' | 'get'
  >;
  readonly messages: AgentDeckMessageRepo;
  readonly adapter: (adapterId: string) => AgentAdapter | undefined;
  readonly appendChange: (kind: string, entityId: string | null, payload: {
    messageId: string;
    status: AgentDeckMessage['status'];
  }) => void;
  readonly now?: () => number;
}

export interface ServerCoreMcpMessageEnqueueInput {
  readonly teamId: string | null;
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly body: string;
  readonly replyToMessageId: string | null;
}

export type ServerCoreMcpMessageEnqueueResult =
  | { ok: true; message: AgentDeckMessage }
  | { ok: false; retryAfterMs: number };

/** Durable Core-owned teammate delivery with bounded polling and at-most-once ambiguity handling. */
export class ServerCoreMcpMessageDispatcher {
  private readonly limiter = new CoreMessageRateLimiter();
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private processPromise: Promise<void> | null = null;
  private abortController = new AbortController();

  constructor(private readonly options: ServerCoreMcpMessageDispatcherOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.options.messages.terminalizeDeliveringOnStartup();
    this.abortController = new AbortController();
    this.running = true;
    this.timer = setInterval(() => this.schedule(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.schedule();
  }

  async stop(): Promise<void> {
    if (!this.running && !this.processPromise) return;
    this.running = false;
    this.abortController.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.processPromise;
    this.limiter.reset();
  }

  get(messageId: string): AgentDeckMessage | null {
    return this.options.messages.get(messageId);
  }

  enqueue(input: ServerCoreMcpMessageEnqueueInput): ServerCoreMcpMessageEnqueueResult {
    if (!this.running) throw new Error('Server Core message delivery is unavailable');
    const key = input.teamId ?? `from:${input.fromSessionId}`;
    const now = this.now();
    if (!this.limiter.tryConsume(key, now)) {
      return { ok: false, retryAfterMs: this.limiter.retryAfterMs(key, now) };
    }
    const message = this.options.messages.insert(input);
    this.changed(message);
    this.schedule();
    return { ok: true, message };
  }

  async drainForHandOff(sessionId: string, timeoutMs = HANDOFF_DRAIN_TIMEOUT_MS): Promise<boolean> {
    const deadlineAt = this.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (this.options.messages.countDeliveringForSession(sessionId) === 0) return true;
      const remaining = deadlineAt - this.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining));
        timer.unref?.();
      });
    }
  }

  private schedule(): void {
    if (!this.running || this.processPromise) return;
    this.processPromise = this.process().finally(() => {
      this.processPromise = null;
      if (this.running && this.options.messages.findEligible({ now: this.now(), limit: 1 }).length) {
        setImmediate(() => this.schedule());
      }
    });
  }

  private async process(): Promise<void> {
    const candidates = this.options.messages.findEligible({
      now: this.now(),
      limit: BATCH_LIMIT,
    });
    for (const candidate of candidates) {
      if (!this.running) return;
      await this.deliver(candidate);
    }
  }

  private async deliver(candidate: AgentDeckMessage): Promise<void> {
    const claimed = this.options.messages.claim(candidate.id, this.now());
    if (!claimed) return;
    this.changed(claimed);
    const lease = deliveryLeaseOf(claimed);
    try {
      const target = this.requireTarget(claimed, lease);
      const adapter = this.options.adapter(target.agentId);
      if (!adapter?.capabilities.canCollaborate || !adapter.receiveTeammateMessage) {
        this.fail(lease, 'target adapter cannot receive teammate messages');
        return;
      }
      await this.awaitAcceptance(
        adapter.receiveTeammateMessage(
          claimed.toSessionId,
          claimed.fromSessionId,
          this.wireBody(claimed),
          claimed.id,
        ),
      );
      const delivered = this.options.messages.markDelivered(lease, this.now());
      if (delivered) this.changed(delivered);
    } catch (error) {
      if (error instanceof TerminalDeliveryError) return;
      if (error instanceof OutcomeUnknownError) {
        this.fail(lease, error.message);
        return;
      }
      const updated = this.options.messages.retryAfterFail(
        lease,
        error instanceof Error ? error.message : 'target adapter rejected the message',
        this.now(),
      );
      if (updated) this.changed(updated);
    }
  }

  private requireTarget(
    message: AgentDeckMessage,
    lease: MessageDeliveryLease,
  ): SessionRecord {
    const source = this.options.sessions.get(message.fromSessionId);
    const target = this.options.sessions.get(message.toSessionId);
    if (!source || source.archivedAt !== null) {
      this.fail(lease, 'source session is unavailable');
      throw new TerminalDeliveryError('source session is unavailable');
    }
    if (!target || target.lifecycle === 'closed' || target.archivedAt !== null) {
      this.fail(lease, 'target session is unavailable');
      throw new TerminalDeliveryError('target session is unavailable');
    }
    if (message.teamId !== null) {
      const team = this.options.teams.get(message.teamId);
      const sourceMember = this.options.teams.findActiveMembershipIn(
        message.teamId,
        message.fromSessionId,
      );
      const targetMember = this.options.teams.findActiveMembershipIn(
        message.teamId,
        message.toSessionId,
      );
      if (!team || team.archivedAt !== null || !sourceMember || !targetMember) {
        this.fail(lease, 'message team authority changed');
        throw new TerminalDeliveryError('message team authority changed');
      }
    }
    return target;
  }

  private wireBody(message: AgentDeckMessage): string {
    const source = this.options.sessions.get(message.fromSessionId);
    const membership = message.teamId === null
      ? null
      : this.options.teams.findActiveMembershipIn(message.teamId, message.fromSessionId);
    const adapterId = source?.agentId ?? 'unknown-adapter';
    const displayName = membership?.displayName?.trim() || source?.title?.trim() ||
      `${adapterId}:${message.fromSessionId.slice(0, 8)}`;
    return `[from ${sanitizeWireFieldName(displayName)} @ ${sanitizeWireFieldName(adapterId)}]` +
      `[msg ${message.id}][sid ${message.fromSessionId}]\n${message.body}`;
  }

  private awaitAcceptance(operation: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new OutcomeUnknownError('message acceptance timed out; not retried'));
      }, DELIVERY_TIMEOUT_MS);
      const onAbort = (): void => {
        cleanup();
        reject(new OutcomeUnknownError('message delivery stopped before acceptance; not retried'));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.abortController.signal.removeEventListener('abort', onAbort);
      };
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      void operation.then(
        () => { cleanup(); resolve(); },
        (error) => { cleanup(); reject(error); },
      );
    });
  }

  private fail(lease: MessageDeliveryLease, reason: string): void {
    const failed = this.options.messages.markFailed(lease, reason);
    if (failed) this.changed(failed);
  }

  private changed(message: AgentDeckMessage): void {
    this.options.appendChange('message.updated', message.id, {
      messageId: message.id,
      status: message.status,
    });
  }
}
