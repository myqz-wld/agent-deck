import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import {
  NOOP_CODEX_CLIENT_DIAGNOSTICS,
  type CodexAppServerClientDiagnostics,
} from './client-diagnostics-port';
import {
  NOOP_CODEX_GENERATION_DIAGNOSTICS,
  type CodexGenerationDiagnostics,
  type CodexGenerationOperation,
} from './generation-operation';
import type { CodexMcpStartupObserver } from './mcp-startup-observer';
import type { CodexAppServerClient } from './client';
import { CodexAppServerThread } from './thread';
import type { CodexThreadMode } from './thread-mode';

export interface CodexAppServerProcessStart {
  codexPathOverride?: string | null;
  cwd?: string;
  env: Record<string, string>;
}

export interface CodexAppServerClientHost extends CodexAppServerClientDiagnostics {
  generationDiagnostics: CodexGenerationDiagnostics;
  createMcpStartupObserver(): CodexMcpStartupObserver;
  createThread(
    client: CodexAppServerClient,
    mode: CodexThreadMode,
    attachedGeneration?: number,
    initialRuntime?: unknown,
  ): CodexAppServerThread;
  prepareThreadOptions(
    client: CodexAppServerClient,
    options: CodexThreadOptions,
    baseConfig: CodexConfigObject | null,
    operation?: CodexGenerationOperation,
  ): Promise<CodexThreadOptions>;
  startProcess(input: CodexAppServerProcessStart): ChildProcessWithoutNullStreams;
}

export const UNCONFIGURED_CODEX_CLIENT_HOST: CodexAppServerClientHost = Object.freeze({
  ...NOOP_CODEX_CLIENT_DIAGNOSTICS,
  generationDiagnostics: NOOP_CODEX_GENERATION_DIAGNOSTICS,
  createMcpStartupObserver: () => ({
    observe: () => null,
    reset: () => undefined,
  }),
  createThread: (client, mode, attachedGeneration, initialRuntime) =>
    new CodexAppServerThread(client, mode, attachedGeneration, initialRuntime),
  prepareThreadOptions: (_client, options) => Promise.resolve(options),
  startProcess: () => {
    throw new Error('Codex app-server process host is not configured');
  },
});
