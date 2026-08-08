import type { CreateSessionOptions, QueuedAgentMessage } from '@main/adapters/types';
import type { SessionEventRevisionState } from '@main/store/event-revision-repo';
import type {
  SessionHandOffCommitResult,
  SessionHandOffPreparation,
  SessionHandOffTarget,
  SessionRecord,
} from '@shared/types';
import {
  ContinuationPreparationCache,
  type CachedContinuationPreparation,
} from '../continuation-context/preparation-cache';
import type { PreparedHandOffContinuation } from '../continuation-context/handoff';
import { createTrustedContinuationInitialTurn } from '../continuation-context/initial-turn';
import { continuationFingerprint } from '../continuation-context/resolver';
import type { ContinuationSpoolMetadata } from '../continuation-context/source-spool';
import type { ResolvedHandOffTarget } from './target-resolver';
import { publicHandOffPreparation } from './ui-preparation-view';
export {
  boundedContinuationPreview,
  UI_CONTINUATION_PREVIEW_MAX_BYTES,
  UI_CONTINUATION_PREVIEW_MAX_TOKENS,
} from './ui-preparation-view';
import {
  HandOffCutoverCoordinator,
  handOffCutoverCoordinator,
  type HandOffCutoverLease,
} from './cutover-coordinator';
import type {
  ExecutePreparedHandOffResult,
  HandOffExecutionError,
  HandOffSourceCutoverPrecondition,
} from './executor';
import type {
  HandOffSourceCutoverCheck,
  HandOffSourceCutoverResult,
} from './source-precondition';
export interface UiHandOffExecutionResult {
  successorSessionId: string;
  queuedMessagesDelivered: number;
  sourceCutover: Extract<HandOffSourceCutoverResult, { ok: true }>;
  sourceFinalization: ExecutePreparedHandOffResult<unknown, unknown>['sourceFinalization'];
  usedLowerBudgetRetry: boolean;
}

export interface UiHandOffCoordinatorDependencies {
  cache: ContinuationPreparationCache;
  cutoverCoordinator?: HandOffCutoverCoordinator;
  getSession: (sessionId: string) => SessionRecord | null;
  eventState: (sessionId: string) => SessionEventRevisionState | null;
  maxEventId: (sessionId: string) => number | null;
  sourceRuntimeFingerprint: (sessionId: string) => string | null;
  snapshotQueuedMessages: (source: SessionRecord) => QueuedAgentMessage[];
  sourcePreconditionCheck: (input: HandOffSourceCutoverCheck) => HandOffSourceCutoverResult;
  resolveTarget: (input: {
    source: SessionRecord;
    selection: SessionHandOffTarget;
    sourceMaxEventId: number | null;
  }) => ResolvedHandOffTarget;
  revalidateTarget: (
    input: {
      source: SessionRecord;
      selection: SessionHandOffTarget;
      sourceMaxEventId: number | null;
    },
    frozenContextCapacity: ResolvedHandOffTarget['spec']['contextCapacity'],
  ) => ResolvedHandOffTarget;
  prepare: (input: {
    sourceSessionId: string;
    continuationInstruction: string;
    target: ResolvedHandOffTarget['spec'];
  }) => Promise<PreparedHandOffContinuation>;
  currentSettingsFingerprint: () => string;
  spoolMetadata: (spoolId: string) => ContinuationSpoolMetadata;
  cleanupSpool: (spoolId: string) => void;
  execute: (input: {
    source: SessionRecord;
    queuedMessages: QueuedAgentMessage[];
    sourcePrecondition: HandOffSourceCutoverPrecondition;
    target: CreateSessionOptions;
    turn: ReturnType<typeof createTrustedContinuationInitialTurn>;
    targetCapacityStatus: 'observed' | 'stale' | 'unknown';
    lowerBudgetRetryTurn: ReturnType<typeof createTrustedContinuationInitialTurn> | null;
    commitIngress: (successorSessionId: string) => void;
    sourceOwnershipCheck: () => boolean;
  }) => Promise<UiHandOffExecutionResult>;
  isTransferExecutionError: (error: unknown) => error is HandOffExecutionError<unknown>;
}

interface FrozenUiPreparation {
  sourceRuntimeFingerprint: string;
  settingsFingerprint: string;
  targetSelection: SessionHandOffTarget;
  createOptions: CreateSessionOptions;
  targetRuntimeFingerprint: string;
  targetContextCapacity: ResolvedHandOffTarget['spec']['contextCapacity'];
  createOptionsFingerprint: string;
  preparedIntegrityFingerprint: string;
  queuedMessages: QueuedAgentMessage[];
}

interface UiPreparationLeaseState {
  sourceSessionId: string;
  lease: HandOffCutoverLease;
  executing: boolean;
  revoked: boolean;
  ingressCommitted: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireOpenSource(source: SessionRecord | null, sourceSessionId: string): SessionRecord {
  if (!source) throw new Error(`源会话不存在：${sourceSessionId}`);
  if (source.archivedAt !== null) {
    throw new Error(
      source.lifecycle === 'closed'
        ? '源会话已关闭并归档，请先取消归档，再重新激活后生成会话续接上下文。'
        : '源会话已归档，请先取消归档后再生成会话续接上下文。',
    );
  }
  if (source.lifecycle === 'closed') {
    throw new Error('源会话已关闭，请重新激活后再生成会话续接上下文。');
  }
  return source;
}

function requireUiSourceReady(
  source: SessionRecord | null,
  sourceSessionId: string,
): SessionRecord {
  const open = requireOpenSource(source, sourceSessionId);
  if (open.activity === 'working' || open.activity === 'waiting') {
    throw new Error('源会话仍在运行，请等待当前任务完成或先中断，再开始接力。');
  }
  return open;
}

function frozen(entry: CachedContinuationPreparation): FrozenUiPreparation {
  if (!entry.frozen) throw new Error('会话续接上下文缺少冻结的目标配置，请重新生成。');
  return entry.frozen as FrozenUiPreparation;
}

export class UiHandOffCoordinator {
  private readonly cutoverCoordinator: HandOffCutoverCoordinator;
  private readonly preparationLeases = new Map<string, UiPreparationLeaseState>();

  constructor(private readonly deps: UiHandOffCoordinatorDependencies) {
    this.cutoverCoordinator = deps.cutoverCoordinator ?? handOffCutoverCoordinator;
  }

  async prepare(input: {
    ownerSessionId: string;
    sourceSessionId: string;
    continuationInstruction: string;
    target: SessionHandOffTarget;
  }): Promise<SessionHandOffPreparation> {
    const acquisition = this.cutoverCoordinator.acquire(input.sourceSessionId);
    if (!acquisition.ok) {
      if (acquisition.reason === 'active') {
        throw new Error('该源会话的上一项交接操作仍在处理中，请等待其完成。');
      }
      if (acquisition.reason === 'sealed') {
        requireOpenSource(this.deps.getSession(input.sourceSessionId), input.sourceSessionId);
        throw new Error('源会话已完成交接或正在关闭，请先重新激活源会话再开始新的交接。');
      }
      if (acquisition.reason === 'committed') {
        throw new Error(
          `源会话已完成交接至 ${acquisition.successorSessionId}，请在续接会话中继续，` +
          '或先重新激活源会话再开始新的交接。',
        );
      }
      throw new Error('无法确认源会话是否已完成交接，请检查会话存储后重试。');
    }
    const cutoverLease = acquisition.lease;
    let handOff: PreparedHandOffContinuation | null = null;
    let cachedPreparationId: string | null = null;
    try {
      const source = requireUiSourceReady(
        this.deps.getSession(input.sourceSessionId),
        input.sourceSessionId,
      );
      const queuedMessages = this.deps.snapshotQueuedMessages(source).map((message) => ({
        text: message.text,
        ...(message.attachments
          ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
          : {}),
      }));
      const state = this.deps.eventState(source.id);
      if (!state) throw new Error('源会话缺少事件修订状态，请重试。');
      const sourceMaxEventId = this.deps.maxEventId(source.id);
      const sourceRuntimeFingerprint = this.deps.sourceRuntimeFingerprint(source.id);
      if (!sourceRuntimeFingerprint) throw new Error('无法冻结源会话运行时，请重试。');
      const target = this.deps.resolveTarget({
        source,
        selection: input.target,
        sourceMaxEventId,
      });
      const createOptionsFingerprint = continuationFingerprint(target.createOptions);
      handOff = await this.deps.prepare({
        sourceSessionId: source.id,
        continuationInstruction: input.continuationInstruction,
        target: target.spec,
      });
      if (!cutoverLease.canCommit()) {
        throw new Error('源会话在生成续接上下文期间已关闭、归档或移除。');
      }
      const metadata = this.deps.spoolMetadata(handOff.prepared.spoolId);
      if (
        metadata.runtimeFingerprint !== sourceRuntimeFingerprint ||
        target.createOptions.handOff?.sourceMaxEventId !== handOff.prepared.source.maxEventId
      ) {
        throw new Error('源会话在目标解析与历史冻结之间发生变化。');
      }
      const preparedIntegrityFingerprint = continuationFingerprint({
        primary: handOff.prepared,
        lowerBudgetRetry: handOff.lowerBudgetRetry?.prepared ?? null,
      });
      const snapshot: FrozenUiPreparation = {
        sourceRuntimeFingerprint,
        settingsFingerprint: handOff.settingsFingerprint,
        targetSelection: { ...input.target },
        createOptions: target.createOptions,
        targetRuntimeFingerprint: target.spec.runtimeFingerprint,
        targetContextCapacity: target.spec.contextCapacity,
        createOptionsFingerprint,
        preparedIntegrityFingerprint,
        queuedMessages,
      };
      this.assertFresh({
        sourceSessionId: source.id,
        prepared: handOff.prepared,
        lowerBudgetRetry: handOff.lowerBudgetRetry?.prepared ?? null,
        snapshot,
      });
      let leasePreparationId: string | null = null;
      const entry = this.deps.cache.put({
        ownerSessionId: input.ownerSessionId,
        sourceSessionId: source.id,
        prepared: handOff.prepared,
        lowerBudgetRetry: handOff.lowerBudgetRetry?.prepared ?? null,
        generator: handOff.generator,
        target: handOff.target,
        frozen: snapshot,
        spoolBytes: metadata.spoolBytes,
        onDiscard: () => {
          if (leasePreparationId) this.releasePreparationLease(leasePreparationId);
          else cutoverLease.release();
        },
      });
      leasePreparationId = entry.preparationId;
      this.preparationLeases.set(entry.preparationId, {
        sourceSessionId: source.id,
        lease: cutoverLease,
        executing: false,
        revoked: false,
        ingressCommitted: false,
      });
      cachedPreparationId = entry.preparationId;
      return publicHandOffPreparation(entry);
    } catch (error) {
      try {
        if (cachedPreparationId) this.deps.cache.delete(cachedPreparationId);
        else if (handOff) this.deps.cleanupSpool(handOff.prepared.spoolId);
      } catch {
        // Preserve the preparation failure; lease release below is the mandatory cleanup.
      } finally {
        cutoverLease.release();
      }
      throw error;
    }
  }

  async commit(ownerSessionId: string, preparationId: string): Promise<SessionHandOffCommitResult> {
    const entry = this.deps.cache.peek(preparationId, ownerSessionId);
    const leaseState = this.preparationLeases.get(entry.preparationId);
    if (!leaseState) {
      throw new Error('会话续接上下文的输入切换租约已失效，请重新生成。');
    }
    if (entry.consumed || leaseState.executing) {
      throw new Error('会话续接上下文正在提交，请等待当前操作完成。');
    }
    const cutoverLease = leaseState.lease;
    let retainLeaseForRetry = false;
    try {
      try {
        this.assertFresh({
          sourceSessionId: entry.sourceSessionId,
          prepared: entry.prepared,
          lowerBudgetRetry: entry.lowerBudgetRetry,
          snapshot: frozen(entry),
        });
      } catch (error) {
        this.deps.cache.delete(entry.preparationId);
        throw new Error(`会话续接上下文已过期，请重新生成。${errorMessage(error)}`);
      }

      const source = requireOpenSource(
        this.deps.getSession(entry.sourceSessionId),
        entry.sourceSessionId,
      );
      this.deps.cache.consume(entry.preparationId, ownerSessionId);
      leaseState.executing = true;
      try {
        const result = await this.deps.execute({
          source,
          queuedMessages: frozen(entry).queuedMessages,
          sourcePrecondition: {
            eventRevision: entry.prepared.source.eventRevision,
            rebuildAfterRevision: entry.prepared.source.rebuildAfterRevision,
            maxEventId: entry.prepared.source.maxEventId,
            runtimeFingerprint: frozen(entry).sourceRuntimeFingerprint,
          },
          target: frozen(entry).createOptions,
          turn: createTrustedContinuationInitialTurn(entry.prepared, entry.sourceSessionId),
          targetCapacityStatus: entry.target.contextCapacity.status,
          lowerBudgetRetryTurn: entry.lowerBudgetRetry
            ? createTrustedContinuationInitialTurn(
                entry.lowerBudgetRetry,
                entry.sourceSessionId,
              )
            : null,
          sourceOwnershipCheck: () => !leaseState.revoked && cutoverLease.canCommit(),
          commitIngress: (successorSessionId) => {
            if (!cutoverLease.commit(successorSessionId)) {
              throw new Error('源会话输入切换租约已撤销，无法提交交接。');
            }
            leaseState.ingressCommitted = true;
          },
        });
        if (!result.sourceFinalization.ok) {
          this.cutoverCoordinator.revokeSource(entry.sourceSessionId);
        }
        this.deps.cache.delete(entry.preparationId);
        return {
          successorSessionId: result.successorSessionId,
          cutoverEventRevision: result.sourceCutover.currentEventRevision,
          lateMessagesDelivered:
            result.sourceCutover.lateMessages.length + result.queuedMessagesDelivered,
          usedLowerBudgetRetry: result.usedLowerBudgetRetry,
          sourceFinalizationWarning:
            result.sourceFinalization.ok ? null : result.sourceFinalization.error,
        };
      } catch (error) {
        if (this.deps.isTransferExecutionError(error)) {
          this.deps.cache.delete(entry.preparationId);
        } else {
          let released = false;
          try {
            released = this.deps.cache.releasePreSpawnFailure(
              entry.preparationId,
              ownerSessionId,
            );
          } catch {
            // Settings/session invalidation may evict the entry while successor creation is pending.
          }
          if (released && !leaseState.revoked && cutoverLease.canCommit()) {
            retainLeaseForRetry = true;
            leaseState.executing = false;
          }
          else this.deps.cache.delete(entry.preparationId);
        }
        throw error;
      }
    } finally {
      if (!retainLeaseForRetry) cutoverLease.release();
    }
  }

  cancel(ownerSessionId: string, preparationId: string): boolean {
    const entry = this.deps.cache.peek(preparationId, ownerSessionId);
    if (entry.consumed || !this.preparationLeases.has(entry.preparationId)) return false;
    return this.deps.cache.delete(preparationId);
  }

  invalidateSource(sourceSessionId: string): number {
    this.cutoverCoordinator.revokeSource(sourceSessionId);
    for (const state of this.preparationLeases.values()) {
      if (state.sourceSessionId !== sourceSessionId || state.ingressCommitted) continue;
      state.revoked = true;
      state.lease.revoke();
    }
    return this.deps.cache.invalidateSource(sourceSessionId);
  }

  /** Removed rows need terminal cancellation without retaining an unbounded closed-id seal. */
  removeSource(sourceSessionId: string): number {
    const invalidated = this.invalidateSource(sourceSessionId);
    this.cutoverCoordinator.restoreSource(sourceSessionId);
    return invalidated;
  }

  /** Reversible archive aborts handoff and restores accepted input instead of discarding it. */
  abortSource(sourceSessionId: string): number {
    this.cutoverCoordinator.abortSource(sourceSessionId);
    for (const state of this.preparationLeases.values()) {
      if (state.sourceSessionId !== sourceSessionId || state.ingressCommitted) continue;
      state.revoked = true;
    }
    return this.deps.cache.invalidateSource(sourceSessionId);
  }

  /** Session-id migration aborts the preview but restores accepted input on the surviving id. */
  renameSource(fromSessionId: string, toSessionId: string): number {
    this.cutoverCoordinator.renameSource(fromSessionId, toSessionId);
    for (const state of this.preparationLeases.values()) {
      if (
        (state.sourceSessionId !== fromSessionId && state.sourceSessionId !== toSessionId) ||
        state.ingressCommitted
      ) {
        continue;
      }
      if (state.sourceSessionId === fromSessionId) state.sourceSessionId = toSessionId;
      state.revoked = true;
    }
    return (
      this.deps.cache.invalidateSource(fromSessionId) +
      this.deps.cache.invalidateSource(toSessionId)
    );
  }

  clear(): void {
    this.deps.cache.clear();
  }

  private releasePreparationLease(preparationId: string): void {
    const state = this.preparationLeases.get(preparationId);
    if (!state) return;
    this.preparationLeases.delete(preparationId);
    state.lease.release();
  }

  private assertFresh(input: {
    sourceSessionId: string;
    prepared: CachedContinuationPreparation['prepared'];
    lowerBudgetRetry: CachedContinuationPreparation['lowerBudgetRetry'];
    snapshot: FrozenUiPreparation;
  }): void {
    const source = requireUiSourceReady(
      this.deps.getSession(input.sourceSessionId),
      input.sourceSessionId,
    );
    const sourceCheck = this.deps.sourcePreconditionCheck({
      sourceSessionId: input.sourceSessionId,
      expected: {
        eventRevision: input.prepared.source.eventRevision,
        rebuildAfterRevision: input.prepared.source.rebuildAfterRevision,
        maxEventId: input.prepared.source.maxEventId,
        runtimeFingerprint: input.snapshot.sourceRuntimeFingerprint,
      },
    });
    if (!sourceCheck.ok) {
      if (sourceCheck.reason === 'runtime-changed') {
        throw new Error('源会话运行时已变化。');
      }
      throw new Error('源会话捕获边界已发生不兼容变化。');
    }
    if (this.deps.currentSettingsFingerprint() !== input.snapshot.settingsFingerprint) {
      throw new Error('续接检查点生成器或原始历史预算已变化。');
    }
    const currentTarget = this.deps.revalidateTarget(
      {
        source,
        selection: input.snapshot.targetSelection,
        sourceMaxEventId: input.prepared.source.maxEventId,
      },
      input.snapshot.targetContextCapacity,
    );
    if (
      currentTarget.spec.runtimeFingerprint !== input.snapshot.targetRuntimeFingerprint ||
      continuationFingerprint(currentTarget.createOptions) !==
        input.snapshot.createOptionsFingerprint
    ) {
      throw new Error('目标会话运行时已变化。');
    }
    if (
      continuationFingerprint({
        primary: input.prepared,
        lowerBudgetRetry: input.lowerBudgetRetry,
      }) !== input.snapshot.preparedIntegrityFingerprint ||
      !input.prepared.preparationHash ||
      (input.lowerBudgetRetry !== null && !input.lowerBudgetRetry.preparationHash)
    ) {
      throw new Error('准备内容完整性校验失败。');
    }
  }
}
