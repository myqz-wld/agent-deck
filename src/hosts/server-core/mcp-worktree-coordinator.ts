import type { AgentAdapter } from '@main/adapters/types';
import {
  worktreeTransitionInputRepo,
  WorktreeTransitionInputClosedError,
} from '@main/store/worktree-transition-input-repo';
import {
  worktreeTransitionRepo,
  WorktreeTransitionConflictError,
} from '@main/store/worktree-transition-repo';
import {
  ALLOWED_FENCED_EVENTS,
  eventPayload,
  isSuccessfulToolResult,
  worktreeErrorText,
} from '@main/session/worktree-transition/coordinator-helpers';
import { isPendingWorktreeTransition } from '@main/session/worktree-transition/state-machine';
import {
  compensateTransitionRuntime,
  deliverTransitionWork,
  replayAbortedTransitionInputs,
  toAgentCwdTransition,
} from '@main/session/worktree-transition/transition-delivery';
import {
  WorktreeToolInvocationRegistry,
} from '@main/session/worktree-transition/tool-invocation-registry';
import type {
  WorktreeTransitionDirection,
  WorktreeTransitionRecord,
} from '@main/session/worktree-transition/types';
import type { AgentEvent } from '@shared/types';

import type {
  ServerCoreWorktreeIngressInput,
  ServerCoreWorktreeRuntimePort,
} from './mcp-worktree-port';
import { ServerCoreWorktreeRecovery } from './mcp-worktree-recovery';
import type { ServerCoreWorktreeRuntimeDependencies } from './mcp-worktree-runtime-deps';

const MAX_RECOVERABLE_TRANSITIONS = 1_024;
const STOP_WAIT_MS = 10_000;

/** Core-owned provider event fence and automatic cwd transition state machine. */
export class ServerCoreWorktreeCoordinator implements Pick<
  ServerCoreWorktreeRuntimePort,
  'start' | 'stop' | 'observe' | 'hasPendingTransition' | 'guardIngress' | 'renameSession'
> {
  private readonly invocations = new WorktreeToolInvocationRegistry();
  private readonly finalizing = new Map<string, Promise<void>>();
  private readonly deferred = new Map<string, number>();
  private readonly recovery: ServerCoreWorktreeRecovery;
  private running = false;

  constructor(private readonly options: ServerCoreWorktreeRuntimeDependencies) {
    this.recovery = new ServerCoreWorktreeRecovery({
      ...options,
      releaseInvocation: (sessionId, toolUseId, generation) =>
        this.release(sessionId, toolUseId, generation),
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const records = worktreeTransitionRepo.listRecoverable();
    if (records.length > MAX_RECOVERABLE_TRANSITIONS) {
      this.running = false;
      throw new Error('Recoverable worktree transition ceiling exceeded');
    }
    for (const record of records) {
      const session = this.options.sessions.get(record.sessionId);
      if (!session || session.lifecycle === 'closed' || session.archivedAt !== null) {
        this.deferred.set(record.sessionId, record.generation);
        continue;
      }
      await this.recovery.recover(record.sessionId);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.deferred.clear();
    const pending = [...this.finalizing.values()];
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      Promise.allSettled(pending).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  reserve(sessionId: string, direction: WorktreeTransitionDirection): string {
    return this.invocations.reserve(sessionId, direction);
  }

  bind(sessionId: string, toolUseId: string, generation: number): void {
    this.invocations.bindGeneration(sessionId, toolUseId, generation);
  }

  release(sessionId: string, toolUseId: string, generation?: number): void {
    this.invocations.release(sessionId, toolUseId, generation);
  }

  hasClaimed(sessionId: string, generation: number): boolean {
    return this.invocations.hasClaimedTransition(sessionId, generation);
  }

  arm(record: WorktreeTransitionRecord): void {
    const adapter = this.requireAdapter(record.sessionId);
    if (
      !adapter.armCwdTransition || !adapter.switchCwdForTransition ||
      !adapter.releaseCwdTransition || !adapter.getRuntimeCwd ||
      !adapter.interruptSession
    ) {
      throw new Error(`${adapter.id} cannot perform automatic cwd transitions`);
    }
    adapter.armCwdTransition(toAgentCwdTransition(record));
  }

  async releaseAborted(
    record: WorktreeTransitionRecord,
    failure: string,
  ): Promise<WorktreeTransitionRecord> {
    const adapter = this.requireAdapter(record.sessionId);
    const toolUseId = record.toolUseId;
    const settled = await replayAbortedTransitionInputs(record, adapter, {
      kind: 'phase',
      expected: record.phase,
      next: record.direction === 'enter' ? 'cleared' : 'active',
      lastError: failure,
    });
    this.releaseOwnership(adapter, settled, toolUseId);
    return settled;
  }

  observe(event: AgentEvent): boolean {
    this.invocations.observe(event);
    if (event.source !== 'sdk') return true;
    const record = worktreeTransitionRepo.get(event.sessionId);
    if (!record || record.phase === 'active' || record.phase === 'cleared') return true;
    const payload = eventPayload(event);
    const toolUseId = typeof payload.toolUseId === 'string' ? payload.toolUseId : null;
    if (
      event.kind === 'tool-use-end' && toolUseId !== null &&
      toolUseId === record.toolUseId
    ) {
      if (!isSuccessfulToolResult(event)) {
        worktreeTransitionRepo.setLastError(
          record.sessionId,
          record.generation,
          'Provider rejected the worktree transition tool result',
          Date.now(),
        );
        queueMicrotask(() => void this.recovery.recover(record.sessionId));
        return true;
      }
      const expected = record.direction === 'enter'
        ? 'enter_waiting_tool_result'
        : 'exit_waiting_tool_result';
      const next = record.direction === 'enter'
        ? 'interrupting_enter_turn'
        : 'interrupting_exit_turn';
      if (record.phase === expected) {
        try {
          worktreeTransitionRepo.compareAndSetPhase({
            sessionId: record.sessionId,
            generation: record.generation,
            expected,
            next,
            updatedAt: Date.now(),
          });
          queueMicrotask(() => void this.requestInterrupt(record.sessionId, record.generation));
        } catch (error) {
          if (!(error instanceof WorktreeTransitionConflictError)) throw error;
        }
      }
      return true;
    }
    if (
      record.phase === 'interrupting_enter_turn' ||
      record.phase === 'interrupting_exit_turn'
    ) {
      if (event.kind === 'finished') {
        event.payload = {
          ...payload,
          expectedWorktreeTransition: {
            direction: record.direction,
            generation: record.generation,
          },
        };
        queueMicrotask(() => void this.finalize(record.sessionId, record.generation));
        return true;
      }
      return ALLOWED_FENCED_EVENTS.has(event.kind);
    }
    return true;
  }

  hasPendingTransition(sessionId: string): boolean {
    if (this.invocations.hasPendingTransition(sessionId)) return true;
    const record = worktreeTransitionRepo.get(sessionId);
    return Boolean(record && isPendingWorktreeTransition(record.phase));
  }

  guardIngress(input: ServerCoreWorktreeIngressInput): boolean {
    if (input.bypassWorktreeTransition === true) return false;
    const transition = worktreeTransitionRepo.get(input.sourceSessionId);
    if (
      !transition || !isPendingWorktreeTransition(transition.phase) ||
      transition.toolUseId === null
    ) return false;
    try {
      const queued = worktreeTransitionInputRepo.append({
        sessionId: input.sourceSessionId,
        generation: transition.generation,
        agentId: input.agentId,
        text: input.text,
        attachments: input.attachments,
        createdAt: Date.now(),
      });
      try {
        input.emit({
          sessionId: input.sourceSessionId,
          agentId: input.agentId,
          kind: 'message',
          payload: {
            role: 'user',
            text: input.text,
            worktreeTransitionBuffered: {
              generation: transition.generation,
              sequence: queued.sequence,
            },
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          },
          ts: queued.createdAt,
          source: 'sdk',
        });
      } catch {
        this.options.warn('Buffered worktree input projection failed');
      }
      this.resumeDeferred(input.sourceSessionId);
      return true;
    } catch (error) {
      if (error instanceof WorktreeTransitionInputClosedError) return false;
      throw error;
    }
  }

  renameSession(fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return;
    worktreeTransitionRepo.renameLease(fromSessionId, toSessionId, Date.now());
    this.invocations.renameSession(fromSessionId, toSessionId);
    const generation = this.deferred.get(fromSessionId);
    if (generation !== undefined) {
      this.deferred.delete(fromSessionId);
      this.deferred.set(toSessionId, generation);
    }
  }

  private resumeDeferred(sessionId: string): void {
    const generation = this.deferred.get(sessionId);
    if (generation === undefined || !this.running) return;
    const session = this.options.sessions.get(sessionId);
    const record = worktreeTransitionRepo.get(sessionId);
    if (
      !session || session.lifecycle === 'closed' || session.archivedAt !== null ||
      !record || record.generation !== generation
    ) return;
    this.deferred.delete(sessionId);
    queueMicrotask(() => void this.recovery.recover(sessionId));
  }

  private async requestInterrupt(sessionId: string, generation: number): Promise<void> {
    const record = worktreeTransitionRepo.get(sessionId);
    if (
      !record || record.generation !== generation ||
      !['interrupting_enter_turn', 'interrupting_exit_turn'].includes(record.phase)
    ) return;
    try {
      await this.requireAdapter(sessionId).interruptSession?.(sessionId);
    } catch (error) {
      worktreeTransitionRepo.setLastError(
        sessionId,
        generation,
        `Expected provider interrupt failed: ${worktreeErrorText(error)}`,
        Date.now(),
      );
    }
  }

  private finalize(sessionId: string, generation: number): Promise<void> {
    const key = `${sessionId}:${generation}`;
    const existing = this.finalizing.get(key);
    if (existing) return existing;
    const operation = this.finalizeOwned(sessionId, generation)
      .catch((error) => this.recovery.recover(sessionId, error))
      .finally(() => {
        if (this.finalizing.get(key) === operation) this.finalizing.delete(key);
      });
    this.finalizing.set(key, operation);
    return operation;
  }

  private async finalizeOwned(sessionId: string, generation: number): Promise<void> {
    const record = worktreeTransitionRepo.get(sessionId);
    if (!record || record.generation !== generation) return;
    if (record.phase === 'interrupting_enter_turn') await this.finalizeEnter(record);
    else if (record.phase === 'interrupting_exit_turn') await this.finalizeExit(record);
  }

  private async finalizeEnter(initial: WorktreeTransitionRecord): Promise<void> {
    let record = worktreeTransitionRepo.compareAndSetPhase({
      sessionId: initial.sessionId,
      generation: initial.generation,
      expected: 'interrupting_enter_turn',
      next: 'switching_to_worktree',
      updatedAt: Date.now(),
    });
    const adapter = this.requireAdapter(record.sessionId);
    const transition = toAgentCwdTransition(record);
    let switched = false;
    let persisted = false;
    try {
      const result = await adapter.switchCwdForTransition!(transition);
      switched = true;
      this.setCwd(record.sessionId, record.worktreePath);
      persisted = true;
      const toolUseId = record.toolUseId;
      record = await deliverTransitionWork(record, adapter, transition, result.continuationAccepted, {
        kind: 'phase', expected: 'switching_to_worktree', next: 'active',
      });
      this.releaseOwnership(adapter, record, toolUseId);
      this.status(record, '已切换到 Workspace 内的 worktree，正在继续当前任务', false);
    } catch (error) {
      if (switched && !persisted) await compensateTransitionRuntime(adapter, transition);
      throw error;
    }
  }

  private async finalizeExit(initial: WorktreeTransitionRecord): Promise<void> {
    let record = worktreeTransitionRepo.compareAndSetPhase({
      sessionId: initial.sessionId,
      generation: initial.generation,
      expected: 'interrupting_exit_turn',
      next: 'restoring_original_cwd',
      updatedAt: Date.now(),
    });
    const adapter = this.requireAdapter(record.sessionId);
    const transition = toAgentCwdTransition(record);
    let switched = false;
    let persisted = false;
    try {
      const result = await adapter.switchCwdForTransition!(transition);
      switched = true;
      this.setCwd(record.sessionId, record.originalCwd);
      persisted = true;
      record = worktreeTransitionRepo.compareAndSetPhase({
        sessionId: record.sessionId,
        generation: record.generation,
        expected: 'restoring_original_cwd',
        next: 'cleanup_pending',
        updatedAt: Date.now(),
      });
      let cleanupFailure: string | null = null;
      try { await this.options.cleanup.cleanup(record); } catch (error) {
        cleanupFailure = `Worktree cleanup pending: ${worktreeErrorText(error)}`;
      }
      const toolUseId = record.toolUseId;
      record = await deliverTransitionWork(
        record,
        adapter,
        transition,
        result.continuationAccepted,
        cleanupFailure
          ? { kind: 'seal', expected: 'cleanup_pending', lastError: cleanupFailure }
          : { kind: 'phase', expected: 'cleanup_pending', next: 'cleared' },
      );
      this.releaseOwnership(adapter, record, toolUseId);
      this.status(
        record,
        cleanupFailure
          ? '已恢复原目录；worktree 清理仍需重试'
          : '已恢复原目录并安全移除 worktree，正在继续当前任务',
        cleanupFailure !== null,
      );
    } catch (error) {
      if (switched && !persisted) await compensateTransitionRuntime(adapter, transition);
      throw error;
    }
  }

  private requireAdapter(sessionId: string): AgentAdapter {
    const session = this.options.sessions.get(sessionId);
    const adapter = session ? this.options.registry.get(session.agentId) : undefined;
    if (!session || !adapter) throw new Error('Worktree session adapter is unavailable');
    return adapter;
  }

  private setCwd(sessionId: string, cwd: string): void {
    this.options.sessions.setCwd(sessionId, cwd);
    this.options.publishSession(sessionId);
  }

  private releaseOwnership(
    adapter: AgentAdapter,
    record: WorktreeTransitionRecord,
    toolUseId: string | null,
  ): void {
    adapter.releaseCwdTransition?.(record.sessionId, record.generation);
    if (toolUseId) this.release(record.sessionId, toolUseId, record.generation);
  }

  private status(record: WorktreeTransitionRecord, text: string, error: boolean): void {
    this.options.publishStatus(record.sessionId, text, error, record.generation);
  }

}
