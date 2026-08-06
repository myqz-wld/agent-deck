import { randomUUID } from 'node:crypto';

import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { createProviderAdapterSet } from '@main/adapters/provider-adapter-set-core';
import {
  initializeProviderRuntimeCore,
  type ProviderRuntimeCompositionHost,
} from '@main/adapters/provider-runtime-core';
import { AdapterRegistryClass } from '@main/adapters/registry-core';
import type { AgentAdapter } from '@main/adapters/types';
import type { JsonObject, JsonValue } from '@contracts/index';
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
import { resolveServerCoreProjectCatalog } from './project-catalog';
import {
  ServerCoreRepositoryHost,
  type ServerCoreRuntimeDiagnostics,
} from './repository-host';
import { ServerCoreDaemonRuntime } from './runtime-core';
import { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import { ServerCoreSessionConsoleAuthority } from './session-console-authority';

export const SERVER_CORE_CREDENTIAL_FILE = '/run/secrets/agent-deck/credentials.json';
const MAX_PROVIDER_RETIREMENTS = 4_096;
const PROVIDER_RETIREMENT_CONCURRENCY = 8;
const RUNTIME_OPTION_KEYS = new Set(['projects', 'providerSettings']);

export interface ServerCoreRuntimeCompositionOverrides {
  readonly processId?: string;
  readonly credentialFilePath?: string;
  readonly diagnostics?: ServerCoreRuntimeDiagnostics;
}

function validateRuntimeOptions(runtimeOptions: JsonObject): void {
  for (const key of Object.keys(runtimeOptions)) {
    if (!RUNTIME_OPTION_KEYS.has(key)) {
      throw new Error(`runtimeOptions.${key} is unsupported`);
    }
  }
}

function diagnostics(): ServerCoreRuntimeDiagnostics {
  return Object.freeze({
    info: () => undefined,
    warn: () => {
      process.stderr.write('Server Core runtime warning; details hidden.\n');
    },
  });
}

function safeAppend(
  metadata: ServerCoreRuntimeMetadataStore,
  runtimeDiagnostics: ServerCoreRuntimeDiagnostics,
  kind: string,
  entityId: string | null,
  payload: JsonValue,
): void {
  try {
    metadata.appendChange(kind, entityId, payload);
  } catch {
    try { runtimeDiagnostics.warn('Core change publication failed'); } catch {}
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  consume: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const failures: unknown[] = [];
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (index < values.length) {
        const value = values[index++];
        try { await consume(value!); } catch (error) { failures.push(error); }
      }
    },
  ));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Provider session retirement failed');
  }
}

function renameCodexLiveSession(
  agentId: string,
  adapter: AgentAdapter | undefined,
  fromId: string,
  toId: string,
): void {
  if (agentId !== 'codex-cli') return;
  mcpSessionTokenMap.rename(fromId, toId);
  const bridge = (adapter as {
    bridge?: { renameCodexInstance?: (from: string, to: string) => void } | null;
  } | undefined)?.bridge;
  bridge?.renameCodexInstance?.(fromId, toId);
}

/** Concrete Electron-free runtime module factory consumed by the packaged Server Core entrypoint. */
export function createServerCoreRuntimeWithOverrides(
  input: ServerCoreRuntimeFactoryInput,
  overrides: ServerCoreRuntimeCompositionOverrides = {},
): ServerCoreRuntimeBootstrap {
  validateRuntimeOptions(input.runtimeOptions);
  const runtimeDiagnostics = overrides.diagnostics ?? diagnostics();
  const processId = overrides.processId ??
    `${input.instanceId}:${process.pid}:${randomUUID()}`;
  const metadata = new ServerCoreRuntimeMetadataStore(input.paths);
  const renames = createServerCoreProviderRenameBus();
  const repositories = new ServerCoreRepositoryHost({
    paths: input.paths,
    diagnostics: runtimeDiagnostics,
    observer: {
      eventPersisted: (event, eventId) => safeAppend(
        metadata,
        runtimeDiagnostics,
        'event.persisted',
        event.sessionId,
        { adapterId: event.agentId, eventId, kind: event.kind, timestamp: event.ts },
      ),
      sessionUpdated: (session) => safeAppend(
        metadata,
        runtimeDiagnostics,
        'session.updated',
        session.id,
        sessionChange(session),
      ),
      sessionRemoved: (sessionId) => safeAppend(
        metadata,
        runtimeDiagnostics,
        'session.removed',
        sessionId,
        null,
      ),
      sessionRenamed: (fromId, toId) => safeAppend(
        metadata,
        runtimeDiagnostics,
        'session.renamed',
        toId,
        { fromId, toId },
      ),
      warning: () => {
        try { runtimeDiagnostics.warn('Server Core session lifecycle warning'); } catch {}
      },
    },
  });
  const providerInput: ServerCoreProviderHostInput = Object.freeze({
    instanceId: input.instanceId,
    paths: input.paths,
    settings: resolveServerCoreProviderSettings(input.runtimeOptions),
    repositories,
    metadata,
    diagnostics: runtimeDiagnostics,
    renames,
  });
  const adapterSet = createProviderAdapterSet({
    claude: createServerCoreClaudeHost(providerInput),
    codex: createServerCoreCodexHost(providerInput),
    grok: createServerCoreGrokHost(providerInput),
  });
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
  const providerHost: ProviderRuntimeCompositionHost = {
    registry,
    adapters: adapterSet.adapters,
    installSessionClose: (handler) => repositories.sessionManager.installSessionClose(handler),
    installSessionRename: (handler) => repositories.sessionManager.installSessionRename(handler),
    renameLiveSession: (agentId, adapter, fromId, toId) => {
      renameCodexLiveSession(agentId, adapter, fromId, toId);
      renames.emit({ from: fromId, to: toId });
    },
    reportAdapterInitFailure: (result) => {
      runtimeDiagnostics.warn('Provider adapter initialization failed', { adapterId: result.id });
    },
  };
  const retireProviders = async (): Promise<void> => {
    const records = repositories.sessions.listActiveAndDormant(
      MAX_PROVIDER_RETIREMENTS + 1,
      0,
    );
    if (records.length > MAX_PROVIDER_RETIREMENTS) {
      throw new Error('Provider retirement exceeds its bounded session ceiling');
    }
    await mapConcurrent(
      records.filter((record) => record.lifecycle === 'active'),
      PROVIDER_RETIREMENT_CONCURRENCY,
      async (record) => {
        const adapter = registry.get(record.agentId);
        await adapter?.closeSession?.(record.id);
      },
    );
  };
  const shutdownProviders = async (): Promise<void> => {
    const failures = (await registry.shutdownAll()).filter((result) => !result.ok);
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.err),
        'Provider adapter shutdown failed',
      );
    }
  };
  const lifecycle = new ServerCoreProviderRuntimeLifecycle({
    repository: repositories,
    metadata,
    initializeProviders: async () => {
      await initializeProviderRuntimeCore(
        providerHost,
        createHeadlessAdapterContext(providerInput),
      );
    },
    retireProviders,
    shutdownProviders,
    diagnostics: runtimeDiagnostics,
  });
  const runtime = new ServerCoreDaemonRuntime({
    instanceId: input.instanceId,
    repository: repositories.sessions,
    events: repositories.events,
    registry,
    metadata,
    lifecycle,
  });
  const sessionConsoleAuthority = new ServerCoreSessionConsoleAuthority({
    projects: resolveServerCoreProjectCatalog(input.runtimeOptions),
    repository: repositories.sessionConsoleRepository,
    registry,
    metadata,
  });
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
