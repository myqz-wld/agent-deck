import { randomUUID } from 'node:crypto';

import type { JsonObject, JsonValue } from '@contracts/index';
import type { AgentAdapter } from '@main/adapters/types';
import {
  worktreeTransitionRepo,
  WorktreeTransitionConflictError,
} from '@main/store/worktree-transition-repo';
import { WORKTREE_CLEANUP_UNPROVED_MARKER } from '@main/session/worktree-transition/constants';
import { worktreeTransitionId } from '@main/session/worktree-transition/types';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';
import type { AgentEvent, SessionRecord } from '@shared/types';

import { ServerCoreWorktreeCleanup } from './mcp-worktree-cleanup';
import { ServerCoreWorktreeCoordinator } from './mcp-worktree-coordinator';
import {
  ServerCoreWorktreeCleanupUnprovedError,
  ServerCoreWorktreeError,
  type ServerCoreEnterWorktreeArgs,
  type ServerCoreExitWorktreeArgs,
  type ServerCoreExitWorktreeResult,
  type ServerCoreWorktreeIngressInput,
  type ServerCoreWorktreeRuntimePort,
  type ServerCoreWorktreeWaitingResult,
} from './mcp-worktree-port';
import {
  ServerCoreWorktreePaths,
  type ServerCorePreparedWorktree,
} from './mcp-worktree-paths';

export interface ServerCoreWorktreeRuntimeOptions {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
  readonly sessions: {
    get(sessionId: string): SessionRecord | null;
    setCwd(sessionId: string, cwd: string): void;
  };
  readonly registry: {
    get(adapterId: string): AgentAdapter | undefined;
    list(): AgentAdapter[];
  };
  readonly publishSession: (sessionId: string) => void;
  readonly publishStatus: (
    sessionId: string,
    text: string,
    error: boolean,
    generation: number,
  ) => void;
  readonly appendChange: (
    kind: string,
    entityId: string | null,
    payload: JsonValue,
  ) => void;
  readonly warn: (message: string) => void;
}

/** Public Core worktree tool port plus its private provider-event lifecycle. */
export class ServerCoreWorktreeRuntime implements ServerCoreWorktreeRuntimePort {
  private paths: ServerCoreWorktreePaths | null = null;
  private cleanup: ServerCoreWorktreeCleanup | null = null;
  private coordinator: ServerCoreWorktreeCoordinator | null = null;
  private startPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: ServerCoreWorktreeRuntimeOptions) {}

  start(): Promise<void> {
    this.startPromise ??= this.startOwned();
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.startPromise?.catch(() => undefined);
    await this.coordinator?.stop();
  }

  observe(event: AgentEvent): boolean {
    return this.coordinator?.observe(event) ?? true;
  }

  hasPendingTransition(sessionId: string): boolean {
    return this.coordinator?.hasPendingTransition(sessionId) ?? false;
  }

  guardIngress(input: ServerCoreWorktreeIngressInput): boolean {
    return this.coordinator?.guardIngress(input) ?? false;
  }

  renameSession(fromSessionId: string, toSessionId: string): void {
    this.coordinator?.renameSession(fromSessionId, toSessionId);
  }

  async enter(
    callerSessionId: string,
    args: ServerCoreEnterWorktreeArgs,
  ): Promise<ServerCoreWorktreeWaitingResult> {
    const { coordinator, paths } = this.requireReady();
    const caller = this.requireCaller(callerSessionId);
    const existing = worktreeTransitionRepo.get(callerSessionId);
    if (existing && existing.phase !== 'cleared') {
      if (
        existing.direction === 'enter' &&
        existing.phase === 'enter_waiting_tool_result'
      ) return this.waiting(existing, paths, true);
      throw new ServerCoreWorktreeError(
        `当前会话已有 ${worktreeTransitionId(existing)} worktree lease`,
        existing.phase === 'active'
          ? '不支持嵌套 worktree；请先调用 exit_worktree。'
          : '请等待当前自动目录切换完成。',
      );
    }
    let toolUseId: string;
    try {
      toolUseId = coordinator.reserve(callerSessionId, 'enter');
    } catch {
      throw this.invocationError('enter_worktree');
    }
    let prepared: ServerCorePreparedWorktree;
    try {
      prepared = await paths.prepareEnter({
        sessionId: callerSessionId,
        callerCwd: caller.cwd,
        startPoint: args.startPoint,
        worktreePath: args.worktreePath,
        worktreeRoot: args.worktreeRoot,
      });
    } catch (error) {
      coordinator.release(callerSessionId, toolUseId);
      throw this.publicError(error, 'worktree 预检失败');
    }
    let transition;
    try {
      transition = worktreeTransitionRepo.createEnter({
        sessionId: callerSessionId,
        originalCwd: prepared.originalCwd,
        targetCwd: prepared.worktreePath,
        mainRepo: prepared.mainRepo,
        worktreePath: prepared.worktreePath,
        baseCommit: prepared.startCommit,
        toolUseId,
        continuationKey: `worktree-cwd:${randomUUID()}`,
        requestedAt: Date.now(),
      });
      coordinator.bind(callerSessionId, toolUseId, transition.generation);
    } catch (error) {
      prepared.mutationLease.release();
      coordinator.release(callerSessionId, toolUseId);
      throw this.publicError(error, 'worktree lease 创建失败');
    }
    try {
      await paths.createPrepared(prepared);
      transition = worktreeTransitionRepo.markEnterCreated(
        callerSessionId,
        transition.generation,
        Date.now(),
      );
      coordinator.arm(transition);
      prepared.mutationLease.release();
    } catch (error) {
      await this.rollbackEnterPreparation(prepared, transition, coordinator, error);
      throw this.publicError(error, 'enter_worktree 准备失败');
    }
    this.change('worktree.enter.prepared', callerSessionId, {
      generation: transition.generation,
      startCommit: transition.baseCommit,
      worktreePath: prepared.relativeWorktreePath,
    });
    return this.waiting(transition, paths, true);
  }

  async exit(
    callerSessionId: string,
    args: ServerCoreExitWorktreeArgs,
  ): Promise<ServerCoreExitWorktreeResult> {
    const { cleanup, coordinator, paths } = this.requireReady();
    this.requireCaller(callerSessionId);
    const transition = worktreeTransitionRepo.get(callerSessionId);
    if (!transition || transition.phase === 'cleared') {
      throw new ServerCoreWorktreeError(
        '当前会话没有 active worktree lease',
        '请先调用 enter_worktree。',
      );
    }
    if (
      transition.direction === 'exit' &&
      transition.phase === 'exit_waiting_tool_result'
    ) return this.waiting(transition, paths, false);
    if (transition.phase === 'cleanup_pending') {
      if (
        !transition.continuationDelivered || transition.toolUseId !== null ||
        coordinator.hasClaimed(callerSessionId, transition.generation)
      ) {
        throw new ServerCoreWorktreeError(
          'worktree 自动续接尚未完成',
          '请等待续接输入落库后再重试 exit_worktree。',
        );
      }
      try {
        const result = await cleanup.cleanup(transition);
        const cleared = worktreeTransitionRepo.compareAndSetPhase({
          sessionId: callerSessionId,
          generation: transition.generation,
          expected: 'cleanup_pending',
          next: 'cleared',
          updatedAt: Date.now(),
          lastError: null,
        });
        return {
          transitionId: worktreeTransitionId(cleared),
          direction: 'exit',
          state: 'completed-cleanup',
          effectiveFrom: 'already-effective',
          worktreePath: paths.toRelative(cleared.worktreePath),
          worktreeRemoved: result.worktreeRemoved,
        };
      } catch (error) {
        throw this.publicError(error, 'worktree 清理重试失败');
      }
    }
    if (transition.phase !== 'active') {
      throw new ServerCoreWorktreeError(
        `worktree transition 当前处于 ${transition.phase}`,
        '请等待当前自动目录切换完成后再试。',
      );
    }
    try {
      await cleanup.preflight(transition, {
        worktreePath: args.worktreePath,
        discardChanges: args.discardChanges === true,
      });
    } catch (error) {
      throw this.publicError(error, 'exit_worktree 预检失败');
    }
    let toolUseId: string;
    try {
      toolUseId = coordinator.reserve(callerSessionId, 'exit');
    } catch {
      throw this.invocationError('exit_worktree');
    }
    let exiting;
    try {
      exiting = worktreeTransitionRepo.beginExitPreflight(
        callerSessionId,
        transition.generation,
        {
          toolUseId,
          continuationKey: `worktree-cwd:${randomUUID()}`,
          discardChanges: args.discardChanges === true,
          requestedAt: Date.now(),
        },
      );
      coordinator.bind(callerSessionId, toolUseId, exiting.generation);
      coordinator.arm(exiting);
      exiting = worktreeTransitionRepo.compareAndSetPhase({
        sessionId: callerSessionId,
        generation: exiting.generation,
        expected: 'exit_preflight',
        next: 'exit_waiting_tool_result',
        updatedAt: Date.now(),
      });
    } catch (error) {
      coordinator.release(callerSessionId, toolUseId);
      const current = worktreeTransitionRepo.get(callerSessionId);
      if (
        current?.generation === transition.generation &&
        current.phase === 'exit_preflight'
      ) {
        try {
          await coordinator.releaseAborted(current, this.errorText(error));
        } catch (releaseError) {
          worktreeTransitionRepo.setLastError(
            transition.sessionId,
            transition.generation,
            `${this.errorText(error)}; release: ${this.errorText(releaseError)}`,
            Date.now(),
          );
        }
      }
      throw this.publicError(error, 'exit_worktree 无法启动自动目录切换');
    }
    this.change('worktree.exit.prepared', callerSessionId, {
      discardChanges: exiting.discardChanges,
      generation: exiting.generation,
      worktreePath: paths.toRelative(exiting.worktreePath),
    });
    return this.waiting(exiting, paths, false);
  }

  private async startOwned(): Promise<void> {
    if (this.stopped) throw new Error('Server Core worktree runtime is stopped');
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: this.options.workspaceRoot,
      privateRoots: this.options.privateRoots,
    });
    const cleanup = new ServerCoreWorktreeCleanup({
      paths,
      registry: this.options.registry,
    });
    const coordinator = new ServerCoreWorktreeCoordinator({
      sessions: this.options.sessions,
      registry: this.options.registry,
      cleanup,
      publishSession: this.options.publishSession,
      publishStatus: this.options.publishStatus,
      warn: this.options.warn,
    });
    this.paths = paths;
    this.cleanup = cleanup;
    this.coordinator = coordinator;
    await coordinator.start();
  }

  private requireReady() {
    if (this.stopped || !this.paths || !this.cleanup || !this.coordinator) {
      throw new ServerCoreWorktreeError(
        'Server Core worktree 服务尚未就绪',
        '请等待 Remote Core 完成启动后再试。',
      );
    }
    return {
      paths: this.paths,
      coordinator: this.coordinator,
      cleanup: this.cleanup,
    };
  }

  private requireCaller(sessionId: string): SessionRecord {
    const session = this.options.sessions.get(sessionId);
    if (!session || session.lifecycle === 'closed' || session.archivedAt !== null) {
      throw new ServerCoreWorktreeError(
        '认证会话当前不可用',
        '请从一个 active Remote 会话调用 worktree 工具。',
      );
    }
    return session;
  }

  private async rollbackEnterPreparation(
    prepared: ServerCorePreparedWorktree,
    transition: ReturnType<typeof worktreeTransitionRepo.createEnter>,
    coordinator: ServerCoreWorktreeCoordinator,
    error: unknown,
  ): Promise<void> {
    prepared.mutationLease.release();
    const failure = this.errorText(error);
    const persistedFailure = error instanceof ServerCoreWorktreeCleanupUnprovedError
      ? `${WORKTREE_CLEANUP_UNPROVED_MARKER}: ${failure}`
      : failure;
    let rollbackRecord = transition;
    if (error instanceof ServerCoreWorktreeCleanupUnprovedError) {
      rollbackRecord = worktreeTransitionRepo.setLastError(
        transition.sessionId,
        transition.generation,
        persistedFailure,
        Date.now(),
      );
    }
    let rolledBack = false;
    try {
      await this.cleanup!.rollbackEnter(rollbackRecord);
      rolledBack = true;
    } catch (rollbackError) {
      worktreeTransitionRepo.setLastError(
        transition.sessionId,
        transition.generation,
        `${persistedFailure}; rollback: ${this.errorText(rollbackError)}`,
        Date.now(),
      );
    }
    if (rolledBack) {
      if (error instanceof ServerCoreWorktreeCleanupUnprovedError) {
        worktreeTransitionRepo.clearCleanupUnprovedLastError(
          transition.sessionId,
          transition.generation,
          failure,
          Date.now(),
        );
      }
      const current = worktreeTransitionRepo.get(transition.sessionId);
      if (current && current.generation === transition.generation &&
          ['creating', 'enter_waiting_tool_result'].includes(current.phase)) {
        try {
          await coordinator.releaseAborted(current, failure);
        } catch (releaseError) {
          worktreeTransitionRepo.setLastError(
            transition.sessionId,
            transition.generation,
            `${failure}; release: ${this.errorText(releaseError)}`,
            Date.now(),
          );
        }
      }
    }
  }

  private waiting(
    record: WorktreeTransitionRecord,
    paths: ServerCoreWorktreePaths,
    includeCommit: boolean,
  ): ServerCoreWorktreeWaitingResult {
    return {
      transitionId: worktreeTransitionId(record),
      direction: record.direction,
      state: 'waiting-tool-result',
      effectiveFrom: 'automatic-next-turn',
      worktreePath: paths.toRelative(record.worktreePath),
      ...(includeCommit
        ? { startCommit: record.baseCommit, headMode: 'detached' as const }
        : {}),
    };
  }

  private change(kind: string, sessionId: string, payload: JsonObject): void {
    try { this.options.appendChange(kind, sessionId, payload); } catch {}
  }

  private invocationError(tool: string): ServerCoreWorktreeError {
    return new ServerCoreWorktreeError(
      `无法关联当前 ${tool} 的 provider tool-use`,
      '只能从当前 active provider turn 调用该工具；不要通过外部 HTTP 或另一会话代调。',
    );
  }

  private publicError(error: unknown, fallback: string): ServerCoreWorktreeError {
    if (error instanceof ServerCoreWorktreeError) return error;
    if (error instanceof WorktreeTransitionConflictError) {
      return new ServerCoreWorktreeError(fallback, '已有并发 transition 获得了 lease，请稍后重试。');
    }
    return new ServerCoreWorktreeError(
      fallback,
      'Core 已保留 Workspace、Git 引用和 transition 状态；请检查后再试。',
    );
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
