import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { CodexAppServerUserInput, JsonObject, JsonValue } from './protocol';

export function buildThreadStartParams(
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  return buildThreadCommonParams(options, baseConfig);
}

export function buildThreadResumeParams(
  threadId: string,
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  return {
    threadId,
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
    approvalPolicy: options.approvalPolicy ?? 'never',
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.developerInstructions !== undefined
      ? { developerInstructions: options.developerInstructions }
      : {}),
    config: buildThreadConfig(options, baseConfig),
  };
}

export const __testables = {
  buildThreadStartParams,
  buildThreadResumeParams,
  buildTurnStartParams,
  buildThreadConfig,
};

export function buildThreadConfig(
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): JsonObject {
  const config = cloneConfig(baseConfig);
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
): JsonObject {
  const effectiveConfig = buildThreadConfig(options, baseConfig);
  return {
    threadId,
    input,
    cwd: options.workingDirectory,
    approvalPolicy: options.approvalPolicy ?? 'never',
    sandboxPolicy: buildSandboxPolicy(options, effectiveConfig),
    ...(options.model !== undefined ? { model: options.model } : {}),
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
