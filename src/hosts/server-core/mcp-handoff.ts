import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import type { SessionHandOffPreviewResult } from '@contracts/index';
import type { HandOffSessionResult } from '@main/agent-deck-mcp/tools/schemas';
import type { AgentAdapter, CreateSessionOptions, QueuedAgentMessage } from '@main/adapters/types';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import {
  checkHandOffSourcePrecondition,
  type HandOffLateMessage,
} from '@main/session/hand-off/source-precondition';
import {
  selectTrustedContinuationCandidate,
  type SelectedTrustedContinuationCandidate,
} from '@main/session/hand-off/trusted-continuation-gate';
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';

import type { ServerCoreDesktopBrokerPort } from './desktop-broker-port';
import {
  prepareServerCoreHandOffContinuation,
  type PreparedServerCoreHandOffContinuation,
} from './mcp-handoff-continuation';
import { ServerCoreHandOffPreviewConflictError } from './mcp-handoff-errors';
import type {
  ServerCoreHandOffSessionArgs,
  ServerCoreMcpHandOffPort,
} from './mcp-handoff-port';
import {
  serverCoreHandOffBindingDigest,
  serverCoreHandOffPreviewResult,
} from './mcp-handoff-preview';
import { resolveServerCoreHandOffTarget } from './mcp-handoff-target';
import { transferServerCoreHandOffResources } from './mcp-handoff-transfer';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import type { ServerCoreMcpSessionPort } from './mcp-session-port';
import type { ServerCoreWorktreeRuntimePort } from './mcp-worktree-port';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import {
  serverCoreWorktreeReferenceFence,
  type ServerCoreWorktreeReferenceLease,
} from './worktree-reference-fence';

const MAX_LATE_MESSAGE_PASSES = 8;

interface HandOffSessionManager {
  markClosed(sessionId: string): void;
  discardAfterProviderRollback(sessionId: string): void;
  notifyTeamMembershipChanged(sessionId: string): void;
}

interface HandOffSessionRepository {
  get(sessionId: string): SessionRecord | null;
}

export interface ServerCoreMcpHandOffOptions {
  readonly workspaceRoot: string;
  readonly sessions: HandOffSessionRepository;
  readonly sessionManager: HandOffSessionManager;
  readonly registry: { get(adapterId: string): AgentAdapter | undefined };
  readonly capabilities: ServerCoreSessionCreateCapabilities;
  readonly collaboration: ServerCoreMcpSessionPort;
  readonly worktrees: ServerCoreWorktreeRuntimePort;
  readonly desktopBroker: ServerCoreDesktopBrokerPort;
  readonly presentations: ServerCoreMcpPresentationPort;
  readonly metadata: ServerCoreRuntimeMetadataStore;
  readonly warn?: (message: string) => void;
}

function cleanTarget(target: CreateSessionOptions): CreateSessionOptions {
  const clean = { ...target } as CreateSessionOptions & Record<string, unknown>;
  delete clean.prompt;
  delete clean.resume;
  return clean;
}

function liveSource(sessions: HandOffSessionRepository, sessionId: string): SessionRecord {
  const source = sessions.get(sessionId);
  if (!source || source.lifecycle === 'closed' || source.archivedAt !== null) {
    throw new Error('Only an open, unarchived caller can hand off');
  }
  return source;
}

function safeWarn(warn: ((message: string) => void) | undefined, message: string): void {
  try { warn?.(message); } catch {}
}

/** Core-owned atomic logical-session continuation for every headless provider adapter. */
export class ServerCoreMcpHandOff implements ServerCoreMcpHandOffPort {
  constructor(private readonly options: ServerCoreMcpHandOffOptions) {}

  async preview(
    callerSessionId: string,
    args: ServerCoreHandOffSessionArgs,
  ): Promise<SessionHandOffPreviewResult> {
    const source = liveSource(this.options.sessions, callerSessionId);
    const provisional = await resolveServerCoreHandOffTarget({
      args,
      source,
      workspaceRoot: this.options.workspaceRoot,
      capabilities: this.options.capabilities,
      sourceMaxEventId: null,
    });
    this.assertWorktreeTarget(source, provisional.cwd);
    const cwdLease = serverCoreWorktreeReferenceFence.acquireReference(provisional.cwd);
    let prepared: PreparedServerCoreHandOffContinuation | null = null;
    try {
      prepared = prepareServerCoreHandOffContinuation({
        sourceSessionId: source.id,
        instruction: args.prompt,
        target: provisional.spec,
        workspaceRoot: this.options.workspaceRoot,
      });
      const current = checkHandOffSourcePrecondition({
        sourceSessionId: source.id,
        expected: prepared.sourcePrecondition,
      });
      if (!current.ok) throw new ServerCoreHandOffPreviewConflictError();
      return serverCoreHandOffPreviewResult({
        sourceSessionId: source.id,
        args,
        target: provisional,
        prepared,
        revision: this.options.metadata.currentRevision(),
      });
    } finally {
      try { prepared?.cleanup(); } catch {}
      cwdLease.release();
    }
  }

  async handOff(
    callerSessionId: string,
    args: ServerCoreHandOffSessionArgs,
    expectedPreviewDigest?: string,
  ): Promise<HandOffSessionResult> {
    const source = liveSource(this.options.sessions, callerSessionId);
    const lease = handOffCutoverCoordinator.tryAcquire(source.id);
    if (!lease) throw new Error('Another handoff or terminal lifecycle change owns this session');
    let prepared: PreparedServerCoreHandOffContinuation | null = null;
    let acceptedSessionId: string | null = null;
    let cwdLease: ServerCoreWorktreeReferenceLease | null = null;
    try {
      const provisional = await resolveServerCoreHandOffTarget({
        args,
        source,
        workspaceRoot: this.options.workspaceRoot,
        capabilities: this.options.capabilities,
        sourceMaxEventId: null,
      });
      this.assertWorktreeTarget(source, provisional.cwd);
      cwdLease = serverCoreWorktreeReferenceFence.acquireReference(provisional.cwd);
      prepared = prepareServerCoreHandOffContinuation({
        sourceSessionId: source.id,
        instruction: args.prompt,
        target: provisional.spec,
        workspaceRoot: this.options.workspaceRoot,
      });
      if (
        expectedPreviewDigest &&
        serverCoreHandOffBindingDigest({
          sourceSessionId: source.id,
          args,
          target: provisional,
          prepared,
        }) !== expectedPreviewDigest
      ) throw new ServerCoreHandOffPreviewConflictError();
      if (provisional.createOptions.handOff) {
        provisional.createOptions.handOff.sourceMaxEventId =
          prepared.sourcePrecondition.maxEventId;
      }
      const sourceAdapter = this.requireSourceAdapter(source);
      const queued = sourceAdapter.snapshotQueuedMessagesForHandOff?.(source.id) ?? [];
      const selected = await this.selectCandidate(
        provisional.createOptions,
        prepared,
      );
      acceptedSessionId = selected.candidate.sessionId;
      const delivered = await this.finishCutover({
        source,
        sourceAdapter,
        successorSessionId: acceptedSessionId,
        target: provisional.createOptions,
        prepared,
        queued,
        lease,
      });
      if (!lease.canCommit()) throw new Error('Handoff source is no longer open');
      const transfer = transferServerCoreHandOffResources(
        source.id,
        acceptedSessionId,
        {
          successorCwd: provisional.cwd,
          worktrees: this.options.worktrees,
          presentations: this.options.presentations,
          notifyMembershipChanged: (sessionId) =>
            this.options.sessionManager.notifyTeamMembershipChanged(sessionId),
          appendChange: (kind, entityId, payload) =>
            this.options.metadata.appendChange(kind, entityId, payload),
          warn: this.options.warn,
        },
      );
      const committed = lease.commit(acceptedSessionId);
      acceptedSessionId = null;
      if (!committed) {
        safeWarn(
          this.options.warn,
          'Handoff ingress was sealed after its durable ownership transfer',
        );
      }
      const successorSessionId = selected.candidate.sessionId;
      const finalization = this.finalizeSource(source, sourceAdapter, successorSessionId);
      return this.result({
        source,
        successorSessionId,
        cwd: provisional.cwdRef,
        adapterId: provisional.adapterId,
        createOptions: provisional.createOptions,
        prepared,
        selected,
        cutoverRevision: delivered.cutoverRevision,
        deliveredMessages: delivered.deliveredMessages,
        transfer,
        callerClosed: finalization.ok ? 'ok' : 'failed',
      });
    } catch (error) {
      if (acceptedSessionId) {
        try {
          await this.rollbackSuccessor(acceptedSessionId);
        } catch {
          throw new Error('Handoff failed and strict successor cleanup could not be proved');
        }
      }
      throw error;
    } finally {
      try { prepared?.cleanup(); } catch {}
      cwdLease?.release();
      lease.release();
    }
  }

  private assertWorktreeTarget(source: SessionRecord, cwd: string): void {
    const transition = worktreeTransitionRepo.get(source.id);
    if (!transition || transition.phase === 'cleared') return;
    if (transition.phase !== 'active') {
      throw new Error('Worktree transition must settle before handoff');
    }
    if (cwd !== transition.worktreePath) {
      throw new Error('Handoff cwd must match the active worktree lease');
    }
  }

  private requireSourceAdapter(source: SessionRecord): AgentAdapter {
    const adapter = this.options.registry.get(source.agentId);
    if (!adapter?.retireSessionAfterCurrentTurn) {
      throw new Error('Source adapter cannot retire after the handoff result');
    }
    return adapter;
  }

  private async selectCandidate(
    target: CreateSessionOptions,
    prepared: PreparedServerCoreHandOffContinuation,
  ): Promise<SelectedTrustedContinuationCandidate> {
    const adapter = this.options.registry.get(target.agentId);
    if (!adapter?.createTrustedContinuationSession || !adapter.closeSessionForRollback) {
      throw new Error('Target adapter cannot create and strictly roll back a continuation');
    }
    return selectTrustedContinuationCandidate({
      capacityStatus: 'unknown',
      primaryTurn: prepared.turn,
      lowerBudgetRetryTurn: prepared.lowerBudgetRetry.turn,
      createCandidate: (turn) => adapter.createTrustedContinuationSession!(cleanTarget(target), turn),
      rollbackRejectedCandidate: (sessionId) => this.rollbackSuccessor(sessionId),
      closeCandidateBestEffort: (sessionId) => this.rollbackSuccessor(sessionId),
    });
  }

  private async rollbackSuccessor(sessionId: string): Promise<void> {
    const record = this.options.sessions.get(sessionId);
    if (!record) return;
    const adapter = this.options.registry.get(record.agentId);
    if (!adapter?.closeSessionForRollback) {
      throw new Error('Target adapter lost strict rollback support');
    }
    await adapter.closeSessionForRollback(sessionId);
    this.options.sessionManager.discardAfterProviderRollback(sessionId);
    mcpSessionTokenMap.release(sessionId);
    this.options.desktopBroker.releaseSession(sessionId);
    this.options.presentations.releaseSession(sessionId, 'Handoff successor rolled back');
    if (this.options.sessions.get(sessionId)) {
      throw new Error('Successor durable rollback did not complete');
    }
  }

  private async finishCutover(input: {
    source: SessionRecord;
    sourceAdapter: AgentAdapter;
    successorSessionId: string;
    target: CreateSessionOptions;
    prepared: PreparedServerCoreHandOffContinuation;
    queued: QueuedAgentMessage[];
    lease: NonNullable<ReturnType<typeof handOffCutoverCoordinator.tryAcquire>>;
  }): Promise<{ cutoverRevision: number; deliveredMessages: number }> {
    let deliveredMessages = 0;
    await this.deliverQueued(input.successorSessionId, input.target.agentId, input.queued);
    deliveredMessages += input.queued.length;
    if (!await this.options.collaboration.drainForHandOff(input.source.id)) {
      throw new Error('Cross-session message delivery did not drain before handoff');
    }
    const deliveredEventIds = new Set<number>();
    for (let pass = 0; pass <= MAX_LATE_MESSAGE_PASSES; pass += 1) {
      if (!input.lease.canCommit()) throw new Error('Handoff source is no longer open');
      const current = checkHandOffSourcePrecondition({
        sourceSessionId: input.source.id,
        expected: input.prepared.sourcePrecondition,
      });
      if (!current.ok) throw new Error(`Handoff source changed incompatibly: ${current.reason}`);
      const late = current.lateMessages.filter((message) => !deliveredEventIds.has(message.eventId));
      if (late.length === 0) {
        if (!input.lease.canCommit()) throw new Error('Handoff source is no longer open');
        return { cutoverRevision: current.currentEventRevision, deliveredMessages };
      }
      if (pass === MAX_LATE_MESSAGE_PASSES) break;
      await this.deliverLate(input.successorSessionId, input.target.agentId, late);
      for (const message of late) deliveredEventIds.add(message.eventId);
      deliveredMessages += late.length;
    }
    throw new Error('Handoff source kept changing during bounded cutover');
  }

  private async deliverQueued(
    successorSessionId: string,
    adapterId: string,
    messages: readonly QueuedAgentMessage[],
  ): Promise<void> {
    const adapter = this.options.registry.get(adapterId);
    if (messages.length > 0 && !adapter?.enqueueMessage) {
      throw new Error('Target adapter cannot preserve queued source messages');
    }
    for (const message of messages) {
      await adapter!.enqueueMessage!(
        successorSessionId,
        message.text,
        message.attachments,
        { bypassQueueLimit: true },
      );
    }
  }

  private deliverLate(
    successorSessionId: string,
    adapterId: string,
    messages: readonly HandOffLateMessage[],
  ): Promise<void> {
    return this.deliverQueued(successorSessionId, adapterId, messages.map((message) => ({
      text: message.text,
      attachments: message.attachments as UploadedAttachmentRef[],
    })));
  }

  private finalizeSource(
    source: SessionRecord,
    adapter: AgentAdapter,
    successorSessionId: string,
  ): { ok: boolean } {
    let ok = true;
    const attempt = (operation: () => void): void => {
      try { operation(); } catch { ok = false; }
    };
    attempt(() => this.options.sessionManager.markClosed(source.id));
    attempt(() => mcpSessionTokenMap.release(source.id));
    attempt(() => this.options.desktopBroker.releaseSession(source.id));
    attempt(() => this.options.presentations.releaseSession(source.id, 'Session handed off'));
    attempt(() => adapter.retireSessionAfterCurrentTurn!(source.id));
    attempt(() => this.options.metadata.appendChange(
      'session.handoff.committed',
      successorSessionId,
      { sourceSessionId: source.id, successorSessionId },
    ));
    if (!ok) {
      safeWarn(this.options.warn, 'Source handoff finalization failed after durable transfer');
    }
    return { ok };
  }

  private result(input: {
    source: SessionRecord;
    successorSessionId: string;
    cwd: string;
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
    createOptions: CreateSessionOptions;
    prepared: PreparedServerCoreHandOffContinuation;
    selected: SelectedTrustedContinuationCandidate;
    cutoverRevision: number;
    deliveredMessages: number;
    transfer: HandOffSessionResult['resourceTransfer'];
    callerClosed: 'ok' | 'failed';
  }): HandOffSessionResult {
    const prepared = input.selected.usedLowerBudgetRetry
      ? input.prepared.lowerBudgetRetry.prepared
      : input.prepared.prepared;
    const advanced = input.cutoverRevision > prepared.source.eventRevision;
    return {
      sessionId: input.successorSessionId,
      adapter: input.adapterId,
      gateway: input.createOptions.agentId === 'claude-code'
        ? input.createOptions.gateway ?? null
        : null,
      provider: input.createOptions.agentId === 'codex-cli'
        ? input.createOptions.provider ?? null
        : null,
      cwd: input.cwd,
      continuationContext: {
        version: prepared.version,
        quality: prepared.quality,
        sourceEventRevision: prepared.source.eventRevision,
        cutoverEventRevision: input.cutoverRevision,
        rebuildAfterRevision: prepared.source.rebuildAfterRevision,
        checkpoint: { ...prepared.checkpoint },
        preparationHash: prepared.preparationHash,
        tokenStats: {
          rawRetentionCeiling: prepared.metrics.rawRetentionCeilingTokens,
          targetPromptCapacity: prepared.metrics.targetPromptCapacityTokens,
          checkpointProjectionBudget: prepared.metrics.checkpointProjectionBudgetTokens,
          generatorFoldInputBudget: prepared.metrics.generatorFoldInputBudgetTokens,
          estimatedPrompt: prepared.metrics.estimatedPromptTokens,
          checkpoint: prepared.metrics.checkpointTokens,
          rawTail: prepared.metrics.rawTailTokens,
        },
        includedUserMessages: prepared.metrics.includedUserMessages,
        lateMessagesDelivered: input.deliveredMessages,
        usedLowerBudgetRetry: input.selected.usedLowerBudgetRetry,
        truncatedBoundaryMessages: prepared.metrics.truncatedBoundaryMessages,
        foldCalls: prepared.metrics.foldCalls,
        repairCalls: prepared.metrics.repairCalls,
        warningCodes: prepared.warnings.map((warning) => warning.code),
      },
      callerClosed: input.callerClosed,
      warnings: [
        ...(input.callerClosed === 'failed' ? ['source-finalization-failed' as const] : []),
        ...(advanced ? ['source-advanced-after-capture' as const] : []),
      ],
      resourceTransfer: input.transfer,
    };
  }
}
