import { randomUUID } from 'node:crypto';
import { AGENT_DECK_MCP_TOKEN_ENV } from '@main/codex-config/agent-deck-mcp-injector';
import type { ForkedSessionHandle, ForkSessionSource } from '../../../types/fork-session';
import type { CodexAppServerClient } from '../../app-server/client';
import type { CodexBridgeOptions, InternalSession } from '../types';
import type { CreateSessionOpts } from '../create-session/_deps';
import type { ThreadLoop } from '../thread-loop';
import { AGENT_ID } from '../constants';
import {
  extractAttachmentPaths,
  packCodexAppServerInput,
  packCodexInput,
} from '../input-pack';
import { persistSessionFields } from '../session-finalize';
import { selectCodexForkBoundary } from './source-boundary';
import {
  buildForkedFirstTurnInput,
  buildForkInstructionReset,
} from './instruction-reset';
import {
  resolveCodexForkTargetRuntime,
  type CodexForkTargetRuntime,
} from './target-runtime';
import {
  cleanupCodexFork,
  type CodexForkCleanupState,
  type CodexForkLifecycleOps,
} from './rollback';
import log from '@main/utils/logger';

const logger = log.scope('codex-fork');

export type CodexForkFaultPhase =
  | 'before-native-creation'
  | 'after-native-creation'
  | 'after-temp-registration'
  | 'after-canonical-rename';

export interface CreateCodexForkDeps {
  sessions: Map<string, InternalSession>;
  codexBySession: Map<string, CodexAppServerClient>;
  threadLoop: ThreadLoop;
  emit: CodexBridgeOptions['emit'];
  ensureCodex(
    sessionId: string,
    sessionToken: string,
    envOverrideExtra?: Readonly<Record<string, string>>,
  ): Promise<CodexAppServerClient>;
  lifecycle: CodexForkLifecycleOps;
  resolveTargetRuntime?: (opts: CreateSessionOpts) => CodexForkTargetRuntime;
  persistTargetFields?: typeof persistSessionFields;
  scheduleTurn?: (start: () => void) => void;
  faultInjector?: (phase: CodexForkFaultPhase) => void;
}

export async function createCodexForkedSession(
  source: ForkSessionSource,
  target: CreateSessionOpts,
  deps: CreateCodexForkDeps,
): Promise<ForkedSessionHandle> {
  if (
    target.envOverrideExtra &&
    Object.prototype.hasOwnProperty.call(target.envOverrideExtra, AGENT_DECK_MCP_TOKEN_ENV)
  ) {
    throw new Error(
      `Codex native fork does not allow envOverrideExtra to replace ${AGENT_DECK_MCP_TOKEN_ENV}; the child must use its target-owned token.`,
    );
  }
  const sourceClient = deps.codexBySession.get(source.applicationSessionId);
  if (!sourceClient) {
    throw new Error(
      'The active Codex caller has no caller-owned app-server client. Retry while the source session is live or use contextMode "fresh".',
    );
  }

  const sourceRead = await sourceClient.readThread(source.nativeSessionId);
  if (sourceRead.thread.id !== source.nativeSessionId) {
    throw new Error(
      `Codex thread/read returned ${sourceRead.thread.id} for caller thread ${source.nativeSessionId}; refusing to fork an ambiguous source.`,
    );
  }
  const boundary = selectCodexForkBoundary(sourceRead);
  const runtime = (deps.resolveTargetRuntime ?? resolveCodexForkTargetRuntime)(target);
  const tempId = randomUUID();
  const sessionToken = deps.lifecycle.allocateToken(tempId);
  const cleanupState: CodexForkCleanupState = {
    sourceApplicationId: source.applicationSessionId,
    sourceNativeId: source.nativeSessionId,
    sourceClient,
    tempId,
    targetClient: null,
    nativeChildId: null,
    tempRegistered: false,
    internal: null,
  };

  try {
    const targetClient = await deps.ensureCodex(
      tempId,
      sessionToken,
      target.envOverrideExtra,
    );
    cleanupState.targetClient = targetClient;
    if (targetClient === sourceClient) {
      throw new Error('Codex native fork requires a distinct target-owned app-server client.');
    }
    deps.faultInjector?.('before-native-creation');

    const nativeResult = boundary.lastTerminalTurnId
      ? await targetClient.forkThread(
          source.nativeSessionId,
          boundary.lastTerminalTurnId,
          runtime.threadOptions,
        )
      : await targetClient.startThreadEager(runtime.threadOptions);
    const canonicalId = nativeResult.thread.id;
    if (!canonicalId || canonicalId === source.nativeSessionId) {
      throw new Error(
        'Codex returned the source thread id instead of a distinct child; the source was left untouched.',
      );
    }
    cleanupState.nativeChildId = canonicalId;
    if (canonicalId === tempId) {
      throw new Error(
        'Codex child thread id collided with the temporary application identity; the native child was discarded.',
      );
    }
    if (
      boundary.lastTerminalTurnId &&
      nativeResult.thread.forkedFromId !== source.nativeSessionId
    ) {
      throw new Error(
        'Codex thread/fork did not report the authenticated caller as forkedFromId.',
      );
    }
    if (!boundary.lastTerminalTurnId && nativeResult.thread.forkedFromId != null) {
      throw new Error('Codex zero-prefix child unexpectedly reported native fork provenance.');
    }
    logger.info(
      boundary.lastTerminalTurnId
        ? `[codex-fork] terminal-prefix child=${canonicalId} source=${source.nativeSessionId} lastTurn=${boundary.lastTerminalTurnId}`
        : `[codex-fork] zero-prefix child=${canonicalId} source=${source.nativeSessionId}`,
    );
    deps.faultInjector?.('after-native-creation');

    await targetClient.injectThreadItems(canonicalId, [
      buildForkInstructionReset(runtime.effectiveDeveloperInstructions),
    ]);
    if (deps.sessions.has(canonicalId) || deps.codexBySession.has(canonicalId)) {
      throw new Error(`Codex child identity ${canonicalId} is already registered.`);
    }

    const delegatedInput = packCodexInput(target.prompt!, target.attachments);
    const internal: InternalSession = {
      applicationSid: tempId,
      threadId: canonicalId,
      cwd: runtime.cwd,
      thread: targetClient.adoptThread(canonicalId, runtime.threadOptions),
      pendingMessages: [
        packCodexAppServerInput(
          buildForkedFirstTurnInput(
            boundary.currentUserInputs,
            target.prompt!,
            target.attachments,
          ),
          extractAttachmentPaths(delegatedInput),
        ),
      ],
      currentTurn: null,
      currentTurnId: null,
      turnLoopRunning: false,
      intentionallyClosed: false,
    };
    cleanupState.internal = internal;
    deps.sessions.set(tempId, internal);
    deps.lifecycle.claimSession(tempId);
    cleanupState.tempRegistered = true;
    deps.emit({
      sessionId: tempId,
      agentId: AGENT_ID,
      kind: 'session-start',
      payload: {
        cwd: runtime.cwd,
        source: 'sdk',
        ...(target.initialSessionRegistration
          ? { initialSpawnLink: target.initialSessionRegistration.spawnLink }
          : {}),
      },
      ts: Date.now(),
      source: 'sdk',
    });
    target.initialSessionRegistration?.onRegistered(tempId);
    (deps.persistTargetFields ?? persistSessionFields)({
      sessionId: tempId,
      sandboxMode: runtime.sandboxMode,
      model: runtime.persistedModel,
      modelReasoningEffort: runtime.persistedReasoningEffort,
      extraAllowWrite: target.extraAllowWrite,
      networkAccessEnabled: target.networkAccessEnabled,
      additionalDirectories: target.additionalDirectories,
    });
    deps.faultInjector?.('after-temp-registration');

    deps.sessions.delete(tempId);
    deps.sessions.set(canonicalId, internal);
    internal.applicationSid = canonicalId;
    deps.lifecycle.renameSession(tempId, canonicalId);
    assertCanonicalOwnership(canonicalId, tempId, sessionToken, targetClient, internal, deps);
    deps.faultInjector?.('after-canonical-rename');

    deps.emit({
      sessionId: canonicalId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text: target.prompt!,
        role: 'user',
        ...(target.attachments?.length ? { attachments: target.attachments } : {}),
        ...(target.handOff ? { handOff: target.handOff } : {}),
      },
      ts: Date.now(),
      source: 'sdk',
    });

    let discardPromise: Promise<void> | null = null;
    const startTurn = (): void => {
      if (discardPromise || internal.intentionallyClosed) return;
      if (deps.sessions.get(canonicalId) !== internal) return;
      void deps.threadLoop.runTurnLoop(internal, canonicalId).catch((err: unknown) => {
        logger.warn(`[codex-fork] child turn loop failed for ${canonicalId}`, err);
      });
    };
    (deps.scheduleTurn ?? ((start) => setTimeout(start, 0)))(startTurn);

    return {
      sessionId: canonicalId,
      discard(): Promise<void> {
        discardPromise ??= cleanupCodexFork(cleanupState, deps);
        return discardPromise;
      },
    };
  } catch (err) {
    await cleanupCodexFork(cleanupState, deps);
    throw err;
  }
}

function assertCanonicalOwnership(
  canonicalId: string,
  tempId: string,
  sessionToken: string,
  targetClient: CodexAppServerClient,
  internal: InternalSession,
  deps: CreateCodexForkDeps,
): void {
  if (deps.sessions.get(canonicalId) !== internal || deps.sessions.has(tempId)) {
    throw new Error('Codex fork session map did not adopt the canonical child identity.');
  }
  if (
    deps.codexBySession.get(canonicalId) !== targetClient ||
    deps.codexBySession.has(tempId)
  ) {
    throw new Error('Codex fork client map did not adopt the canonical child identity.');
  }
  if (
    deps.lifecycle.resolveToken(sessionToken) !== canonicalId ||
    !deps.lifecycle.hasClaim(canonicalId) ||
    deps.lifecycle.hasClaim(tempId)
  ) {
    throw new Error('Codex fork token or SDK claim did not adopt the canonical child identity.');
  }
}
