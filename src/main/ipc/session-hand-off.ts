import { IpcInvoke } from '@shared/ipc-channels';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import {
  isAdapterSessionMode,
  type SessionHandOffPrepareRequest,
  type SessionHandOffTarget,
  type SessionRecord,
} from '@shared/types';
import type { CreateSessionOptions, QueuedAgentMessage } from '@main/adapters/types';
import { adapterRegistry } from '@main/adapters/registry';
import { isAgentId } from '@main/adapters/options-builder';
import { SessionModelOptionsError } from '@main/adapters/session-model-options';
import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import {
  prepareHandOffContinuation,
  resolveContinuationPreparationSettingsFingerprint,
} from '@main/session/continuation-context/handoff';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import { ContinuationPreparationCache } from '@main/session/continuation-context/preparation-cache';
import {
  ContinuationSourceSpoolStore,
  continuationSessionRuntimeFingerprint,
} from '@main/session/continuation-context/source-spool';
import {
  executePreparedHandOff,
  HandOffExecutionError,
  type HandOffSourceCutoverPrecondition,
} from '@main/session/hand-off/executor';
import { checkHandOffSourcePrecondition } from '@main/session/hand-off/source-precondition';
import { snapshotHandOffQueuedMessages } from '@main/session/hand-off/queued-message-snapshot';
import { resolveHandOffTarget } from '@main/session/hand-off/target-resolver';
import { notifySessionHandOffCommitted } from '@main/session/hand-off/ownership';
import {
  UiHandOffCoordinator,
  type UiHandOffExecutionResult,
} from '@main/session/hand-off/ui-coordinator';
import { eventRepo } from '@main/store/event-repo';
import { eventRevisionRepo } from '@main/store/event-revision-repo';
import { getDb } from '@main/store/db';
import { sessionRepo } from '@main/store/session-repo';
import { transferHandOffResources } from '@main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator';
import type { EventMap } from '@main/event-bus';
import {
  archiveSourceSessionWithEmit,
  finalizeUiHandOffSource,
} from './session-hand-off-finalize';
import { serializeSessionHandOffCommit } from './session-hand-off-response';
import { IpcInputError, on, parseStringId } from './_helpers';
import log from '@main/utils/logger';

const logger = log.scope('ipc-session-hand-off');

let spoolStore: ContinuationSourceSpoolStore | null = null;

function spool(): ContinuationSourceSpoolStore {
  spoolStore ??= new ContinuationSourceSpoolStore(getDb());
  return spoolStore;
}

const preparationCache = new ContinuationPreparationCache({
  onEvict: (entry) => {
    try {
      spool().cleanup(entry.prepared.spoolId);
    } catch {
      // Eviction is best-effort during shutdown/DB replacement; TEMP rows disappear with the DB.
    }
  },
});

function transferFailed(result: ReturnType<typeof transferHandOffResources>): boolean {
  return (
    result.tasks.status === 'failed' ||
    result.teams.status === 'failed' ||
    result.worktreeMarker.status === 'failed'
  );
}

async function executeUiHandOff(input: {
  source: SessionRecord;
  queuedMessages: QueuedAgentMessage[];
  sourcePrecondition: HandOffSourceCutoverPrecondition;
  target: CreateSessionOptions;
  turn: TrustedContinuationInitialTurn;
  commitIngress: (successorSessionId: string) => void;
  sourceOwnershipCheck: () => boolean;
}): Promise<UiHandOffExecutionResult> {
  const result = await executePreparedHandOff({
    source: input.source,
    queuedMessages: input.queuedMessages,
    sourcePrecondition: input.sourcePrecondition,
    sourcePreconditionCheck: checkHandOffSourcePrecondition,
    target: input.target,
    turn: input.turn,
    transferResources: transferHandOffResources,
    resourceTransferFailed: transferFailed,
    commitIngress: (successorSessionId) => {
      input.commitIngress(successorSessionId);
      notifySessionHandOffCommitted(input.source.id, successorSessionId);
    },
    sourceOwnershipCheck: input.sourceOwnershipCheck,
    closeSuccessor: (sessionId) => sessionManager.close(sessionId),
    finalizeSource: async ({ source }) => {
      // Seal synchronously in the same call stack as the final source scan/resource transfer. The
      // provider close below may await, but no additional UI input should land on the old owner.
      await finalizeUiHandOffSource(source.id, {
        markClosed: (sessionId) => sessionManager.markClosed(sessionId),
        close: (sessionId) => sessionManager.close(sessionId),
        archive: (sessionId) =>
          archiveSourceSessionWithEmit(sessionId, {
            archive: (sessionId) => sessionManager.archive(sessionId),
            getSession: (sessionId) => sessionRepo.get(sessionId),
            emitArchiveFailed: (payload) =>
              eventBus.emit(
                'caller-archive-failed',
                payload satisfies EventMap['caller-archive-failed'][0],
              ),
          }),
      });
      return true;
    },
  });
  if (!result.sourceFinalization.ok) {
    logger.warn(
      `[ui hand-off] successor ${result.successorSessionId} created but source finalization failed: ${result.sourceFinalization.error}`,
    );
  } else {
    eventBus.emit('session-focus-request', result.successorSessionId);
  }
  return result;
}

const coordinator = new UiHandOffCoordinator({
  cache: preparationCache,
  getSession: (sessionId) => sessionRepo.get(sessionId),
  eventState: (sessionId) => eventRevisionRepo.state(sessionId),
  maxEventId: (sessionId) => eventRepo.maxEventId(sessionId),
  sourceRuntimeFingerprint: (sessionId) =>
    continuationSessionRuntimeFingerprint(getDb(), sessionId),
  snapshotQueuedMessages: snapshotHandOffQueuedMessages,
  sourcePreconditionCheck: checkHandOffSourcePrecondition,
  resolveTarget: ({ source, selection, sourceMaxEventId }) => {
    const adapter = adapterRegistry.get(selection.adapter);
    if (!adapter?.createSession || !adapter.capabilities.canCreateSession) {
      throw new Error(`目标 adapter 无法创建会话：${selection.adapter}`);
    }
    if (!adapter.createTrustedContinuationSession) {
      throw new Error(`目标 adapter 不支持受信任的会话续接上下文：${selection.adapter}`);
    }
    return resolveHandOffTarget({
      source,
      request: { ...selection, cwd: source.cwd },
      sourceMaxEventId,
    });
  },
  prepare: prepareHandOffContinuation,
  currentSettingsFingerprint: resolveContinuationPreparationSettingsFingerprint,
  spoolMetadata: (spoolId) => spool().metadata(spoolId),
  cleanupSpool: (spoolId) => spool().cleanup(spoolId),
  execute: executeUiHandOff,
  isTransferExecutionError: (error): error is HandOffExecutionError<unknown> =>
    error instanceof HandOffExecutionError,
});

function parseTarget(value: unknown): SessionHandOffTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IpcInputError('request.target', 'must be object');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.adapter !== 'string' || !isAgentId(raw.adapter)) {
    throw new IpcInputError('request.target.adapter', 'unknown adapter');
  }
  if (raw.model !== null && raw.model !== undefined && typeof raw.model !== 'string') {
    throw new IpcInputError('request.target.model', 'must be a string or null');
  }
  if (raw.thinking !== null && raw.thinking !== undefined && typeof raw.thinking !== 'string') {
    throw new IpcInputError('request.target.thinking', 'must be a string or null');
  }
  if (
    raw.sessionMode !== null &&
    raw.sessionMode !== undefined &&
    !isAdapterSessionMode(raw.sessionMode)
  ) {
    throw new IpcInputError(
      'request.target.sessionMode',
      'must be default, plan, ask, or null',
    );
  }
  return {
    adapter: raw.adapter,
    model: typeof raw.model === 'string' ? raw.model : null,
    thinking: typeof raw.thinking === 'string' ? raw.thinking : null,
    sessionMode: isAdapterSessionMode(raw.sessionMode) ? raw.sessionMode : null,
  };
}

function parsePrepareRequest(value: unknown): SessionHandOffPrepareRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IpcInputError('request', 'must be object');
  }
  const raw = value as Record<string, unknown>;
  const sourceSessionId = parseStringId('request.sourceSessionId', raw.sourceSessionId);
  if (typeof raw.continuationInstruction !== 'string') {
    throw new IpcInputError('request.continuationInstruction', 'must be a string');
  }
  if (!raw.continuationInstruction.trim()) {
    throw new IpcInputError('request.continuationInstruction', 'must not be empty');
  }
  if (raw.continuationInstruction.length > MAX_USER_MESSAGE_LENGTH) {
    throw new IpcInputError(
      'request.continuationInstruction',
      `length > ${MAX_USER_MESSAGE_LENGTH}`,
    );
  }
  return {
    sourceSessionId,
    continuationInstruction: raw.continuationInstruction,
    target: parseTarget(raw.target),
  };
}

function ownerFor(event: Electron.IpcMainInvokeEvent): string {
  return `ui:${event.sender.id}`;
}

let lifecycleInvalidationRegistered = false;

export function registerSessionHandOffIpc(): void {
  if (!lifecycleInvalidationRegistered) {
    lifecycleInvalidationRegistered = true;
    eventBus.on('session-removed', (sessionId) => coordinator.removeSource(sessionId));
    eventBus.on('session-renamed', ({ from, to }) => coordinator.renameSource(from, to));
    eventBus.on('session-upserted', (session) => {
      if (session.lifecycle === 'closed') {
        coordinator.invalidateSource(session.id);
      } else if (session.archivedAt !== null) {
        coordinator.abortSource(session.id);
      }
    });
  }

  on(IpcInvoke.SessionHandOffPrepare, async (event, rawRequest) => {
    const request = parsePrepareRequest(rawRequest);
    try {
      return await coordinator.prepare({
        ownerSessionId: ownerFor(event),
        sourceSessionId: request.sourceSessionId,
        continuationInstruction: request.continuationInstruction,
        target: request.target,
      });
    } catch (error) {
      if (error instanceof SessionModelOptionsError) {
        throw new IpcInputError(`request.target.${error.field}`, error.message);
      }
      throw error;
    }
  });

  on(IpcInvoke.SessionHandOffCommit, (event, rawPreparationId) => {
    const preparationId = parseStringId('preparationId', rawPreparationId);
    return serializeSessionHandOffCommit(() =>
      coordinator.commit(ownerFor(event), preparationId),
    );
  });

  on(IpcInvoke.SessionHandOffCancel, (event, rawPreparationId) =>
    coordinator.cancel(
      ownerFor(event),
      parseStringId('preparationId', rawPreparationId),
    ),
  );
}

/** Called after a continuation-generator/budget setting is successfully persisted. */
export function invalidateSessionHandOffPreparationsForSettingsChange(): void {
  coordinator.clear();
}

/** Synchronous TEMP/cache cleanup before closeDb(). */
export function cleanupSessionHandOffPreparations(): void {
  coordinator.clear();
  try {
    spoolStore?.cleanupAll();
  } finally {
    spoolStore = null;
  }
}
