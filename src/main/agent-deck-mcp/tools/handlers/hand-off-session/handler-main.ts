import { statSync } from 'node:fs';

import { isAgentId } from '@main/adapters/options-builder';
import { SessionModelOptionsError } from '@main/adapters/session-model-options';
import { getDb } from '@main/store/db';
import { eventRepo } from '@main/store/event-repo';
import { sessionRepo } from '@main/store/session-repo';
import { prepareHandOffContinuation } from '@main/session/continuation-context/handoff';
import { continuationFingerprint } from '@main/session/continuation-context/resolver';
import {
  ContinuationSourceSpoolStore,
  continuationSessionRuntimeFingerprint,
} from '@main/session/continuation-context/source-spool';
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import { executePreparedHandOff, HandOffExecutionError } from '@main/session/hand-off/executor';
import { snapshotHandOffQueuedMessages } from '@main/session/hand-off/queued-message-snapshot';
import { checkHandOffSourcePrecondition, type HandOffSourceCutoverResult } from '@main/session/hand-off/source-precondition';
import { HandOffTargetOptionsError, resolveHandOffTarget } from '@main/session/hand-off/target-resolver';
import { notifySessionHandOffCommitted } from '@main/session/hand-off/ownership';
import { sessionManager } from '@main/session/manager';
import log from '@main/utils/logger';
import type { SessionAdapterId } from '@shared/types';

import { err, ok, withMcpGuard, type HandlerContext } from '../../helpers';
import type { HandOffSessionArgs, HandOffSessionResult } from '../../schemas';
import type { HandOffSessionHandlerDeps } from './_deps';
import {
  transferHandOffResources,
  type HandOffResourceTransferResult,
} from './resource-transfer-coordinator';
import { sourceChangeError } from './source-change-copy';
import { finalizeMcpHandOffSource } from './source-finalization';
import { validateHandOffTargetAdapter } from './target-adapter-validation';

const logger = log.scope('mcp-handoff-main');
function resourceTransferFailed(result: HandOffResourceTransferResult): boolean {
  return (
    result.tasks.status === 'failed' ||
    result.teams.status === 'failed' ||
    result.worktreeMarker.status === 'failed'
  );
}
function cleanupSpool(spoolId: string): void {
  new ContinuationSourceSpoolStore(getDb()).cleanup(spoolId);
}

function spoolMetadata(spoolId: string) {
  return new ContinuationSourceSpoolStore(getDb()).metadata(spoolId);
}

function safelyCheckSourcePrecondition(
  check: NonNullable<HandOffSessionHandlerDeps['sourcePreconditionCheck']>,
  input: Parameters<NonNullable<HandOffSessionHandlerDeps['sourcePreconditionCheck']>>[0],
): HandOffSourceCutoverResult {
  try {
    return check(input);
  } catch {
    return { ok: false, reason: 'check-failed', currentEventRevision: null };
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const handOffSessionHandler = withMcpGuard(
  'hand_off_session',
  async (
    args: HandOffSessionArgs,
    ctx: HandlerContext,
    handlerDeps?: HandOffSessionHandlerDeps,
  ) => {
    const callerSessionId = ctx.caller.callerSessionId;
    const callerRow = sessionRepo.get(callerSessionId);
    if (!callerRow) {
      logger.warn(`[mcp hand_off_session] caller session not found: ${callerSessionId}`);
      return err(
        `caller session not found: ${callerSessionId}`,
        'hand_off_session needs a real caller session so its tasks, teams, and worktree marker can transfer to the successor.',
      );
    }
    if (callerRow.lifecycle === 'closed' || callerRow.archivedAt !== null) {
      return err(
        `caller session is not open: ${callerSessionId}`,
        'Only an open, unarchived source session can hand off its continuation context and owned resources.',
      );
    }

    let targetAdapter: SessionAdapterId;
    if (args.adapter !== undefined) {
      targetAdapter = args.adapter;
    } else if (isAgentId(callerRow.agentId)) {
      targetAdapter = callerRow.agentId;
    } else {
      logger.warn(
        `[mcp hand_off_session] caller has unsupported legacy adapter: caller=${callerSessionId} adapter=${callerRow.agentId}`,
      );
      return err(
        `caller session has unsupported adapter: ${callerRow.agentId}`,
        'Pass adapter explicitly as claude-code, deepseek-claude-code, codex-cli, or grok-build.',
      );
    }

    const finalCwd = args.cwd ?? callerRow.cwd;
    const cwdIsDirectory = handlerDeps?.cwdIsDirectory ?? isExistingDirectory;
    if (!cwdIsDirectory(finalCwd)) {
      logger.warn(
        `[mcp hand_off_session] cwd is not a directory before prepare: caller=${callerSessionId} cwd=${finalCwd}`,
      );
      return err(
        `handoff cwd is not an existing directory: ${finalCwd}`,
        'Pass cwd with an existing absolute directory, or repair the caller session cwd before handing off.',
      );
    }

    const targetValidation = (
      handlerDeps?.validateTargetAdapter ?? validateHandOffTargetAdapter
    )(targetAdapter);
    if (targetValidation) return err(targetValidation.error, targetValidation.hint);

    const frozenSourceRuntimeFingerprint = (
      handlerDeps?.sourceRuntimeFingerprint ??
      ((sessionId: string) => continuationSessionRuntimeFingerprint(getDb(), sessionId))
    )(callerSessionId);
    if (!frozenSourceRuntimeFingerprint) {
      return err(
        'failed to freeze handoff source runtime',
        'No continuation generation or successor creation occurred. Check that the source session still exists, then retry.',
      );
    }

    const targetRequest = {
      adapter: targetAdapter,
      cwd: finalCwd,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.thinking !== undefined ? { thinking: args.thinking } : {}),
      ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
      ...(args.sessionMode !== undefined ? { sessionMode: args.sessionMode } : {}),
      ...(args.codexSandbox !== undefined ? { codexSandbox: args.codexSandbox } : {}),
      ...(args.claudeCodeSandbox !== undefined
        ? { claudeCodeSandbox: args.claudeCodeSandbox }
        : {}),
      ...(args.extraAllowWrite !== undefined ? { extraAllowWrite: args.extraAllowWrite } : {}),
    };
    let target: ReturnType<typeof resolveHandOffTarget>;
    try {
      const sourceMaxEventId = (
        handlerDeps?.sourceMaxEventId ?? ((sessionId: string) => eventRepo.maxEventId(sessionId))
      )(callerSessionId);
      target = (handlerDeps?.resolveTarget ?? resolveHandOffTarget)({
        source: callerRow,
        request: targetRequest,
        sourceMaxEventId,
      });
    } catch (error) {
      logger.warn(
        `[mcp hand_off_session] target resolution failed caller=${callerSessionId} adapter=${targetAdapter}:`,
        error,
      );
      if (error instanceof SessionModelOptionsError) {
        return err(
          `handoff target ${error.field} is invalid: ${error.message}`,
          'Correct the adapter-specific model or thinking value. No continuation generation or successor creation occurred.',
        );
      }
      if (error instanceof HandOffTargetOptionsError) {
        return err(
          `handoff target ${String(error.field)} is incompatible: ${error.message}`,
          'Remove the incompatible runtime control or choose the adapter that implements it. No continuation generation or successor creation occurred.',
        );
      }
      return err(
        'failed to resolve handoff target',
        'No continuation generation or successor creation occurred. Check the source event store and target runtime settings, then retry.',
      );
    }

    const cutoverLease = (
      handlerDeps?.cutoverCoordinator ?? handOffCutoverCoordinator
    ).tryAcquire(callerSessionId);
    if (!cutoverLease) {
      return err(
        `handoff already in progress for source session: ${callerSessionId}`,
        'Wait for the current handoff attempt to finish. No continuation generation or successor creation occurred for this request.',
      );
    }

    try {
      let queuedMessages: ReturnType<typeof snapshotHandOffQueuedMessages>;
      try {
        queuedMessages = (
          handlerDeps?.snapshotQueuedMessages ?? snapshotHandOffQueuedMessages
        )(callerRow);
      } catch (error) {
        logger.warn(`[mcp hand_off_session] failed to snapshot queued source input:`, error);
        return err(
          'failed to freeze queued source input',
          'The source remains active and no successor was created. Retry after checking the source adapter runtime.',
        );
      }
      let continuation: Awaited<ReturnType<typeof prepareHandOffContinuation>>;
      try {
        continuation = await (
          handlerDeps?.prepareContinuation ?? prepareHandOffContinuation
        )({
          sourceSessionId: callerSessionId,
          continuationInstruction: args.prompt,
          target: target.spec,
        });
      } catch (error) {
        logger.warn(
          `[mcp hand_off_session] continuation preparation failed caller=${callerSessionId}:`,
          error,
        );
        return err(
          'failed to prepare continuation context',
          'The source session remains active and no successor was created. Check the checkpoint generator/application logs, then retry the same continuation instruction.',
        );
      }

      const { prepared } = continuation;
      let preparedSpoolMetadata: ReturnType<typeof spoolMetadata>;
      try {
        preparedSpoolMetadata = (handlerDeps?.spoolMetadata ?? spoolMetadata)(prepared.spoolId);
        if (
          preparedSpoolMetadata.captureRevision !== prepared.source.eventRevision ||
          preparedSpoolMetadata.rebuildAfterRevision !== prepared.source.rebuildAfterRevision ||
          preparedSpoolMetadata.runtimeFingerprint !== frozenSourceRuntimeFingerprint ||
          target.createOptions.handOff?.sourceMaxEventId !== prepared.source.maxEventId
        ) {
          throw new Error('prepared source boundary does not match its frozen target/runtime');
        }
      } catch (error) {
        logger.warn(
          `[mcp hand_off_session] failed to freeze prepared source boundary caller=${callerSessionId}:`,
          error,
        );
        try {
          (handlerDeps?.cleanupSpool ?? cleanupSpool)(prepared.spoolId);
        } catch (cleanupError) {
          logger.warn(
            `[mcp hand_off_session] failed to clean invalid continuation spool caller=${callerSessionId}:`,
            cleanupError,
          );
        }
        return err(
          'failed to freeze handoff source boundary',
          'No successor was created and no resources moved. Check the continuation spool and retry.',
        );
      }
      const sourceForExecution = sessionRepo.get(callerSessionId);
      if (
        !sourceForExecution ||
        sourceForExecution.lifecycle === 'closed' ||
        sourceForExecution.archivedAt !== null
      ) {
        try {
          (handlerDeps?.cleanupSpool ?? cleanupSpool)(prepared.spoolId);
        } catch (error) {
          logger.warn(
            `[mcp hand_off_session] failed to clean stale continuation spool caller=${callerSessionId}:`,
            error,
          );
        }
        return err(
          'source session changed or closed while preparing continuation context',
          'No successor was created and no resources moved. Reopen the source if appropriate, then prepare a new handoff.',
        );
      }
      try {
        const refreshedTarget = (handlerDeps?.resolveTarget ?? resolveHandOffTarget)({
          source: sourceForExecution,
          request: targetRequest,
          sourceMaxEventId: prepared.source.maxEventId,
        });
        if (
          continuationFingerprint(refreshedTarget.spec) !== continuationFingerprint(target.spec) ||
          continuationFingerprint(refreshedTarget.createOptions) !==
          continuationFingerprint(target.createOptions)
        ) {
          throw new Error('target inherited stale source/runtime options');
        }
      } catch (error) {
        logger.warn(`[mcp hand_off_session] frozen target drifted caller=${callerSessionId}:`, error);
        try {
          (handlerDeps?.cleanupSpool ?? cleanupSpool)(prepared.spoolId);
        } catch (cleanupError) {
          logger.warn('[mcp hand_off_session] stale-target spool cleanup failed:', cleanupError);
        }
        return err(
          'handoff target changed while preparing continuation context',
          'No successor was created and no resources moved. Prepare a fresh handoff from the current source runtime.',
        );
      }
      const sourcePrecondition = {
        eventRevision: prepared.source.eventRevision,
        rebuildAfterRevision: prepared.source.rebuildAfterRevision,
        maxEventId: prepared.source.maxEventId,
        runtimeFingerprint: frozenSourceRuntimeFingerprint,
      };
      const checkSourcePrecondition =
        handlerDeps?.sourcePreconditionCheck ?? checkHandOffSourcePrecondition;
      const preparedSourceCheck = safelyCheckSourcePrecondition(checkSourcePrecondition, {
        sourceSessionId: callerSessionId,
        expected: sourcePrecondition,
      });
      if (!preparedSourceCheck.ok) {
        try {
          (handlerDeps?.cleanupSpool ?? cleanupSpool)(prepared.spoolId);
        } catch (error) {
          logger.warn(
            `[mcp hand_off_session] failed to clean stale continuation spool caller=${callerSessionId}:`,
            error,
          );
        }
        const copy = sourceChangeError(preparedSourceCheck.reason);
        return err(copy.error, copy.hint);
      }
      if (!cutoverLease.canCommit()) {
        try {
          (handlerDeps?.cleanupSpool ?? cleanupSpool)(prepared.spoolId);
        } catch (error) {
          logger.warn(
            `[mcp hand_off_session] failed to clean revoked continuation spool caller=${callerSessionId}:`,
            error,
          );
        }
        return err(
          'source session closed or changed while preparing continuation context',
          'No successor was created and no resources moved. Reopen the source if appropriate, then prepare a new handoff.',
        );
      }
      logger.info(
        `[mcp hand_off_session] prepared caller=${callerSessionId} adapter=${targetAdapter} cwd=${finalCwd} quality=${prepared.quality} sourceRevision=${prepared.source.eventRevision} checkpointId=${prepared.checkpoint.id ?? 'none'} promptTokens=${prepared.metrics.estimatedPromptTokens}`,
      );

      let response: ReturnType<typeof ok>;
      try {
        const execution = await executePreparedHandOff({
          source: sourceForExecution,
          queuedMessages,
          sourcePrecondition,
          sourcePreconditionCheck: checkSourcePrecondition,
          target: target.createOptions,
          turn: continuation.turn,
          ...(handlerDeps?.createSuccessor
            ? { createSuccessor: handlerDeps.createSuccessor }
            : {}),
          ...(handlerDeps?.deliverLateMessages
            ? { deliverLateMessages: handlerDeps.deliverLateMessages }
            : {}),
          transferResources: handlerDeps?.transferResources ?? transferHandOffResources,
          resourceTransferFailed,
          sourceOwnershipCheck: () => cutoverLease.canCommit(),
          commitIngress: (successorSessionId) => {
            if (!cutoverLease.commit(successorSessionId)) {
              // Durable resources and alias are already committed synchronously. A lifecycle
              // listener may have sealed the source during post-commit notifications; ownership
              // still belongs to the successor and must be published before finalization.
              logger.warn(
                `[mcp hand_off_session] ingress lease was already sealed after durable commit source=${sourceForExecution.id} successor=${successorSessionId}`,
              );
            }
            notifySessionHandOffCommitted(sourceForExecution.id, successorSessionId);
          },
          closeSuccessor:
            handlerDeps?.closeSuccessor ??
            (async (sessionId: string) => {
              await sessionManager.close(sessionId);
            }),
          finalizeSource:
            handlerDeps?.finalizeSource ??
            (({ source }) => {
              finalizeMcpHandOffSource(source);
            }),
        });

        const callerClosed: HandOffSessionResult['callerClosed'] =
          execution.sourceFinalization.ok ? 'ok' : 'failed';
        const lifecycleWarnings: HandOffSessionResult['warnings'] = [];
        if (execution.sourceCutover.compatibleEventRows > 0) {
          lifecycleWarnings.push('source-advanced-after-capture');
        }
        if (!execution.sourceFinalization.ok) {
          lifecycleWarnings.push('source-finalization-failed');
          logger.warn(
            `[mcp hand_off_session] source finalization failed after transfer caller=${callerSessionId} successor=${execution.successorSessionId}: ${execution.sourceFinalization.error}`,
          );
        }

        logger.info(
          `[mcp hand_off_session] complete caller=${callerSessionId} successor=${execution.successorSessionId} callerClosed=${callerClosed} tasks=${execution.resourceTransfer.tasks.count} teams=${execution.resourceTransfer.teams.transferred.length} worktreeMarker=${execution.resourceTransfer.worktreeMarker.status}`,
        );
        response = ok({
          sessionId: execution.successorSessionId,
          adapter: targetAdapter,
          cwd: finalCwd,
          continuationContext: {
            version: prepared.version,
            quality: prepared.quality,
            sourceEventRevision: prepared.source.eventRevision,
            cutoverEventRevision: execution.sourceCutover.currentEventRevision,
            rebuildAfterRevision: prepared.source.rebuildAfterRevision,
            checkpoint: {
              id: prepared.checkpoint.id,
              formatVersion: prepared.checkpoint.formatVersion,
              throughRevision: prepared.checkpoint.throughRevision,
              refreshed: prepared.checkpoint.refreshed,
            },
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
            lateMessagesDelivered:
              execution.sourceCutover.lateMessages.length + execution.queuedMessagesDelivered,
            truncatedBoundaryMessages: prepared.metrics.truncatedBoundaryMessages,
            foldCalls: prepared.metrics.foldCalls,
            repairCalls: prepared.metrics.repairCalls,
            warningCodes: prepared.warnings.map((warning) => warning.code),
          },
          callerClosed,
          warnings: lifecycleWarnings,
          resourceTransfer: execution.resourceTransfer,
        } satisfies HandOffSessionResult);
      } catch (error) {
        if (error instanceof HandOffExecutionError) {
          if (error.stage === 'cutover') {
            logger.warn(
              `[mcp hand_off_session] source drifted during successor creation caller=${callerSessionId} successor=${error.successorSessionId} cleanup=${error.successorCleanup}`,
            );
            const deliveryFailed = error.cutoverReason === 'late-message-delivery-failed';
            response = err(
              deliveryFailed
                ? 'failed to deliver late source messages to the handoff successor'
                : 'source session changed while creating the handoff successor',
              `No resources moved. Orphan successor ${error.successorSessionId} cleanup: ${error.successorCleanup}. ${deliveryFailed ? 'The source remains active; retry after the target adapter can accept the queued messages.' : 'Prepare a fresh continuation context and retry.'}`,
              {
                successorSessionId: error.successorSessionId,
                successorClosed: error.successorCleanup,
                resourceTransfer: null,
              },
            );
          } else {
            logger.warn(
              `[mcp hand_off_session] mandatory transfer failed caller=${callerSessionId} successor=${error.successorSessionId} cleanup=${error.successorCleanup}: ${JSON.stringify(error.resourceTransfer)}`,
            );
            response = err(
              'handoff resource transfer failed; source session remains active',
              `Successor ${error.successorSessionId} was created, but mandatory resource transfer failed. Orphan cleanup: ${error.successorCleanup}.`,
              {
                successorSessionId: error.successorSessionId,
                successorClosed: error.successorCleanup,
                resourceTransfer: error.resourceTransfer,
                transferFailure: error.transferError ? 'exception' : 'reported',
              },
            );
          }
        } else {
          logger.warn(
            `[mcp hand_off_session] successor creation failed caller=${callerSessionId}:`,
            error,
          );
          response = err(
            'failed to create handoff successor',
            'The source session and its resources remain active. Check the target provider/application logs, then retry hand_off_session.',
          );
        }
      } finally {
        try {
          (handlerDeps?.cleanupSpool ?? cleanupSpool)(prepared.spoolId);
        } catch (error) {
          logger.warn(
            `[mcp hand_off_session] failed to clean continuation spool caller=${callerSessionId}:`,
            error,
          );
        }
      }

      return response;
    } finally {
      try {
        const currentSourceId = cutoverLease.sourceSessionId;
        const currentSource = sessionRepo.get(currentSourceId);
        if (
          cutoverLease.canCommit() &&
          (!currentSource || currentSource.lifecycle === 'closed')
        ) {
          cutoverLease.revoke();
        }
      } catch (error) {
        logger.warn(
          `[mcp hand_off_session] final source probe failed caller=${cutoverLease.sourceSessionId}:`,
          error,
        );
        if (cutoverLease.canCommit()) cutoverLease.revoke();
      } finally {
        cutoverLease.release();
      }
    }
  },
);
