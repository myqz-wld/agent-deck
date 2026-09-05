import { join } from 'node:path';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
  isGrokThinkingLevel,
  type CodexThinkingLevel,
  type SessionThinkingLevel,
} from '@shared/session-metadata';
import {
  isCodexApprovalPolicy,
  type AppSettings,
  type CodexApprovalPolicy,
  type SessionAdapterId,
  type SessionCreationDefaults,
} from '@shared/types';
import type { ResolvedClaudeGatewayProfile } from './claude-code/sdk-bridge/session-defaults-core';
import {
  readBoundedConfigText,
  type SessionConfigDiagnostic,
  type SessionConfigReadObservation,
  type SessionConfigResolutionSource,
} from './session-creation-config-reader';

export type SessionCreationConfigRecord = Record<string, unknown>;
export type SessionCreationSettings = Pick<
  AppSettings,
  'claudeCodeSandbox' | 'codexSandbox' | 'grokSandbox'
>;

export interface SessionCreationResolveOptions {
  cwd: string;
  provider?: string;
}

export interface SessionCreationCoreDeps {
  settings: SessionCreationSettings;
  userHome?: string;
  readCodexConfig: (
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<SessionCreationConfigRecord>;
  resolveClaudeProfile?: (
    provider: string | null | undefined,
  ) => ResolvedClaudeGatewayProfile | null;
  codexConfigPath?: string;
  grokConfigPath?: string;
  readConfigFile?: (
    path: string,
    signal: AbortSignal,
  ) => Promise<string | Uint8Array>;
  configReadTimeoutMs?: number;
  configMaxBytes?: number;
  onDiagnostic?: (diagnostic: SessionConfigDiagnostic) => void;
  onConfigReadObservation?: (observation: SessionConfigReadObservation) => void;
}

export interface SessionCreationDefaultsHost {
  userHome(): string;
  anthropicModel(): string | undefined;
  codexConfigPath(): string;
  resolveCodexGatewayProfile(provider: string): {
    id: string;
    configOverrides: SessionCreationConfigRecord;
    defaultModel?: string;
    defaultThinking?: CodexThinkingLevel;
    defaultApproval?: CodexApprovalPolicy;
  } | null;
  claudeGatewaySettingsPath(provider: string, gatewaysDir: string): string;
}

type ConfigRecord = SessionCreationConfigRecord;
type ResolveOptions = SessionCreationResolveOptions;
type ResolveDeps = SessionCreationCoreDeps;

export const CODEX_CREATION_DEFAULTS_TIMEOUT_MS = 1_000;

const BASE_DEFAULTS: SessionCreationDefaults = {
  provider: '',
  model: '',
  thinking: 'high',
  permissionMode: 'bypassPermissions',
  sessionMode: 'default',
  approvalPolicy: 'never',
  codexSandbox: 'workspace-write',
  claudeCodeSandbox: 'workspace-write',
  grokSandbox: 'workspace',
};

/**
 * Resolve the concrete values shown by new-session UIs. Native configuration remains authoritative
 * when the user later clears the free-text model field; this snapshot only avoids presenting
 * "follow default" as a selectable value.
 */
export async function resolveSessionCreationDefaultsCore(
  adapterId: SessionAdapterId,
  options: ResolveOptions,
  deps: ResolveDeps,
  host: SessionCreationDefaultsHost,
): Promise<SessionCreationDefaults> {
  const settings = deps.settings;
  const base: SessionCreationDefaults = {
    ...BASE_DEFAULTS,
    codexSandbox: settings.codexSandbox,
    claudeCodeSandbox: settings.claudeCodeSandbox,
    grokSandbox: normalizeGrokSandbox(settings.grokSandbox),
  };

  if (adapterId === 'claude-code') {
    return resolveClaudeDefaults(base, options, deps, host);
  }
  if (adapterId === 'codex-cli') {
    return resolveCodexDefaults(base, options, deps, host);
  }
  return resolveGrokDefaults(base, deps, host);
}

async function resolveClaudeDefaults(
  base: SessionCreationDefaults,
  options: ResolveOptions,
  deps: ResolveDeps,
  host: SessionCreationDefaultsHost,
): Promise<SessionCreationDefaults> {
  const userHome = deps.userHome ?? host.userHome();
  const requestedProvider = options.provider?.trim() ?? '';
  let profile: ResolvedClaudeGatewayProfile | null = null;
  if (requestedProvider && deps.resolveClaudeProfile) {
    try {
      profile = deps.resolveClaudeProfile(requestedProvider);
    } catch {
      emitDiagnostic(deps, {
        resolutionSource: 'claude-gateway',
        failureCategory: 'invalid',
      });
    }
  }

  let gatewaySettingsPath = profile?.settingsPath;
  if (requestedProvider && !gatewaySettingsPath) {
    try {
      gatewaySettingsPath = host.claudeGatewaySettingsPath(
        requestedProvider,
        join(userHome, '.claude', 'gateways'),
      );
    } catch {
      emitDiagnostic(deps, {
        resolutionSource: 'claude-gateway',
        failureCategory: 'invalid',
      });
    }
  }
  const userSettingsPath = join(userHome, '.claude', 'settings.json');
  const projectSettingsPath = join(options.cwd, '.claude', 'settings.json');
  const localSettingsPath = join(options.cwd, '.claude', 'settings.local.json');
  const pathSpecs = [
    ...(gatewaySettingsPath
      ? [{ path: gatewaySettingsPath, source: 'claude-gateway' as const }]
      : []),
    { path: userSettingsPath, source: 'claude-settings' as const },
    { path: projectSettingsPath, source: 'claude-settings' as const },
    { path: localSettingsPath, source: 'claude-settings' as const },
  ];
  const uniquePaths = pathSpecs.filter(
    ({ path }, index) => pathSpecs.findIndex((entry) => entry.path === path) === index,
  );
  const records = await Promise.all(
    uniquePaths.map(async ({ path, source }) => ({
      path,
      record: await readJsonRecord(path, source, deps),
    })),
  );
  const gatewayRecord = gatewaySettingsPath
    ? records.find(({ path }) => path === gatewaySettingsPath)?.record
    : null;
  const useGatewaySettings = profile !== null || gatewayRecord !== null;
  const configuredPaths =
    useGatewaySettings && gatewaySettingsPath
      ? [gatewaySettingsPath, projectSettingsPath, localSettingsPath]
      : [userSettingsPath, projectSettingsPath, localSettingsPath];
  const configured = readClaudeSettings(
    configuredPaths.map(
      (path) => records.find((entry) => entry.path === path)?.record ?? null,
    ),
  );
  const gatewayEnv = isRecord(gatewayRecord?.env) ? gatewayRecord.env : {};
  const model =
    profile?.defaultModel ??
    nonBlank(gatewayEnv.ANTHROPIC_MODEL) ??
    configured.model ??
    nonBlank(host.anthropicModel()) ??
    'sonnet';

  return {
    ...base,
    provider: requestedProvider,
    model,
    thinking: configured.thinking ?? 'high',
  };
}

async function resolveCodexDefaults(
  base: SessionCreationDefaults,
  options: ResolveOptions,
  deps: ResolveDeps,
  host: SessionCreationDefaultsHost,
): Promise<SessionCreationDefaults> {
  const configPath = deps.codexConfigPath ?? host.codexConfigPath();
  const requestedProvider = options.provider?.trim() || undefined;
  const gateway = requestedProvider
    ? host.resolveCodexGatewayProfile(requestedProvider)
    : null;
  const [config, fileContent] = gateway
    ? [gateway.configOverrides, null] as const
    : await Promise.all([
        readBoundedCodexConfig(options.cwd, deps),
        readConfigText(configPath, 'codex-config', deps),
      ]);

  const provider = gateway?.id ?? '';
  const model =
    gateway?.defaultModel ??
    nonBlank(config.model) ??
    readTopLevelQuotedString(fileContent, 'model') ??
    '';
  const configuredThinking = config.model_reasoning_effort;
  const fileThinking = readTopLevelQuotedString(fileContent, 'model_reasoning_effort');
  const thinking = gateway?.defaultThinking ??
    (isCodexThinkingLevel(configuredThinking)
      ? configuredThinking
      : isCodexThinkingLevel(fileThinking)
        ? fileThinking
        : 'high');
  const configuredApproval = config.approval_policy;
  const fileApproval = readTopLevelQuotedString(fileContent, 'approval_policy');

  return {
    ...base,
    provider,
    model,
    thinking,
    approvalPolicy: gateway?.defaultApproval ?? (isCodexApprovalPolicy(configuredApproval)
      ? configuredApproval
      : isCodexApprovalPolicy(fileApproval)
        ? fileApproval
        : 'never'),
  };
}

async function resolveGrokDefaults(
  base: SessionCreationDefaults,
  deps: ResolveDeps,
  host: SessionCreationDefaultsHost,
): Promise<SessionCreationDefaults> {
  const configPath =
    deps.grokConfigPath ?? join(deps.userHome ?? host.userHome(), '.grok', 'config.toml');
  const content = await readConfigText(configPath, 'grok-config', deps);
  const model = readTopLevelQuotedString(content, 'model') ?? 'grok-4.6';
  const configuredThinking = readTopLevelQuotedString(content, 'reasoning_effort');
  return {
    ...base,
    model,
    thinking: isGrokThinkingLevel(configuredThinking) ? configuredThinking : 'high',
  };
}

function readClaudeSettings(records: Array<ConfigRecord | null>): {
  model?: string;
  thinking?: SessionThinkingLevel;
} {
  let model: string | undefined;
  let envModel: string | undefined;
  let thinking: SessionThinkingLevel | undefined;
  for (const parsed of records) {
    if (!parsed) continue;
    model = nonBlank(parsed.model) ?? model;
    const env = isRecord(parsed.env) ? parsed.env : {};
    envModel = nonBlank(env.ANTHROPIC_MODEL) ?? envModel;
    const effort = parsed.effortLevel;
    if (isClaudeThinkingLevel(effort)) thinking = effort;
  }
  const effectiveModel = model ?? envModel;
  return {
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

async function readJsonRecord(
  path: string,
  resolutionSource: SessionConfigResolutionSource,
  deps: ResolveDeps,
): Promise<ConfigRecord | null> {
  const content = await readConfigText(path, resolutionSource, deps);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // Report below with the same path-free allowlisted diagnostic.
  }
  emitDiagnostic(deps, { resolutionSource, failureCategory: 'invalid' });
  return null;
}

function readTopLevelQuotedString(content: string | null, key: string): string | null {
  if (content === null) return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignment = new RegExp(
    `^${escapedKey}[ \\t]*=[ \\t]*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`,
  );
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    const match = assignment.exec(line);
    if (!match) continue;
    if (match[1].startsWith("'")) return match[1].slice(1, -1);
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      return null;
    }
  }
  return null;
}

async function readConfigText(
  path: string,
  resolutionSource: SessionConfigResolutionSource,
  deps: ResolveDeps,
): Promise<string | null> {
  const result = await readBoundedConfigText(path, {
    resolutionSource,
    ...(deps.readConfigFile ? { readFile: deps.readConfigFile } : {}),
    ...(deps.configReadTimeoutMs !== undefined
      ? { timeoutMs: deps.configReadTimeoutMs }
      : {}),
    ...(deps.configMaxBytes !== undefined ? { maxBytes: deps.configMaxBytes } : {}),
    onDiagnostic: (diagnostic) => emitDiagnostic(deps, diagnostic),
    onObservation: deps.onConfigReadObservation,
  });
  return result.ok ? result.text : null;
}

async function readBoundedCodexConfig(
  cwd: string,
  deps: ResolveDeps,
): Promise<ConfigRecord> {
  // The race fences pre-client acquisition and injected readers. The same deadline controller is
  // threaded into B6's client.request, so an active provider RPC is aborted and its generation is
  // retired instead of surviving behind this terminal fallback.
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ConfigRecord>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      emitDiagnostic(deps, {
        resolutionSource: 'codex-app-server',
        failureCategory: 'timeout',
      });
      controller.abort();
      resolve({});
    }, CODEX_CREATION_DEFAULTS_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const config = await Promise.race([
      deps.readCodexConfig(cwd, controller.signal),
      timeout,
    ]);
    if (!isRecord(config)) {
      emitDiagnostic(deps, {
        resolutionSource: 'codex-app-server',
        failureCategory: 'invalid',
      });
      return {};
    }
    return config;
  } catch {
    if (!timedOut) {
      emitDiagnostic(deps, {
        resolutionSource: 'codex-app-server',
        failureCategory: 'unreadable',
      });
    }
    return {};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function emitDiagnostic(
  deps: ResolveDeps,
  diagnostic: SessionConfigDiagnostic,
): void {
  try {
    deps.onDiagnostic?.(diagnostic);
  } catch {
    // Host diagnostics cannot make default resolution fail.
  }
}

function normalizeGrokSandbox(value: string | null): string {
  return nonBlank(value) ?? 'workspace';
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is ConfigRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
