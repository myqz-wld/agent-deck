import { settingsStore } from '@main/store/settings-store';
import { getAgentDeckCodexDeveloperInstructions } from '@main/codex-config/agents-md-installer';
import {
  readTopLevelModelFromCodexConfig,
  readTopLevelModelReasoningEffortFromCodexConfig,
} from '@main/codex-config/toml-writer';
import { resolveSpawnCwd } from '@main/utils/cwd-resolver';
import { CODEX_DEFAULT_BUCKET } from '@shared/model-normalize';
import { MAX_MESSAGE_LENGTH } from '../constants';
import type { CreateSessionOpts } from '../create-session/_deps';
import { resolveCodexReasoningEffort } from '../create-session/reasoning-effort-resolve';
import {
  buildCodexThreadOptions,
  type CodexThreadOptions,
} from '../thread-options-builder';

export interface CodexForkTargetRuntime {
  cwd: string;
  sandboxMode: 'workspace-write' | 'read-only' | 'danger-full-access';
  threadOptions: CodexThreadOptions;
  effectiveDeveloperInstructions?: string;
  persistedModel: string;
  persistedReasoningEffort?: CreateSessionOpts['modelReasoningEffort'];
}

export function resolveCodexForkTargetRuntime(
  opts: CreateSessionOpts,
): CodexForkTargetRuntime {
  if (!opts.prompt || !opts.prompt.trim()) {
    throw new Error('Codex native fork requires a non-empty delegated prompt.');
  }
  if (opts.prompt.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Codex native fork prompt exceeds the ${MAX_MESSAGE_LENGTH.toLocaleString()} character limit.`,
    );
  }

  const cwd = resolveSpawnCwd(opts);
  const sandboxMode = opts.codexSandbox ?? settingsStore.get('codexSandbox');
  const hasReasoningConfigLayer =
    opts.codexConfigOverrides !== undefined &&
    (Object.prototype.hasOwnProperty.call(opts.codexConfigOverrides, 'profile') ||
      Object.prototype.hasOwnProperty.call(opts.codexConfigOverrides, 'model_reasoning_effort'));
  const reasoning = resolveCodexReasoningEffort({
    explicit: opts.modelReasoningEffort,
    isResume: false,
    persisted: null,
    hasLayerOverride: hasReasoningConfigLayer,
    readConfigured: readTopLevelModelReasoningEffortFromCodexConfig,
  });
  const effectiveDeveloperInstructions = combineCodexDeveloperInstructions(
    getAgentDeckCodexDeveloperInstructions(),
    opts.developerInstructions,
  );
  return {
    cwd,
    sandboxMode,
    effectiveDeveloperInstructions,
    persistedModel: opts.model ?? readTopLevelModelFromCodexConfig() ?? CODEX_DEFAULT_BUCKET,
    persistedReasoningEffort: reasoning.sessionValue,
    threadOptions: buildCodexThreadOptions({
      workingDirectory: cwd,
      sandboxMode,
      approvalPolicy: opts.approvalPolicy,
      model: opts.model,
      modelReasoningEffort: reasoning.threadValue,
      developerInstructions: effectiveDeveloperInstructions,
      configOverrides: opts.codexConfigOverrides,
      networkAccessEnabled: opts.networkAccessEnabled,
      additionalDirectories: opts.additionalDirectories,
    }),
  };
}

export function combineCodexDeveloperInstructions(
  ...parts: Array<string | undefined>
): string | undefined {
  const filtered = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
  return filtered.length > 0 ? filtered.join('\n\n---\n\n') : undefined;
}
