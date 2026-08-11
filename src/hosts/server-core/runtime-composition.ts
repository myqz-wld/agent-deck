import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { createProviderAdapterSet } from '@main/adapters/provider-adapter-set-core';
import {
  initializeProviderRuntimeCore,
} from '@main/adapters/provider-runtime-core';
import { AdapterRegistryClass } from '@main/adapters/registry-core';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { tokenUsageRepo } from '@main/store/token-usage-repo';
import { findSessionHandOffSuccessor } from '@main/store/session-handoff-alias-repo';
import { getSessionFileFinalDiff } from '@main/session/final-file-diff';
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import type { JsonObject } from '@contracts/index';
import type { WorkspaceSandboxSpec } from '@contracts/workspace-sandbox';
import { syncProviderHomeAuthFiles } from '@hosts/provider-state/provider-home-projection';
import type { ServerCoreRuntimeBootstrap, ServerCoreRuntimeFactoryInput } from './root';
import { ServerCoreCredentialFile } from './credential-file';
import { createServerCoreClaudeHost } from './provider-claude-host';
import { createServerCoreCodexHost } from './provider-codex-host';
import { createServerCoreGrokHost } from './provider-grok-host';
import {
  createHeadlessAdapterContext,
  createServerCoreProviderRenameBus,
  sessionChange,
  type ServerCoreProviderHostInput,
} from './provider-host-common';
import { ServerCoreProviderRuntimeLifecycle } from './provider-runtime-lifecycle';
import { resolveServerCoreProviderSettings } from './provider-settings';
import {
  resolveServerCoreProjectCatalog,
  withServerCoreWorkspaceRootProject,
} from './project-catalog';
import {
  ServerCoreRepositoryHost,
  type ServerCoreRuntimeDiagnostics,
} from './repository-host';
import { ServerCoreDaemonRuntime } from './runtime-core';
import { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import { ServerCoreSessionConsoleAuthority } from './session-console-authority';
import { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import { ServerCoreSessionAttachmentStore } from './session-attachment-store';
import { ServerCoreSessionDetailRuntime } from './session-detail-runtime';
import { ServerCoreIssueRuntime } from './issue-runtime';
import { ServerCoreMcpSessionCollaboration } from './mcp-session-collaboration';
import { ServerCoreMcpSessionSpawner } from './mcp-session-spawn';
import { ServerCoreSpawnCollaboration } from './mcp-spawn-collaboration';
import { ServerCoreWorktreeRuntime } from './mcp-worktree-runtime';
import { ServerCoreDesktopBrokerRuntime } from './desktop-broker-runtime';
import { createServerCoreProviderCompositionHost } from './runtime-provider-host';
import { createServerCoreMcpComposition } from './runtime-mcp-host';
import { installServerCoreProviderHooks } from './provider-hook-runtime';
import { ServerCoreProviderEventBus } from './provider-event-bus';
import {
  appendServerCoreChangeSafely,
  createServerCoreSessionManagerObserver,
} from './session-manager-observer';
import { mapServerCoreConcurrent } from './runtime-concurrency';
import { ServerCorePlanReviewRuntime } from './plan-review-runtime';
import { ServerCoreTeamRuntime } from './team-runtime';
import { ServerCoreUsageRuntime } from './usage-runtime';
import {
  resolveServerCoreProviderGrokContainer,
  resolveServerCoreProviderContainerRuntimePaths,
  resolveServerCoreProviderWorkspaceBoundary,
  validateServerCoreProviderContainerOption,
  type ServerCoreProviderGrokContainerPort,
} from './runtime-provider-container';

export const SERVER_CORE_CREDENTIAL_FILE = '/run/secrets/agent-deck/credentials.json';
export const SERVER_CORE_PROVIDER_AUTH_SOURCE = '/run/secrets/agent-deck/provider-home';
const MAX_PROVIDER_RETIREMENTS = 4_096;
const PROVIDER_RETIREMENT_CONCURRENCY = 8;
const RUNTIME_OPTION_KEYS = new Set(['projects', 'providerContainer', 'providerSettings']);

export interface ServerCoreRuntimeCompositionOverrides {
  readonly processId?: string;
  readonly credentialFilePath?: string;
  readonly diagnostics?: ServerCoreRuntimeDiagnostics;
  readonly workspaceRoot?: string;
  readonly workspaceSandbox?: WorkspaceSandboxSpec;
  /** Test/development seam. Production Full uses the fixed read-only secrets-volume path. */
  readonly providerAuthSource?: string | null;
  /** Trusted composition seam; capability publication remains independently fail-closed. */
  readonly grokContainer?: ServerCoreProviderGrokContainerPort;
}

function validateRuntimeOptions(runtimeOptions: JsonObject): void {
  for (const key of Object.keys(runtimeOptions)) {
    if (!RUNTIME_OPTION_KEYS.has(key)) {
      throw new Error(`runtimeOptions.${key} is unsupported`);
    }
  }
  validateServerCoreProviderContainerOption(runtimeOptions);
}

function diagnostics(): ServerCoreRuntimeDiagnostics {
  return Object.freeze({
    info: () => undefined,
    warn: () => {
      process.stderr.write('Server Core runtime warning; details hidden.\n');
    },
  });
}

/** Concrete Electron-free runtime module factory consumed by the packaged Server Core entrypoint. */
export function createServerCoreRuntimeWithOverrides(
  input: ServerCoreRuntimeFactoryInput,
  overrides: ServerCoreRuntimeCompositionOverrides = {},
): ServerCoreRuntimeBootstrap {
  validateRuntimeOptions(input.runtimeOptions);
  const workspaceRoot = overrides.workspaceRoot ?? '/workspaces';
  const workspaceBoundary = resolveServerCoreProviderWorkspaceBoundary(
    input,
    workspaceRoot,
    overrides.workspaceSandbox,
  );
  if (!overrides.workspaceSandbox) {
    const configuredSource = overrides.providerAuthSource === undefined
      ? SERVER_CORE_PROVIDER_AUTH_SOURCE
      : overrides.providerAuthSource;
    const source = configuredSource !== null &&
      lstatSync(configuredSource, { throwIfNoEntry: false })
      ? configuredSource
      : null;
    syncProviderHomeAuthFiles(source, workspaceBoundary.providerHomeRoot);
  }
  const runtimeDiagnostics = overrides.diagnostics ?? diagnostics();
  const grokContainer = overrides.grokContainer ?? resolveServerCoreProviderGrokContainer(
    input,
    workspaceRoot,
    runtimeDiagnostics,
    overrides.workspaceSandbox ? { workspaceSandbox: overrides.workspaceSandbox } : {},
  );
  let providerRuntimePrivateRoot: string | null = null;
  if (input.runtimeOptions.providerContainer) {
    try {
      providerRuntimePrivateRoot = resolveServerCoreProviderContainerRuntimePaths(
        input,
        overrides.workspaceSandbox,
      ).privateRoot;
    } catch {
      providerRuntimePrivateRoot = null;
    }
  }
  const processId = overrides.processId ??
    `${input.instanceId}:${process.pid}:${randomUUID()}`;
  const metadata = new ServerCoreRuntimeMetadataStore(input.paths);
  const reviewEvents = new ServerCoreProviderEventBus();
  const renames = createServerCoreProviderRenameBus();
  const repositories = new ServerCoreRepositoryHost({
    paths: input.paths,
    diagnostics: runtimeDiagnostics,
    handOffLifecycle: handOffCutoverCoordinator,
    observer: createServerCoreSessionManagerObserver({
      diagnostics: runtimeDiagnostics,
      metadata,
      reviewEvents,
      tokenUsage: tokenUsageRepo,
    }),
  });
  const privateRoots = Object.freeze([
    input.paths.stateDirectory,
    workspaceBoundary.privateRoot,
    workspaceBoundary.providerHomeRoot,
    workspaceBoundary.providerCacheRoot,
    workspaceBoundary.providerTempRoot,
    ...(providerRuntimePrivateRoot ? [providerRuntimePrivateRoot] : []),
  ]);
  const registry = new AdapterRegistryClass({
    begin: Date.now,
    observe: (phase, totalCount, failedCount) => {
      if (failedCount > 0) {
        runtimeDiagnostics.warn('Provider registry operation had failures', {
          failedCount,
          phase,
          totalCount,
        });
      }
    },
  });
  const providerSettings = resolveServerCoreProviderSettings(input.runtimeOptions);
  const projects = withServerCoreWorkspaceRootProject(
    resolveServerCoreProjectCatalog(input.runtimeOptions, workspaceRoot),
    workspaceRoot,
  );
  const createCapabilities = new ServerCoreSessionCreateCapabilities({
    grokContainer: grokContainer ?? undefined,
    metadata,
    projects,
    providerHomeRoot: workspaceBoundary.providerHomeRoot,
    registry,
    settings: providerSettings,
    workspaceRoot,
  });
  const attachmentStore = new ServerCoreSessionAttachmentStore({
    rootDirectory: join(input.paths.stateDirectory, 'session-attachments'),
  });
  const rollbackCreatedSession = async (adapterId: string, sessionId: string): Promise<void> => {
    const record = repositories.sessions.get(sessionId);
    if (record && record.agentId !== adapterId) {
      throw new Error('Created session rollback adapter identity changed');
    }
    const adapter = registry.get(adapterId);
    if (!adapter?.closeSessionForRollback) {
      throw new Error('Adapter does not provide strict session rollback');
    }
    await adapter.closeSessionForRollback(sessionId);
    repositories.sessionManager.discardAfterProviderRollback(sessionId);
    if (repositories.sessions.get(sessionId)) {
      throw new Error('Created session rollback durable cleanup did not complete');
    }
  };
  const sessionConsoleAuthority = new ServerCoreSessionConsoleAuthority({
    projects,
    workspaceRoot,
    repository: repositories.sessionConsoleRepository,
    registry,
    metadata,
    createCapabilities,
    attachmentStore,
    rollbackCreatedSession,
  });
  const collaboration = new ServerCoreMcpSessionCollaboration({
    workspaceRoot,
    privateRoots,
    sessions: repositories.sessions,
    events: repositories.events,
    teams: agentDeckTeamRepo,
    messages: agentDeckMessageRepo,
    successor: findSessionHandOffSuccessor,
    closeSession: (sessionId) => repositories.sessionManager.close(sessionId),
    adapter: (adapterId) => registry.get(adapterId),
    appendChange: (kind, entityId, payload) => {
      appendServerCoreChangeSafely(metadata, runtimeDiagnostics, kind, entityId, payload);
    },
  });
  const spawnCollaboration = new ServerCoreSpawnCollaboration({
    teams: agentDeckTeamRepo,
    messages: agentDeckMessageRepo,
    sessions: repositories.sessions,
    transaction: <T>(operation: () => T) => repositories.transaction(operation),
    notifyMembershipChanged: (sessionId) =>
      repositories.sessionManager.notifyTeamMembershipChanged(sessionId),
  });
  const spawn = new ServerCoreMcpSessionSpawner({
    sessions: repositories.sessions,
    sessionManager: repositories.sessionManager,
    registry,
    capabilities: createCapabilities,
    authority: sessionConsoleAuthority,
    collaboration: spawnCollaboration,
    metadata,
  });
  const worktrees = new ServerCoreWorktreeRuntime({
    workspaceRoot,
    privateRoots,
    sessions: repositories.sessions,
    registry,
    publishSession: (sessionId) => {
      const record = repositories.sessions.get(sessionId);
      if (record) appendServerCoreChangeSafely(
        metadata,
        runtimeDiagnostics,
        'session.updated',
        sessionId,
        sessionChange(record),
      );
    },
    publishStatus: (sessionId, text, error, generation) => {
      const record = repositories.sessions.get(sessionId);
      if (!record) return;
      repositories.sessionManager.ingest({
        sessionId,
        agentId: record.agentId,
        kind: 'message',
        payload: {
          role: 'system',
          text,
          ...(error ? { error: true } : {}),
          worktreeTransitionStatus: { generation },
        },
        ts: Date.now(),
        source: 'sdk',
      });
    },
    appendChange: (kind, entityId, payload) => {
      appendServerCoreChangeSafely(metadata, runtimeDiagnostics, kind, entityId, payload);
    },
    warn: (message) => {
      try { runtimeDiagnostics.warn(message); } catch {}
    },
  });
  const { desktopBroker, mcpBroker, presentations } = createServerCoreMcpComposition({
    workspaceRoot,
    privateRoots,
    repositories,
    metadata,
    collaboration,
    spawn,
    worktrees,
    worktreeRuntime: worktrees,
    registry,
    capabilities: createCapabilities,
    diagnostics: runtimeDiagnostics,
    reviewEvents,
    appendChange: (kind, entityId, payload) => {
      appendServerCoreChangeSafely(metadata, runtimeDiagnostics, kind, entityId, payload);
    },
  });
  const providerInput: ServerCoreProviderHostInput = Object.freeze({
    instanceId: input.instanceId,
    paths: input.paths,
    settings: providerSettings,
    repositories,
    metadata,
    diagnostics: runtimeDiagnostics,
    renames,
    workspaceBoundary,
    mcpBroker,
    worktrees,
    ...(grokContainer
      ? { grokProcessFactory: grokContainer.processFactory }
      : {}),
  });
  const adapterSet = createProviderAdapterSet({
    claude: createServerCoreClaudeHost(providerInput),
    codex: createServerCoreCodexHost(providerInput),
    grok: createServerCoreGrokHost(providerInput),
  });
  const providerHost = createServerCoreProviderCompositionHost({
    registry,
    adapters: adapterSet.adapters,
    repositories,
    desktopBroker,
    presentations,
    worktrees,
    renames,
    diagnostics: runtimeDiagnostics,
  });
  const retireProviders = async (): Promise<void> => {
    const records = repositories.sessions.listActiveAndDormant(
      MAX_PROVIDER_RETIREMENTS + 1,
      0,
    );
    if (records.length > MAX_PROVIDER_RETIREMENTS) {
      throw new Error('Provider retirement exceeds its bounded session ceiling');
    }
    await mapServerCoreConcurrent(
      records.filter((record) => record.lifecycle === 'active'),
      PROVIDER_RETIREMENT_CONCURRENCY,
      async (record) => {
        const adapter = registry.get(record.agentId);
        await adapter?.closeSession?.(record.id);
      },
    );
  };
  const shutdownProviders = async (): Promise<void> => {
    const failures: unknown[] = (await registry.shutdownAll())
      .filter((result) => !result.ok)
      .map((result) => result.err);
    if (grokContainer) {
      try { await grokContainer.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Provider adapter shutdown failed',
      );
    }
  };
  const lifecycle = new ServerCoreProviderRuntimeLifecycle({
    repository: repositories,
    metadata,
    mcpBroker,
    desktopBroker,
    presentations,
    collaboration,
    worktrees,
    initializeProviders: async () => {
      const results = await initializeProviderRuntimeCore(
        providerHost,
        createHeadlessAdapterContext(providerInput),
      );
      await installServerCoreProviderHooks(results, registry);
    },
    retireProviders,
    shutdownProviders,
    diagnostics: runtimeDiagnostics,
  });
  const baseRuntime = new ServerCoreDaemonRuntime({
    instanceId: input.instanceId,
    repository: repositories.sessions,
    events: repositories.events,
    registry,
    metadata,
    lifecycle,
    presentations,
  });
  const detailRuntime = new ServerCoreSessionDetailRuntime(baseRuntime, {
    workspaceRoot,
    sessions: repositories.sessions,
    events: repositories.events,
    summaries: repositories.summaries,
    tasks: repositories.tasks,
    fileChanges: repositories.fileChanges,
    getFinalDiff: getSessionFileFinalDiff,
    privateRoots,
  });
  const issueRuntime = new ServerCoreIssueRuntime(detailRuntime, {
    workspaceRoot,
    privateRoots,
    issues: repositories.issues,
    metadata,
    sessionConsole: sessionConsoleAuthority,
    rollbackSession: rollbackCreatedSession,
  });
  const teamRuntime = new ServerCoreTeamRuntime(issueRuntime, {
    workspaceRoot,
    privateRoots,
    teams: agentDeckTeamRepo,
    messages: agentDeckMessageRepo,
    sessions: repositories.sessions,
    events: repositories.events,
    tasks: repositories.tasks,
    closeSession: (sessionId) => repositories.sessionManager.close(sessionId),
    notifyMembershipChanged: (sessionId) =>
      repositories.sessionManager.notifyTeamMembershipChanged(sessionId),
    metadata,
  });
  const usageRuntime = new ServerCoreUsageRuntime(teamRuntime, {
    tokenUsage: tokenUsageRepo,
    registry,
    currentRevision: () => metadata.currentRevision(),
  });
  const reviewRuntime = new ServerCorePlanReviewRuntime(usageRuntime, presentations, metadata);
  const runtime = new ServerCoreDesktopBrokerRuntime(reviewRuntime, desktopBroker);
  const credentialLifecycle = new ServerCoreCredentialFile({
    instanceId: input.instanceId,
    processId,
    path: overrides.credentialFilePath ?? SERVER_CORE_CREDENTIAL_FILE,
    diagnostics: runtimeDiagnostics,
  });
  return Object.freeze({
    processId,
    runtime,
    sessionConsoleAuthority,
    credentialLifecycle,
    components: Object.freeze([]),
  });
}

export function createServerCoreRuntime(
  input: ServerCoreRuntimeFactoryInput,
): ServerCoreRuntimeBootstrap {
  return createServerCoreRuntimeWithOverrides(input);
}
