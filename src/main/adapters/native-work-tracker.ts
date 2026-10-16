import { createHash, randomUUID } from 'node:crypto';
import type { AgentEvent } from '@shared/types';
import {
  chunkNativeWorkDetail, isTerminalNativeWork, sameNativeWorkRef,
  type NativeWorkDetailKind, type NativeWorkProvider, type NativeWorkRef,
  type NativeWorkSnapshot, type NativeWorkStopResult,
} from '@shared/native-work';

type Observation = Pick<NativeWorkSnapshot, 'taskId' | 'workKind'> &
  Partial<Omit<NativeWorkSnapshot, 'native' | 'revision' | 'startedAt' | 'updatedAt'>>;
let lastRuntimeStartedAt = 0;

/** One instance per live provider generation. It never starts or interrupts a parent turn. */
export class NativeWorkTracker {
  readonly runtimeId = randomUUID();
  readonly tasks = new Map<string, NativeWorkSnapshot>();
  private details = new Map<string, { hash: string; revision: number }>();
  private pendingStops = new Map<string, Promise<NativeWorkStopResult>>();
  private closed = false;
  private attempts = new Map<string, Set<string>>();
  private readonly runtimeStartedAt: number;
  constructor(readonly sessionId: string, readonly provider: NativeWorkProvider,
    private readonly emit: (event: AgentEvent) => void, private readonly now = Date.now) {
    this.runtimeStartedAt = lastRuntimeStartedAt = Math.max(now(), lastRuntimeStartedAt + 1);
  }

  observe(input: Observation, newAttempt = false): NativeWorkSnapshot | undefined {
    if (this.closed) return undefined;
    const previous = this.tasks.get(input.taskId);
    const runId = input.runId ?? previous?.runId ?? this.runtimeId;
    const changedAttempt = previous && previous.runId !== runId;
    if (changedAttempt && !newAttempt) return previous;
    const attempts = this.attempts.get(input.taskId) ?? new Set<string>();
    if (changedAttempt && attempts.has(runId)) return previous;
    attempts.add(runId); this.attempts.set(input.taskId, attempts);
    if (!changedAttempt && previous && isTerminalNativeWork(previous.status) &&
      input.status && !isTerminalNativeWork(input.status)) return previous;
    const base = changedAttempt ? undefined : previous;
    const at = this.now();
    const next: NativeWorkSnapshot = {
      description: '', status: 'running', canStop: false, detailStatus: 'unavailable',
      ...base, ...input, taskId: input.taskId, runId,
      native: { sessionId: this.sessionId, provider: this.provider, nativeId: input.taskId, runId, runtimeId: this.runtimeId },
      startedAt: base?.startedAt ?? Math.max(at, (previous?.startedAt ?? 0) + 1),
      updatedAt: at, revision: (base?.revision ?? 0) + 1,
      runtimeStartedAt: this.runtimeStartedAt,
    };
    if (base) {
      const { updatedAt: _beforeTime, revision: _beforeRevision, ...before } = base;
      const { updatedAt: _afterTime, revision: _afterRevision, ...after } = next;
      if (JSON.stringify(before) === JSON.stringify(after)) return base;
    }
    this.tasks.set(next.taskId, next);
    this.publish('background-task', next);
    return next;
  }

  detail(taskId: string, recordId: string, kind: NativeWorkDetailKind, text: string,
    options: { toolName?: string; sourceTruncated?: boolean; ts?: number } = {}): void {
    const task = this.tasks.get(taskId);
    if (!task || this.closed || task.hidden) return;
    // Provider record identities may be large composite IDs; normalize without leaking paths.
    const stableId = createHash('sha256').update(recordId).digest('hex');
    const key = JSON.stringify([task.runId, taskId, stableId]);
    const hash = createHash('sha256').update(JSON.stringify([kind, text, options.toolName, options.sourceTruncated])).digest('hex');
    const previous = this.details.get(key);
    if (previous?.hash === hash) return;
    const revision = Math.max(this.now(), (previous?.revision ?? 0) + 1);
    this.details.set(key, { hash, revision });
    if (this.details.size > 4096) this.details.delete(this.details.keys().next().value!);
    for (const payload of chunkNativeWorkDetail({ native: task.native, recordId: stableId,
      recordRevision: revision, kind, text, ts: options.ts ?? this.now(),
      sourceTruncated: options.sourceTruncated ?? false,
      ...(options.toolName ? { toolName: options.toolName.slice(0, 128) } : {}) })) this.publish('native-work-detail', payload);
    const detailStatus = options.sourceTruncated || task.detailStatus === 'partial' ? 'partial' : 'available';
    const next = { ...task, detailStatus, revision: task.revision + 1, updatedAt: this.now() } as NativeWorkSnapshot;
    this.tasks.set(taskId, next);
    // Live readers also refresh on detail-only changes; unchanged polling does not rewrite history.
    if (task.detailStatus !== detailStatus) this.publish('background-task', next);
  }

  async stop(ref: NativeWorkRef, action: (task: NativeWorkSnapshot) => Promise<NativeWorkStopResult>): Promise<NativeWorkStopResult> {
    const task = this.tasks.get(ref.nativeId);
    if (this.closed || !task || !sameNativeWorkRef(task.native, ref)) return { status: 'stale' };
    if (isTerminalNativeWork(task.status)) return { status: 'already-terminal' };
    if (!task.canStop) return { status: 'unsupported', reason: task.controlReason };
    const key = JSON.stringify(ref);
    const pending = this.pendingStops.get(key);
    if (pending) return pending;
    const operation = action(task).catch((): NativeWorkStopResult => ({ status: 'failed' }));
    this.pendingStops.set(key, operation);
    try { return await operation; } finally { this.pendingStops.delete(key); }
  }

  list(): NativeWorkSnapshot[] { return [...this.tasks.values()].filter(task => !task.hidden); }
  dispose(): void {
    if (this.closed) return;
    for (const task of this.tasks.values()) {
      this.observe({ taskId: task.taskId, workKind: task.workKind, canStop: false,
        status: isTerminalNativeWork(task.status) ? task.status : 'unknown', controlReason: '运行实例已结束，无法确认任务状态' });
    }
    this.closed = true;
    this.details.clear();
  }
  private publish(kind: AgentEvent['kind'], payload: unknown): void {
    this.emit({ sessionId: this.sessionId, agentId: this.provider, source: 'sdk', ts: this.now(), kind, payload });
  }
}
