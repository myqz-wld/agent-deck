import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AdapterContext,
  AdapterHookServerPort,
  AdapterRouteRegistryPort,
} from '@main/adapters/types';
import type { DaemonInstancePaths } from '@hosts/daemon';
import type { AgentEvent, SessionRecord } from '@shared/types';
import type { ServerCoreProviderSettings } from './provider-settings';
import type { ServerCoreRepositoryHost } from './repository-host';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';

export interface ServerCoreProviderHostInput {
  readonly instanceId: string;
  readonly paths: DaemonInstancePaths;
  readonly settings: ServerCoreProviderSettings;
  readonly repositories: ServerCoreRepositoryHost;
  readonly metadata: ServerCoreRuntimeMetadataStore;
  readonly diagnostics: ServerCoreRuntimeDiagnostics;
  readonly renames: ServerCoreProviderRenameBus;
}

export interface ServerCoreProviderRenameBus {
  emit(input: { from: string; to: string }): void;
  subscribe(listener: (input: { from: string; to: string }) => void): () => void;
}

export function createServerCoreProviderRenameBus(): ServerCoreProviderRenameBus {
  const listeners = new Set<(input: { from: string; to: string }) => void>();
  return Object.freeze({
    emit: (input) => {
      for (const listener of [...listeners]) listener(input);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export interface ServerCoreProviderLogger {
  debug(...details: unknown[]): void;
  info(...details: unknown[]): void;
  warn(...details: unknown[]): void;
  error(...details: unknown[]): void;
}

function safeDetails(details: readonly unknown[]): Readonly<Record<string, unknown>> | undefined {
  if (details.length === 0) return undefined;
  return Object.freeze({ details: details.map((value) =>
    value instanceof Error ? value.name : typeof value) });
}

export function providerLogger(
  diagnostics: ServerCoreRuntimeDiagnostics,
  scope: string,
): ServerCoreProviderLogger {
  const write = (level: 'info' | 'warn', details: readonly unknown[]): void => {
    try {
      const message = typeof details[0] === 'string'
        ? `[${scope}] ${details[0]}`
        : `[${scope}] provider diagnostic`;
      if (level === 'warn') diagnostics.warn(message, safeDetails(details.slice(1)));
      else diagnostics.info(message, safeDetails(details.slice(1)));
    } catch {
      // Diagnostics cannot alter provider control flow.
    }
  };
  return Object.freeze({
    debug: (...details) => write('info', details),
    info: (...details) => write('info', details),
    warn: (...details) => write('warn', details),
    error: (...details) => write('warn', details),
  });
}

export function publishProviderSession(input: ServerCoreProviderHostInput, sessionId: string): void {
  const record = input.repositories.sessions.get(sessionId);
  if (!record) return;
  input.metadata.appendChange('session.updated', sessionId, sessionChange(record));
}

export function sessionChange(record: SessionRecord) {
  return Object.freeze({
    activity: record.activity,
    adapterId: record.agentId,
    lifecycle: record.lifecycle,
    updatedAt: record.lastEventAt,
  });
}

export function emitProviderEvent(input: ServerCoreProviderHostInput, event: AgentEvent): void {
  input.repositories.sessionManager.ingest(event);
}

export function createHeadlessAdapterContext(
  input: ServerCoreProviderHostInput,
): AdapterContext {
  const hookServer: AdapterHookServerPort = Object.freeze({
    isRunning: false,
    listeningPort: 0,
    bearerToken: randomBytes(32).toString('hex'),
    mcpBearerToken: randomBytes(32).toString('hex'),
  });
  const routeRegistry: AdapterRouteRegistryPort = Object.freeze({
    registerForAdapter: () => undefined,
  });
  const userHome = process.env.HOME || homedir();
  return Object.freeze({
    hookServer,
    routeRegistry,
    emit: (event) => emitProviderEvent(input, event),
    paths: Object.freeze({
      appUserData: input.paths.stateDirectory,
      userHome,
      userClaudeSettings: join(userHome, '.claude', 'settings.json'),
    }),
  });
}

export function processEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

export function unsupportedRecoveryHost() {
  return Object.freeze({
    captureContinuation: () => {
      throw new Error('Headless continuation fallback is unavailable');
    },
    prepareContinuation: async () => {
      throw new Error('Headless continuation fallback is unavailable');
    },
    cleanupContinuation: () => undefined,
  });
}
