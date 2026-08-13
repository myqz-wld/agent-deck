import { randomUUID } from 'node:crypto';

import {
  SESSION_CONSOLE_CREATE_OPTION_KEYS,
  parseSessionConsoleInitialMessage,
  parseWorkspaceDirectoryRef,
  type SessionConsoleCapabilitiesResult,
  type SessionConsoleCreateOptions,
} from '@contracts/index';
import { buildLeadContextBlock } from '@main/agent-deck-mcp/tools/handlers/lead-context-block';
import type {
  AgentAdapter,
  CreateSessionOptions,
  ForkedSessionHandle,
  ForkSessionSource,
} from '@main/adapters/types';
import type { SessionAdapterId, SessionRecord } from '@shared/types';

import { ServerCoreSpawnCollaboration } from './mcp-spawn-collaboration';
import {
  assertServerCoreSpawnForkSourceUnchanged,
  revalidateServerCoreSpawnFork,
  validateServerCoreSpawnFork,
} from './mcp-spawn-fork';
import { ServerCoreSpawnGuard } from './mcp-spawn-guard';
import type {
  ServerCoreMcpSpawnPort,
  ServerCoreSpawnSessionArgs,
  ServerCoreSpawnSessionResult,
} from './mcp-spawn-port';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type { ServerCoreSessionConsoleAuthority } from './session-console-authority';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import { buildRemoteCreateOptions } from './session-create-options';
import { serverCoreWorktreeReferenceFence } from './worktree-reference-fence';

interface SpawnSessionRepository {
  get(sessionId: string): SessionRecord | null;
  listChildren(parentId: string, lifecycle: 'active'): SessionRecord[];
  setSpawnLink(sessionId: string, parentSessionId: string, depth: number): void;
  setTitle(sessionId: string, title: string): void;
}

interface SpawnSessionManager {
  recordCreatedPermissionMode(sessionId: string, mode: string | undefined): void;
  discardAfterProviderRollback(sessionId: string): void;
}

export interface ServerCoreMcpSessionSpawnerOptions {
  readonly sessions: SpawnSessionRepository;
  readonly sessionManager: SpawnSessionManager;
  readonly registry: { get(adapterId: string): AgentAdapter | undefined };
  readonly capabilities: ServerCoreSessionCreateCapabilities;
  readonly authority: ServerCoreSessionConsoleAuthority;
  readonly collaboration: ServerCoreSpawnCollaboration;
  readonly metadata: ServerCoreRuntimeMetadataStore;
  readonly now?: () => number;
}

function explicitOptions(
  args: ServerCoreSpawnSessionArgs,
): Partial<Record<keyof SessionConsoleCreateOptions, string>> {
  const provider = args.adapter === 'claude-code'
    ? args.gateway
    : args.adapter === 'codex-cli' ? args.provider : undefined;
  return {
    ...(args.approvalPolicy === undefined ? {} : { approvalPolicy: args.approvalPolicy }),
    ...(args.claudeCodeSandbox === undefined
      ? {}
      : { claudeCodeSandbox: args.claudeCodeSandbox }),
    ...(args.codexSandbox === undefined ? {} : { codexSandbox: args.codexSandbox }),
    ...(args.grokSandbox === undefined ? {} : { grokSandbox: args.grokSandbox }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.permissionMode === undefined ? {} : { permissionMode: args.permissionMode }),
    ...(provider === undefined ? {} : { provider }),
    ...(args.sessionMode === undefined ? {} : { sessionMode: args.sessionMode }),
    ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
  };
}

export function resolveServerCoreCreateOptions(
  descriptor: SessionConsoleCapabilitiesResult,
  args: ServerCoreSpawnSessionArgs,
): SessionConsoleCreateOptions {
  if (args.gateway !== undefined && args.adapter !== 'claude-code') {
    throw new Error('gateway is owned by claude-code');
  }
  if (args.provider !== undefined && args.adapter !== 'codex-cli') {
    throw new Error('provider is owned by codex-cli');
  }
  const values = Object.fromEntries(SESSION_CONSOLE_CREATE_OPTION_KEYS.map((key) => [
    key,
    descriptor.create.options[key].defaultValue,
  ])) as unknown as SessionConsoleCreateOptions;
  Object.assign(values, explicitOptions(args));
  return values;
}

function requireCaller(
  sessions: SpawnSessionRepository,
  callerSessionId: string,
): SessionRecord {
  const caller = sessions.get(callerSessionId);
  if (!caller || caller.lifecycle === 'closed' || caller.archivedAt !== null) {
    throw new Error('Authenticated spawn caller is no longer live');
  }
  return caller;
}

/** Creates a real provider child while keeping cwd, defaults, teams, and rollback Core-owned. */
export class ServerCoreMcpSessionSpawner implements ServerCoreMcpSpawnPort {
  private readonly now: () => number;
  private readonly guard: ServerCoreSpawnGuard;

  constructor(private readonly options: ServerCoreMcpSessionSpawnerOptions) {
    this.now = options.now ?? Date.now;
    this.guard = new ServerCoreSpawnGuard(options.sessions, this.now);
  }

  async spawn(
    callerSessionId: string,
    args: ServerCoreSpawnSessionArgs,
  ): Promise<ServerCoreSpawnSessionResult> {
    requireCaller(this.options.sessions, callerSessionId);
    const contextMode = args.contextMode ?? 'fresh';
    const cwd = parseWorkspaceDirectoryRef(args.cwd, 'spawn_session.cwd');
    const originalPrompt = parseSessionConsoleInitialMessage(args.prompt, 'spawn_session.prompt');
    const selector = args.adapter === 'claude-code'
      ? args.gateway
      : args.adapter === 'codex-cli' ? args.provider : undefined;
    const descriptor = await this.options.capabilities.describe({
      adapterId: args.adapter,
      provider: selector ?? '',
      workingDirectory: cwd,
    });
    const options = resolveServerCoreCreateOptions(descriptor, args);
    await this.options.capabilities.validateCreate(
      args.adapter,
      descriptor.capabilityRevision,
      cwd,
      options,
    );
    let liveCaller = requireCaller(this.options.sessions, callerSessionId);
    let forkAdapter: AgentAdapter | null = null;
    let forkSource: ForkSessionSource | null = null;
    let forkTarget: CreateSessionOptions | null = null;
    if (contextMode === 'fork') {
      forkAdapter = this.options.registry.get(args.adapter) ?? null;
      if (!forkAdapter) throw new Error(`adapter "${args.adapter}" is unavailable`);
      const absoluteCwd = this.options.capabilities.resolveWorkingDirectory(cwd);
      forkTarget = buildRemoteCreateOptions({
        adapterId: args.adapter,
        attachments: [],
        capabilityRevision: descriptor.capabilityRevision,
        initialMessage: originalPrompt,
        options,
        workingDirectory: cwd,
      }, absoluteCwd, [], {
        awaitCanonicalId: true,
        ...(args.teamName ? { teamName: args.teamName } : {}),
      });
      forkSource = await validateServerCoreSpawnFork({
        adapter: forkAdapter,
        caller: liveCaller,
        target: forkTarget,
      });
      liveCaller = requireCaller(this.options.sessions, callerSessionId);
      await revalidateServerCoreSpawnFork({
        caller: liveCaller,
        source: forkSource,
        target: forkTarget,
      });
      liveCaller = requireCaller(this.options.sessions, callerSessionId);
      assertServerCoreSpawnForkSourceUnchanged({
        caller: liveCaller,
        source: forkSource,
        target: forkTarget,
      });
    }
    const team = this.options.collaboration.preflight(callerSessionId, args.teamName);
    const anchorId = randomUUID();
    const leadContext = buildLeadContextBlock({
      leadSessionId: callerSessionId,
      teamId: team.teamId,
      leadDisplayName: liveCaller.title || null,
      leadAdapter: liveCaller.agentId,
      placeholderId: anchorId,
    });
    const prompt = parseSessionConsoleInitialMessage(
      `${leadContext.wirePrefix}${leadContext.contextBlock}\n---\n\n${originalPrompt}`,
      'spawn_session.prompt',
    );

    let lease: ReturnType<ServerCoreSpawnGuard['reserve']>;
    try {
      lease = this.guard.reserve(liveCaller);
    } catch (error) {
      this.options.collaboration.cleanup(team);
      throw error;
    }
    const depth = lease.parentDepth + 1;
    let registeredSessionId: string | null = null;
    let createdSessionId: string | null = null;
    let forkHandle: ForkedSessionHandle | null = null;
    try {
      const initialSessionRegistration = {
        spawnLink: { parentSessionId: callerSessionId, depth },
        onRegistered: (sessionId: string) => {
          if (registeredSessionId !== null && registeredSessionId !== sessionId) {
            throw new Error('Provider registered more than one spawn target');
          }
          registeredSessionId = sessionId;
          lease.release();
        },
      };
      if (contextMode === 'fork') {
        if (!forkAdapter?.createForkedSession || !forkSource || !forkTarget) {
          throw new Error('Native fork preflight was not retained');
        }
        const currentCwd = this.options.capabilities.resolveWorkingDirectory(cwd);
        if (currentCwd !== forkTarget.cwd) throw new Error('Fork cwd identity changed');
        forkTarget.prompt = prompt;
        forkTarget.initialSessionRegistration = initialSessionRegistration;
        const cwdLease = serverCoreWorktreeReferenceFence.acquireReference(currentCwd);
        try {
          forkHandle = await forkAdapter.createForkedSession(forkSource, forkTarget);
          createdSessionId = forkHandle.sessionId;
        } finally {
          cwdLease.release();
        }
      } else {
        const result = await this.options.authority.createSpawnSession({
          params: {
            adapterId: args.adapter,
            attachments: [],
            capabilityRevision: descriptor.capabilityRevision,
            initialMessage: prompt,
            workingDirectory: cwd,
            options,
          },
          initialSessionRegistration,
          ...(team.teamName === null ? {} : { teamName: team.teamName }),
        });
        createdSessionId = result.sessionId;
      }
      if (contextMode === 'fork') {
        liveCaller = requireCaller(this.options.sessions, callerSessionId);
        assertServerCoreSpawnForkSourceUnchanged({
          caller: liveCaller,
          source: forkSource!,
          target: forkTarget!,
        });
      }
      this.assertSpawnLink(
        callerSessionId,
        createdSessionId,
        registeredSessionId,
        depth,
        contextMode,
      );
      this.options.collaboration.complete({
        preflight: team,
        callerSessionId,
        targetSessionId: createdSessionId,
        displayName: args.displayName ?? null,
        anchorId,
        anchorBody: originalPrompt,
      });
    } catch (error) {
      const target = createdSessionId ?? registeredSessionId;
      let outcome = error;
      try {
        if (target !== null) await this.rollback(args.adapter, target, error, forkHandle);
      } catch (rollbackError) {
        outcome = rollbackError;
      } finally {
        this.options.collaboration.cleanup(team);
      }
      throw outcome;
    } finally {
      lease.release();
    }

    const sessionId = createdSessionId!;
    try {
      if (args.displayName) this.options.sessions.setTitle(sessionId, args.displayName);
      this.options.sessionManager.recordCreatedPermissionMode(
        sessionId,
        options.permissionMode ?? undefined,
      );
      this.options.metadata.appendChange('session.spawned', sessionId, {
        adapterId: args.adapter,
        parentSessionId: callerSessionId,
        sessionId,
        spawnDepth: depth,
        teamId: team.teamId,
        workingDirectory: cwd,
        contextMode,
        ...(contextMode === 'fork' ? { forkedFromSessionId: callerSessionId } : {}),
      });
    } catch {
      // Presentation metadata cannot make a committed provider/team spawn ambiguous to its caller.
    }
    const provider = options.provider || null;
    return {
      sessionId,
      adapter: args.adapter,
      gateway: args.adapter === 'claude-code' ? provider : null,
      provider: args.adapter === 'codex-cli' ? provider : null,
      cwd,
      teamId: team.teamId,
      teamName: team.teamName,
      displayName: args.displayName ?? null,
      spawnDepth: depth,
      spawnLimits: lease.snapshot(),
      sentAt: this.now(),
      spawnPromptMessageId: anchorId,
      ...(contextMode === 'fork'
        ? { contextMode: 'fork', forkedFromSessionId: callerSessionId }
        : { contextMode: 'fresh' }),
    };
  }

  private assertSpawnLink(
    callerSessionId: string,
    sessionId: string,
    registeredSessionId: string | null,
    depth: number,
    contextMode: 'fresh' | 'fork',
  ): void {
    if (contextMode === 'fork' && registeredSessionId === null) {
      throw new Error('Fork target was not durably registered');
    }
    if (registeredSessionId !== null && registeredSessionId !== sessionId) {
      const consumedByCanonicalRename = contextMode === 'fork' &&
        this.options.sessions.get(registeredSessionId) === null;
      if (!consumedByCanonicalRename) {
        throw new Error('Provider returned a different canonical spawn target');
      }
    }
    let record = this.options.sessions.get(sessionId);
    if (!record) throw new Error('Spawn target was not durably registered');
    if (
      contextMode === 'fresh' &&
      (record.spawnedBy === null || record.spawnedBy === undefined)
    ) {
      this.options.sessions.setSpawnLink(sessionId, callerSessionId, depth);
      record = this.options.sessions.get(sessionId);
    }
    if (record?.spawnedBy !== callerSessionId || record.spawnDepth !== depth) {
      throw new Error('Spawn target lineage does not match the authenticated caller');
    }
  }

  private async rollback(
    adapterId: SessionAdapterId,
    sessionId: string,
    cause: unknown,
    forkHandle: ForkedSessionHandle | null,
  ): Promise<void> {
    const adapter = this.options.registry.get(adapterId);
    let closeError: unknown = null;
    let closeProven = false;
    if (!adapter?.closeSessionForRollback) {
      closeError = new Error('Strict provider rollback is unavailable');
    } else {
      try {
        await adapter.closeSessionForRollback(sessionId);
        closeProven = true;
      } catch (error) {
        closeError = error;
      }
    }

    let forkError: unknown = null;
    let forkProven = forkHandle === null;
    if (forkHandle) {
      try {
        await forkHandle.discard();
        forkProven = true;
      } catch (error) {
        forkError = error;
      }
    }

    const providerCleanupProven = closeProven || (forkHandle !== null && forkProven);
    let recordError: unknown = null;
    if (providerCleanupProven) {
      try {
        this.options.sessionManager.discardAfterProviderRollback(sessionId);
        if (this.options.sessions.get(sessionId)) {
          throw new Error('Spawn target remained after strict rollback');
        }
      } catch (error) {
        recordError = error;
      }
    } else {
      recordError = new Error('Provider cleanup remained unproved');
    }

    const residualErrors: unknown[] = [];
    if (!providerCleanupProven) {
      if (closeError !== null) residualErrors.push(closeError);
      if (forkError !== null) residualErrors.push(forkError);
    } else if (forkHandle !== null && !forkProven && forkError !== null) {
      residualErrors.push(forkError);
    }
    if (recordError !== null) residualErrors.push(recordError);
    if (residualErrors.length === 0) return;
    throw new AggregateError(
      [cause, ...new Set(residualErrors)],
      'Spawn rollback could not prove cleanup; do not retry this request',
    );
  }
}
