import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
  isGrokThinkingLevel,
  type SessionThinkingLevel,
} from '@shared/session-metadata';
import {
  isCodexApprovalPolicy,
  type AppSettings,
  type SessionAdapterId,
  type SessionCreationDefaults,
} from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { getCodexConfigPath } from '@main/codex-config/toml-writer';
import { resolveCodexConfigProfile } from '@main/codex-config/profiles';
import {
  claudeGatewaySettingsPath,
  type ResolvedClaudeGatewayProfile,
} from './claude-code/gateway-profiles';
import { getCodexInstance } from './codex-cli/codex-instance-pool';
import log from '@main/utils/logger';
import {
  readBoundedConfigText,
  type SessionConfigDiagnostic,
  type SessionConfigResolutionSource,
} from './session-creation-config-reader';

type ConfigRecord = Record<string, unknown>;
type CreationSettings = Pick<
  AppSettings,
  'claudeCodeSandbox' | 'codexSandbox' | 'grokSandbox'
>;

interface ResolveOptions {
  cwd: string;
  provider?: string;
}

interface ResolveDeps {
  settings?: CreationSettings;
  userHome?: string;
  readCodexConfig?: (
    cwd: string,
    signal?: AbortSignal,
    profile?: string,
  ) => Promise<ConfigRecord>;
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
}

const logger = log.scope('session-creation-defaults');
export const CODEX_CREATION_DEFAULTS_TIMEOUT_MS = 1_000;

const BASE_DEFAULTS: SessionCreationDefaults = {
  provider: '',
  model: '',
  thinking: 'high',
  permissionMode: 'bypassPermissions',
  sessionMode: 'default',
  approvalPolicy: 'on-request',
  codexSandbox: 'workspace-write',
  claudeCodeSandbox: 'workspace-write',
  grokSandbox: 'workspace',
};

/**
 * Resolve the concrete values shown by new-session UIs. Native configuration remains authoritative
 * when the user later clears the free-text model field; this snapshot only avoids presenting
 * "follow default" as a selectable value.
 */
export async function resolveSessionCreationDefaults(
  adapterId: SessionAdapterId,
  options: ResolveOptions,
  deps: ResolveDeps = {},
): Promise<SessionCreationDefaults> {
  const settings = deps.settings ?? settingsStore.getAll();
  const base: SessionCreationDefaults = {
    ...BASE_DEFAULTS,
    codexSandbox: settings.codexSandbox,
    claudeCodeSandbox: settings.claudeCodeSandbox,
    grokSandbox: normalizeGrokSandbox(settings.grokSandbox),
  };

  if (adapterId === 'claude-code') {
    return resolveClaudeDefaults(base, options, deps);
  }
  if (adapterId === 'codex-cli') {
    return resolveCodexDefaults(base, options, deps);
  }
  return resolveGrokDefaults(base, deps);
}

async function resolveClaudeDefaults(
  base: SessionCreationDefaults,
  options: ResolveOptions,
  deps: ResolveDeps,
): Promise<SessionCreationDefaults> {
  const userHome = deps.userHome ?? homedir();
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
      gatewaySettingsPath = claudeGatewaySettingsPath(requestedProvider, {
        gatewaysDir: join(userHome, '.claude', 'gateways'),
      });
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
    nonBlank(process.env.ANTHROPIC_MODEL) ??
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
): Promise<SessionCreationDefaults> {
  const configPath = deps.codexConfigPath ?? getCodexConfigPath();
  const requestedProfile = options.provider?.trim() || '';
  const profile = requestedProfile
    ? resolveCodexConfigProfile(requestedProfile, { codexHome: dirname(configPath) })
    : null;
  const [config, fileContent, profileContent] = await Promise.all([
    readBoundedCodexConfig(options.cwd, deps, profile?.id),
    readConfigText(configPath, 'codex-config', deps),
    profile
      ? readConfigText(profile.configPath, 'codex-config', deps)
      : Promise.resolve(null),
  ]);

  const model =
    nonBlank(config.model) ??
    readTopLevelQuotedString(profileContent, 'model') ??
    readTopLevelQuotedString(fileContent, 'model') ??
    '';
  const configuredThinking = config.model_reasoning_effort;
  const fileThinking =
    readTopLevelQuotedString(profileContent, 'model_reasoning_effort') ??
    readTopLevelQuotedString(fileContent, 'model_reasoning_effort');
  const thinking = isCodexThinkingLevel(configuredThinking)
    ? configuredThinking
    : isCodexThinkingLevel(fileThinking)
      ? fileThinking
      : 'high';
  const configuredApproval = config.approval_policy;
  const fileApproval =
    readTopLevelQuotedString(profileContent, 'approval_policy') ??
    readTopLevelQuotedString(fileContent, 'approval_policy');

  return {
    ...base,
    provider: requestedProfile,
    model,
    thinking,
    approvalPolicy: isCodexApprovalPolicy(configuredApproval)
      ? configuredApproval
      : isCodexApprovalPolicy(fileApproval)
        ? fileApproval
        : 'on-request',
  };
}

async function resolveGrokDefaults(
  base: SessionCreationDefaults,
  deps: ResolveDeps,
): Promise<SessionCreationDefaults> {
  const configPath =
    deps.grokConfigPath ?? join(deps.userHome ?? homedir(), '.grok', 'config.toml');
  const content = await readConfigText(configPath, 'grok-config', deps);
  const model = readTopLevelQuotedString(content, 'model') ?? 'grok-4.5';
  const configuredThinking = readTopLevelQuotedString(content, 'reasoning_effort');
  return {
    ...base,
    model,
    thinking: isGrokThinkingLevel(configuredThinking) ? configuredThinking : 'high',
  };
}

async function readEffectiveCodexConfig(
  cwd: string,
  signal?: AbortSignal,
  profile?: string,
): Promise<ConfigRecord> {
  const client = await getCodexInstance(profile);
  const response = await client.request<{ config?: unknown }>(
    'config/read',
    { includeLayers: false, cwd },
    signal,
  );
  return isRecord(response.config) ? response.config : {};
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
  });
  return result.ok ? result.text : null;
}

async function readBoundedCodexConfig(
  cwd: string,
  deps: ResolveDeps,
  profile?: string,
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
      (deps.readCodexConfig ?? readEffectiveCodexConfig)(
        cwd,
        controller.signal,
        profile,
      ),
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
    if (deps.onDiagnostic) {
      deps.onDiagnostic(diagnostic);
      return;
    }
    const message = '[session-creation-defaults] config fallback';
    if (diagnostic.failureCategory === 'not-found') {
      logger.debug(message, diagnostic);
    } else {
      logger.warn(message, diagnostic);
    }
  } catch {
    // Logging and test diagnostics cannot make default resolution fail.
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
