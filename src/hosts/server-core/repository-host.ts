import { join } from 'node:path';

import type { LifecycleComponent } from '@composition/index';
import type { DaemonInstancePaths } from '@hosts/daemon';
import {
  AGENT_DECK_DATABASE_FILENAME,
  closeDb,
  getDb,
  initDb,
} from '@main/store/db';
import { eventRepo } from '@main/store/event-repo';
import { setEventRepositoryDiagnostics } from '@main/store/event-repo-diagnostics-core';
import { sessionRepo } from '@main/store/session-repo';
import { setSessionRepositoryDiagnostics } from '@main/store/session-repo/diagnostics-core';
import {
  ServerCoreSessionManager,
  type ServerCoreSessionManagerObserver,
} from './session-manager';
import type { ServerCoreSessionConsoleRepositoryPort } from './session-console-authority';

export interface ServerCoreRuntimeDiagnostics {
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(
    message: string,
    details?: Readonly<Record<string, unknown>>,
    error?: unknown,
  ): void;
}

export interface ServerCoreRepositoryHostOptions {
  readonly paths: DaemonInstancePaths;
  readonly diagnostics: ServerCoreRuntimeDiagnostics;
  readonly observer: ServerCoreSessionManagerObserver;
}

function safeDiagnostic(
  diagnostics: ServerCoreRuntimeDiagnostics,
  level: 'info' | 'warn',
  message: string,
  details?: Readonly<Record<string, unknown>>,
  error?: unknown,
): void {
  try {
    if (level === 'warn') diagnostics.warn(message, details, error);
    else diagnostics.info(message, details);
  } catch {
    // Diagnostics cannot change repository lifecycle or persistence outcomes.
  }
}

/** Owns the authoritative process-wide SQLite repository graph for one headless Core. */
export class ServerCoreRepositoryHost implements LifecycleComponent {
  readonly name = 'server-core-repositories';
  readonly sessions = sessionRepo;
  readonly events = eventRepo;
  readonly sessionManager: ServerCoreSessionManager;
  readonly sessionConsoleRepository: ServerCoreSessionConsoleRepositoryPort;
  readonly databasePath: string;
  private started = false;

  constructor(private readonly options: ServerCoreRepositoryHostOptions) {
    this.databasePath = join(
      options.paths.stateDirectory,
      AGENT_DECK_DATABASE_FILENAME,
    );
    this.sessionManager = new ServerCoreSessionManager({
      sessions: this.sessions,
      events: this.events,
      observer: options.observer,
    });
    this.sessionConsoleRepository = Object.freeze({
      get: (sessionId: string) => this.sessions.get(sessionId),
      listLive: (limit: number, offset: number) =>
        this.sessions.listActiveAndDormant(limit, offset),
      listHistory: (limit: number, offset: number) =>
        this.sessions.listHistory({ limit, offset }),
      countLive: () => Number(getDb().prepare(
        `SELECT COUNT(*) FROM sessions
          WHERE archived_at IS NULL AND lifecycle IN ('active', 'dormant')`,
      ).pluck().get()),
      countHistory: () => Number(getDb().prepare(
        `SELECT COUNT(*) FROM sessions
          WHERE hidden_from_history = 0
            AND (lifecycle = 'closed' OR archived_at IS NOT NULL)`,
      ).pluck().get()),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    setSessionRepositoryDiagnostics({
      warn: (message, details, error) =>
        safeDiagnostic(this.options.diagnostics, 'warn', message, details, error),
    });
    setEventRepositoryDiagnostics({
      warn: (message, details, error) =>
        safeDiagnostic(this.options.diagnostics, 'warn', message, details, error),
    });
    try {
      initDb({
        databasePath: this.databasePath,
        diagnostics: {
          info: (message, details) =>
            safeDiagnostic(this.options.diagnostics, 'info', message, details),
          warn: (message, details) =>
            safeDiagnostic(this.options.diagnostics, 'warn', message, details),
        },
      });
      this.started = true;
    } catch (error) {
      setEventRepositoryDiagnostics(null);
      setSessionRepositoryDiagnostics(null);
      throw error;
    }
  }

  async stop(_reason: string): Promise<void> {
    if (!this.started) return;
    try {
      closeDb();
    } finally {
      this.started = false;
      setEventRepositoryDiagnostics(null);
      setSessionRepositoryDiagnostics(null);
    }
  }

  transaction<T>(operation: () => T): T {
    return getDb().transaction(operation)();
  }
}
