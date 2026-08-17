import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toCodexModelOverride } from '@main/adapters/codex-cli/sdk-model';
import { toCodexAppServerInput } from '@main/adapters/codex-cli/sdk-bridge/input-pack';
import type { CodexThreadOptions } from '@main/adapters/codex-cli/sdk-bridge/thread-options-builder';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
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
  readonly resolveProviderConfigOverrides?: (
    provider: string | null | undefined,
  ) => CodexConfigObject | null;
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
    const model = toCodexModelOverride(opts.model);
    const providerConfigOverrides = host.resolveProviderConfigOverrides?.(opts.provider) ?? null;
    const thread = codex.startThread({
      workingDirectory: isolatedCwd,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      ...(opts.modelReasoningEffort
        ? { modelReasoningEffort: opts.modelReasoningEffort }
        : {}),
      modelReasoningSummary: 'none',
      baseInstructions: opts.systemPrompt ?? buildSummarizeSystemPrompt('Agent'),
      configOverrides: {
        ...(providerConfigOverrides ?? {}),
        features: { ...DISABLED_EXECUTABLE_FEATURES },
        mcp_servers: {},
        ...(opts.provider ? { model_provider: opts.provider } : {}),
      },
      useBaseConfig: false,
      networkAccessEnabled: false,
      additionalDirectories: [],
      dynamicTools: [],
      environments: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      ephemeral: true,
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
