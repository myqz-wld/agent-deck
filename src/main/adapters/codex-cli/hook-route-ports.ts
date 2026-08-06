import type { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import type { CodexOpenToolUse } from './hook-translate';

export interface CodexHookIdentity {
  session_id: string;
  transcript_path?: string | null;
}

export interface CodexHookFilterPort {
  shouldIgnore(
    body: CodexHookIdentity,
    hookOrigin: 'sdk' | 'cli',
    externalProcessPid: number | null,
  ): Promise<boolean>;
}

export interface CodexOpenToolUseReader {
  listForSession(sessionId: string): CodexOpenToolUse[];
}

export interface CodexHookRouteObserver {
  reconciliationFailed(input: {
    sessionId: string;
    terminalHook: 'Stop' | 'SessionEnd';
    error: unknown;
  }): void;
}

export interface CodexHookRoutePorts {
  readonly filter: CodexHookFilterPort;
  readonly diagnostics: HookRouteDiagnostics;
  readonly openToolUseReader: CodexOpenToolUseReader;
  readonly observer: CodexHookRouteObserver;
}
