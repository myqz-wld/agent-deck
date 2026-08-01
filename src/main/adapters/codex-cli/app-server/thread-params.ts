import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { CodexAppServerUserInput, JsonObject, JsonValue } from './protocol';

export function buildThreadStartParams(
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  return {
    ...buildThreadCommonParams(options, baseConfig),
    ...(options.baseInstructions !== undefined
      ? { baseInstructions: options.baseInstructions }
      : {}),
    ...(options.dynamicTools !== undefined ? { dynamicTools: [] } : {}),
    ...(options.environments !== undefined ? { environments: [] } : {}),
    ...(options.runtimeWorkspaceRoots !== undefined
      ? { runtimeWorkspaceRoots: [...options.runtimeWorkspaceRoots] }
      : {}),
    ...(options.selectedCapabilityRoots !== undefined
      ? { selectedCapabilityRoots: [] }
      : {}),
    ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
    // Codex app-server filters RawResponseItem events unless each new thread opts in.
    // Those events are the only complete source for MultiAgentV2 collaboration calls.
    experimentalRawEvents: true,
  };
}

export function buildThreadResumeParams(
  threadId: string,
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  return {
    threadId,
    // Agent Deck restores its own persisted projection and does not consume
    // historical turns from this response. Suppress app-server's immediate
    // restored token-usage replay so previously persisted `last` usage cannot
    // be inserted a second time after resume/recycle.
    excludeTurns: true,
    ...buildThreadCommonParams(options, baseConfig),
  };
}

export function buildThreadForkParams(
  threadId: string,
  lastTurnId: string,
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  return {
    threadId,
    lastTurnId,
    // Fork startup likewise does not consume the restored turn projection.
    // Excluding it prevents historical token usage from being replayed as live.
    excludeTurns: true,
    ...buildThreadCommonParams(options, baseConfig),
  };
}

function buildThreadCommonParams(
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  return {
    cwd: options.workingDirectory,
    sandbox: options.sandboxMode,
    ...(options.approvalPolicy !== undefined
      ? { approvalPolicy: options.approvalPolicy }
      : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.modelProvider !== undefined
      ? { modelProvider: options.modelProvider }
      : {}),
    ...(options.developerInstructions !== undefined
      ? { developerInstructions: options.developerInstructions }
      : {}),
    config: buildThreadConfig(options, baseConfig),
  };
}

export function buildThreadConfig(
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  const config = options.useBaseConfig === false ? {} : cloneConfig(baseConfig);
  mergeJsonObject(config, cloneConfig(options.configOverrides ?? null));
  if (options.skipGitRepoCheck) {
    config.skip_git_repo_check = true;
  }
  if (options.modelReasoningEffort !== undefined) {
    config.model_reasoning_effort = options.modelReasoningEffort;
  }
  if (
    options.modelReasoningSummary !== undefined &&
    config.model_reasoning_summary === undefined
  ) {
    config.model_reasoning_summary = options.modelReasoningSummary;
  }
  if (options.networkAccessEnabled !== undefined || options.additionalDirectories !== undefined) {
    const workspace =
      config.sandbox_workspace_write &&
      typeof config.sandbox_workspace_write === 'object' &&
      !Array.isArray(config.sandbox_workspace_write)
        ? { ...(config.sandbox_workspace_write as JsonObject) }
        : {};
    if (options.networkAccessEnabled !== undefined) {
      workspace.network_access = options.networkAccessEnabled;
    }
    if (options.additionalDirectories !== undefined) {
      workspace.writable_roots = [...options.additionalDirectories];
    }
    config.sandbox_workspace_write = workspace;
  }
  return config;
}

export function buildTurnStartParams(
  threadId: string,
  input: CodexAppServerUserInput[],
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
  turnOptions: {
    outputSchema?: JsonObject;
    environments?: readonly [];
    runtimeWorkspaceRoots?: readonly string[];
  } = {},
): JsonObject {
  const effectiveConfig = buildThreadConfig(options, baseConfig);
  return {
    threadId,
    input,
    cwd: options.workingDirectory,
    ...(options.approvalPolicy !== undefined
      ? { approvalPolicy: options.approvalPolicy }
      : {}),
    sandboxPolicy: buildSandboxPolicy(options, effectiveConfig),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.modelReasoningEffort !== undefined
      ? { effort: options.modelReasoningEffort }
      : {}),
    ...(turnOptions.outputSchema !== undefined
      ? { outputSchema: turnOptions.outputSchema }
      : {}),
    ...(turnOptions.environments !== undefined ? { environments: [] } : {}),
    ...(turnOptions.runtimeWorkspaceRoots !== undefined
      ? { runtimeWorkspaceRoots: [...turnOptions.runtimeWorkspaceRoots] }
      : {}),
  };
}

function buildSandboxPolicy(
  options: CodexThreadOptions,
  config: JsonObject,
): JsonObject {
  const networkAccess = resolveNetworkAccess(options, config);
  if (options.sandboxMode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }
  if (options.sandboxMode === 'read-only') {
    return { type: 'readOnly', networkAccess };
  }
  const workspaceConfig = readWorkspaceWriteConfig(config);
  return {
    type: 'workspaceWrite',
    writableRoots:
      options.additionalDirectories !== undefined
        ? [...options.additionalDirectories]
        : readStringArray(workspaceConfig.writable_roots),
    networkAccess,
    excludeTmpdirEnvVar: readBoolean(workspaceConfig.exclude_tmpdir_env_var) ?? false,
    excludeSlashTmp: readBoolean(workspaceConfig.exclude_slash_tmp) ?? false,
  };
}

function resolveNetworkAccess(
  options: CodexThreadOptions,
  config: JsonObject,
): boolean {
  if (options.networkAccessEnabled !== undefined) return options.networkAccessEnabled;
  return readBoolean(readWorkspaceWriteConfig(config).network_access) ?? false;
}

function readWorkspaceWriteConfig(config: JsonObject | CodexConfigObject | null): JsonObject {
  const value = (config as JsonObject | null)?.sandbox_workspace_write;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function readStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readBoolean(value: JsonValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function cloneConfig(config: CodexConfigObject | null): JsonObject {
  if (!config) return {};
  return JSON.parse(JSON.stringify(config)) as JsonObject;
}

function mergeJsonObject(target: JsonObject, override: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = target[key];
    if (isPlainJsonObject(existing) && isPlainJsonObject(value)) {
      target[key] = mergeJsonObject({ ...existing }, value);
      continue;
    }
    target[key] = value;
  }
  return target;
}

function isPlainJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
