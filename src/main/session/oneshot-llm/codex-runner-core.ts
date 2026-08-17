import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toCodexModelOverride } from '@main/adapters/codex-cli/sdk-model';
import { toCodexAppServerInput } from '@main/adapters/codex-cli/sdk-bridge/input-pack';
import type { CodexThreadOptions } from '@main/adapters/codex-cli/sdk-bridge/thread-options-builder';
import type { ResolvedCodexGatewayProfile } from '@main/codex-config/gateway-profiles-core';
import { DISABLED_EXECUTABLE_FEATURES } from '@main/session/continuation-context/codex-isolation';
import type { CodexThinkingLevel } from '@shared/session-metadata';
import { buildSummarizeSystemPrompt } from './build-prompt';
import { raceWithTimeout } from './race-with-timeout';

export interface CodexOneshotOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  modelReasoningEffort?: CodexThinkingLevel;
  model?: string;
  provider?: string;
  timeoutMs: number;
  timeoutErrorMessage: string;
  signal?: AbortSignal;
}

export interface CodexOneshotClient {
  startThread(options: CodexThreadOptions): {
    run(
      input: ReturnType<typeof toCodexAppServerInput>,
      options: { signal: AbortSignal },
    ): Promise<{ finalResponse: string }>;
  };
}

export interface CodexOneshotHost {
  readonly getInstance: () => Promise<CodexOneshotClient>;
  readonly resolveGatewayProfile?: (
    gateway: string | null | undefined,
  ) => ResolvedCodexGatewayProfile | null;
  readonly releaseInstance?: (instance: CodexOneshotClient) => void;
  readonly createIsolatedCwd?: () => string;
}

/** Host-neutral no-tool Codex oneshot shared by Desktop and Server Core. */
export async function runCodexOneshotWithHost(
  opts: CodexOneshotOptions,
  host: CodexOneshotHost,
): Promise<string> {
  const controller = new AbortController();
  const isolatedCwd = host.createIsolatedCwd?.() ??
    mkdtempSync(join(tmpdir(), 'agent-deck-periodic-summary-'));
  let instance: CodexOneshotClient | null = null;
  const work = (async () => {
    const codex = await host.getInstance();
    instance = codex;
    const gateway = host.resolveGatewayProfile?.(opts.provider) ?? null;
    const model = toCodexModelOverride(opts.model ?? gateway?.defaultModel);
    const thinking = opts.modelReasoningEffort ?? gateway?.defaultThinking;
    const thread = codex.startThread({
      workingDirectory: isolatedCwd,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      ...(thinking ? { modelReasoningEffort: thinking } : {}),
      modelReasoningSummary: 'none',
      baseInstructions: opts.systemPrompt ?? buildSummarizeSystemPrompt('Agent'),
      configOverrides: {
        features: { ...DISABLED_EXECUTABLE_FEATURES },
        mcp_servers: {},
      },
      gatewayConfigOverrides: gateway?.configOverrides,
      useBaseConfig: false,
      networkAccessEnabled: false,
      additionalDirectories: [],
      dynamicTools: [],
      environments: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      ephemeral: true,
      ...(gateway?.modelProvider ? { modelProvider: gateway.modelProvider } : {}),
      ...(model !== undefined ? { model } : {}),
    });
    return thread.run(toCodexAppServerInput(opts.prompt), { signal: controller.signal });
  })();
  try {
    const result = await raceWithTimeout({
      work,
      timeoutMs: opts.timeoutMs,
      errorMessage: opts.timeoutErrorMessage,
      onTimeout: () => controller.abort(),
      signal: opts.signal,
      onAbort: () => controller.abort(),
    });
    return result.finalResponse;
  } finally {
    if (instance) host.releaseInstance?.(instance);
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}
