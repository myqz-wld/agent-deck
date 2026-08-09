import { randomUUID } from 'node:crypto';

import {
  AccessSurface,
  DESKTOP_BROKER_MAX_LEASE_MS,
  parseDesktopBrokerRequest,
  parseDesktopBrokerToolResult,
  type AuthenticatedClientAccessContext,
  type DesktopBrokerBrowserOperation,
  type DesktopBrokerNextParams,
  type DesktopBrokerRequestDto,
  type DesktopBrokerRespondParams,
  type DesktopBrokerToolResult,
  type JsonObject,
} from '@contracts/index';

import {
  ServerCoreDesktopBrokerError,
  type ServerCoreDesktopBrokerPort,
} from './desktop-broker-port';

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_PENDING_PER_SESSION = 8;
const DEFAULT_MAX_WAITERS = 64;

interface PendingRequest {
  readonly expiresAt: number;
  request: DesktopBrokerRequestDto;
  assignedClientKey: string | null;
  resolve: (result: DesktopBrokerToolResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PollWaiter {
  readonly clientKey: string;
  readonly resolve: (value: { request: DesktopBrokerRequestDto | null }) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  timer: ReturnType<typeof setTimeout> | null;
  close: (() => void) | null;
}

interface SessionBinding {
  readonly clientKey: string;
  lastSeenAt: number;
}

export interface ServerCoreDesktopBrokerOptions {
  readonly createId?: () => string;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly maxPending?: number;
  readonly maxPendingPerSession?: number;
  readonly maxWaiters?: number;
  readonly bindingLeaseMs?: number;
}

function clientKey(access: AuthenticatedClientAccessContext): string {
  const fields = [
    access.instanceId,
    access.accessCredentialId,
    access.clientId,
    access.surface,
  ];
  return fields.map((value) => `${Buffer.byteLength(value)}:${value}`).join('|');
}

function safeSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value) && Buffer.byteLength(value) <= 256;
}

/** Memory-only Core broker for desktop-owned, session-isolated browser work. */
export class ServerCoreDesktopBroker implements ServerCoreDesktopBrokerPort {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queue: PendingRequest[] = [];
  private readonly waiters: PollWaiter[] = [];
  private readonly bindingBySession = new Map<string, SessionBinding>();
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly maxPending: number;
  private readonly maxPendingPerSession: number;
  private readonly maxWaiters: number;
  private readonly bindingLeaseMs: number;
  private state: 'idle' | 'running' | 'closed' = 'idle';

  constructor(options: ServerCoreDesktopBrokerOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxPendingPerSession = options.maxPendingPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION;
    this.maxWaiters = options.maxWaiters ?? DEFAULT_MAX_WAITERS;
    this.bindingLeaseMs = options.bindingLeaseMs ?? DESKTOP_BROKER_MAX_LEASE_MS;
    if (this.requestTimeoutMs < 1 || this.requestTimeoutMs > DESKTOP_BROKER_MAX_LEASE_MS ||
        this.bindingLeaseMs < this.requestTimeoutMs) {
      throw new Error('desktop broker lease bounds are invalid');
    }
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;
    if (this.state !== 'idle') throw new Error('desktop broker is closed');
    this.state = 'running';
  }

  async stop(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const error = new ServerCoreDesktopBrokerError('stopped', 'Desktop browser bridge stopped');
    for (const request of [...this.pending.values()]) this.finishPending(request, error);
    for (const waiter of [...this.waiters]) this.finishWaiter(waiter, null, error);
    this.queue.splice(0);
    this.bindingBySession.clear();
  }

  async invoke(
    sessionId: string,
    operation: DesktopBrokerBrowserOperation,
    args: JsonObject,
  ): Promise<DesktopBrokerToolResult> {
    this.assertRunning();
    if (!safeSessionId(sessionId)) {
      throw new ServerCoreDesktopBrokerError('unavailable', 'Browser session identity is invalid');
    }
    if (this.pending.size >= this.maxPending) {
      throw new ServerCoreDesktopBrokerError('limit', 'Desktop browser request limit reached');
    }
    const perSession = [...this.pending.values()].filter(
      (pending) => pending.request.sessionId === sessionId,
    ).length;
    if (perSession >= this.maxPendingPerSession) {
      throw new ServerCoreDesktopBrokerError('limit', 'Session browser request limit reached');
    }
    const expiresAt = this.now() + this.requestTimeoutMs;
    const request = parseDesktopBrokerRequest({
      requestId: this.createId(),
      sessionId,
      kind: 'browser',
      operation,
      args,
      leaseMs: this.requestTimeoutMs,
    });
    return await new Promise<DesktopBrokerToolResult>((resolve, reject) => {
      const pending: PendingRequest = {
        expiresAt,
        request,
        assignedClientKey: null,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.finishPending(
            pending,
            new ServerCoreDesktopBrokerError(
              'timeout',
              'Connected desktop did not complete the browser request in time',
            ),
          );
        }, this.requestTimeoutMs),
      };
      pending.timer.unref?.();
      this.pending.set(request.requestId, pending);
      this.queue.push(pending);
      this.dispatch();
    });
  }

  next(
    access: AuthenticatedClientAccessContext,
    params: DesktopBrokerNextParams,
    signal: AbortSignal,
  ): Promise<{ request: DesktopBrokerRequestDto | null }> {
    this.assertDesktop(access);
    this.assertRunning();
    if (signal.aborted) {
      return Promise.reject(new ServerCoreDesktopBrokerError('cancelled', 'Desktop poll cancelled'));
    }
    if (this.waiters.length >= this.maxWaiters) {
      throw new ServerCoreDesktopBrokerError('limit', 'Desktop poller limit reached');
    }
    const key = clientKey(access);
    this.refreshBindings(key);
    return new Promise((resolve, reject) => {
      const waiter: PollWaiter = {
        clientKey: key,
        resolve,
        reject,
        signal,
        timer: null,
        close: null,
      };
      const abort = (): void => this.finishWaiter(
        waiter,
        null,
        new ServerCoreDesktopBrokerError('cancelled', 'Desktop poll cancelled'),
      );
      waiter.close = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      waiter.timer = setTimeout(
        () => this.finishWaiter(waiter, { request: null }),
        params.waitMs,
      );
      waiter.timer.unref?.();
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  respond(
    access: AuthenticatedClientAccessContext,
    params: DesktopBrokerRespondParams,
  ): { accepted: true } {
    this.assertDesktop(access);
    this.assertRunning();
    const pending = this.pending.get(params.requestId);
    if (!pending) {
      throw new ServerCoreDesktopBrokerError('not-found', 'Browser request is no longer active');
    }
    if (pending.assignedClientKey !== clientKey(access)) {
      throw new ServerCoreDesktopBrokerError('conflict', 'Browser request belongs to another desktop');
    }
    this.refreshBindings(pending.assignedClientKey);
    const result = parseDesktopBrokerToolResult(params.result);
    this.finishPending(pending, null, result);
    return { accepted: true };
  }

  releaseSession(sessionId: string, reason = 'Browser session closed'): void {
    this.bindingBySession.delete(sessionId);
    for (const request of [...this.pending.values()]) {
      if (request.request.sessionId === sessionId) {
        this.finishPending(request, new ServerCoreDesktopBrokerError('unavailable', reason));
      }
    }
  }

  renameSession(fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return;
    const binding = this.bindingBySession.get(fromSessionId);
    this.releaseSession(fromSessionId, 'Browser request cancelled while the session was renamed');
    if (binding && !this.bindingBySession.has(toSessionId)) {
      this.bindingBySession.set(toSessionId, binding);
    }
  }

  private dispatch(): void {
    for (const waiter of [...this.waiters]) {
      const request = this.findRequest(waiter.clientKey);
      if (!request) continue;
      const existing = this.bindingBySession.get(request.request.sessionId);
      if (!existing) {
        this.bindingBySession.set(request.request.sessionId, {
          clientKey: waiter.clientKey,
          lastSeenAt: this.now(),
        });
      }
      request.assignedClientKey = waiter.clientKey;
      this.queue.splice(this.queue.indexOf(request), 1);
      const leaseMs = Math.max(1, Math.min(
        DESKTOP_BROKER_MAX_LEASE_MS,
        request.expiresAt - this.now(),
      ));
      this.finishWaiter(waiter, {
        request: parseDesktopBrokerRequest({ ...request.request, leaseMs }),
      });
    }
  }

  private findRequest(key: string): PendingRequest | null {
    return this.queue.find((request) => {
      const binding = this.bindingBySession.get(request.request.sessionId);
      if (!binding) return true;
      if (binding.clientKey === key) return true;
      if (this.now() - binding.lastSeenAt <= this.bindingLeaseMs) return false;
      this.bindingBySession.delete(request.request.sessionId);
      return true;
    }) ?? null;
  }

  private refreshBindings(key: string): void {
    const now = this.now();
    for (const binding of this.bindingBySession.values()) {
      if (binding.clientKey === key) binding.lastSeenAt = now;
    }
  }

  private finishPending(
    pending: PendingRequest,
    error: Error | null,
    result?: DesktopBrokerToolResult,
  ): void {
    if (this.pending.get(pending.request.requestId) !== pending) return;
    this.pending.delete(pending.request.requestId);
    const queued = this.queue.indexOf(pending);
    if (queued >= 0) this.queue.splice(queued, 1);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result!);
  }

  private finishWaiter(
    waiter: PollWaiter,
    value: { request: DesktopBrokerRequestDto | null } | null,
    error?: Error,
  ): void {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.close?.();
    waiter.timer = null;
    waiter.close = null;
    if (error) waiter.reject(error);
    else waiter.resolve(value!);
  }

  private assertDesktop(access: AuthenticatedClientAccessContext): void {
    if (access.surface !== AccessSurface.DesktopFull || access.transport !== 'ssh') {
      throw new ServerCoreDesktopBrokerError('unavailable', 'Desktop broker requires SSH desktop access');
    }
  }

  private assertRunning(): void {
    if (this.state !== 'running') {
      throw new ServerCoreDesktopBrokerError('stopped', 'Desktop browser bridge is unavailable');
    }
  }
}
