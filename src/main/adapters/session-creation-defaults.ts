import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import {
  getCodexConfigPath,
  readTopLevelModelFromCodexConfig,
  readTopLevelModelProviderFromCodexConfig,
  readTopLevelModelReasoningEffortFromCodexConfig,
} from '@main/codex-config/toml-writer';
import {
  resolveClaudeGatewayProfile,
  type ResolvedClaudeGatewayProfile,
} from './claude-code/gateway-profiles';
import { getCodexInstance } from './codex-cli/codex-instance-pool';

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
  readCodexConfig?: (cwd: string) => Promise<ConfigRecord>;
  resolveClaudeProfile?: (
    provider: string | null | undefined,
  ) => ResolvedClaudeGatewayProfile | null;
  codexConfigPath?: string;
  grokConfigPath?: string;
}

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

function resolveClaudeDefaults(
  base: SessionCreationDefaults,
  options: ResolveOptions,
  deps: ResolveDeps,
): SessionCreationDefaults {
  const userHome = deps.userHome ?? homedir();
  const requestedProvider = options.provider?.trim() ?? '';
  let profile: ResolvedClaudeGatewayProfile | null = null;
  if (requestedProvider) {
    try {
      profile = (deps.resolveClaudeProfile ?? resolveClaudeGatewayProfile)(requestedProvider);
    } catch {
      // Keep a just-entered provider visible while its profile is incomplete or being edited.
    }
  }

  const settingsPaths = profile
    ? [
        profile.settingsPath,
        join(options.cwd, '.claude', 'settings.json'),
        join(options.cwd, '.claude', 'settings.local.json'),
      ]
    : [
        join(userHome, '.claude', 'settings.json'),
        join(options.cwd, '.claude', 'settings.json'),
        join(options.cwd, '.claude', 'settings.local.json'),
      ];
  const configured = readClaudeSettings(settingsPaths);
  const model =
    profile?.defaultModel ??
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
  let config: ConfigRecord = {};
  try {
    config = await (deps.readCodexConfig ?? readEffectiveCodexConfig)(options.cwd);
  } catch {
    // File readers below preserve the useful top-level values if app-server is unavailable.
  }

  const requestedProvider = options.provider?.trim();
  const provider =
    requestedProvider ||
    nonBlank(config.model_provider) ||
    readTopLevelModelProviderFromCodexConfig(configPath) ||
    '';
  const model =
    nonBlank(config.model) ??
    readTopLevelModelFromCodexConfig(configPath) ??
    '';
  const configuredThinking = config.model_reasoning_effort;
  const fileThinking = readTopLevelModelReasoningEffortFromCodexConfig(configPath);
  const thinking = isCodexThinkingLevel(configuredThinking)
    ? configuredThinking
    : fileThinking ?? 'high';
  const configuredApproval = config.approval_policy;
  // If app-server config/read is temporarily unavailable, retain the top-level global policy.
  // An active profile may override it, so do not present the base value as effective in that case.
  const fileApproval =
    readTopLevelQuotedString(configPath, 'profile') === null
      ? readTopLevelQuotedString(configPath, 'approval_policy')
      : null;

  return {
    ...base,
    provider,
    model,
    thinking,
    approvalPolicy: isCodexApprovalPolicy(configuredApproval)
      ? configuredApproval
      : isCodexApprovalPolicy(fileApproval)
        ? fileApproval
        : 'on-request',
  };
}

function resolveGrokDefaults(
  base: SessionCreationDefaults,
  deps: ResolveDeps,
): SessionCreationDefaults {
  const configPath =
    deps.grokConfigPath ?? join(deps.userHome ?? homedir(), '.grok', 'config.toml');
  const model = readTopLevelQuotedString(configPath, 'model') ?? 'grok-4.5';
  const configuredThinking =
    readTopLevelQuotedString(configPath, 'reasoning_effort') ??
    readTopLevelQuotedString(configPath, 'effort');
  return {
    ...base,
    model,
    thinking: isGrokThinkingLevel(configuredThinking) ? configuredThinking : 'high',
  };
}

async function readEffectiveCodexConfig(cwd: string): Promise<ConfigRecord> {
  const client = await getCodexInstance();
  const response = await client.request<{ config?: unknown }>(
    'config/read',
    { includeLayers: false, cwd },
  );
  return isRecord(response.config) ? response.config : {};
}

function readClaudeSettings(paths: string[]): {
  model?: string;
  thinking?: SessionThinkingLevel;
} {
  let model: string | undefined;
  let envModel: string | undefined;
  let thinking: SessionThinkingLevel | undefined;
  for (const path of [...new Set(paths)]) {
    const parsed = readJsonRecord(path);
    if (!parsed) continue;
    model = nonBlank(parsed.model) ?? model;
    const env = isRecord(parsed.env) ? parsed.env : {};
    envModel = nonBlank(env.ANTHROPIC_MODEL) ?? envModel;
    const effort = parsed.effortLevel ?? parsed.effort;
    if (isClaudeThinkingLevel(effort)) thinking = effort;
  }
  const effectiveModel = model ?? envModel;
  return {
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function readJsonRecord(path: string): ConfigRecord | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readTopLevelQuotedString(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
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

function normalizeGrokSandbox(value: string | null): string {
  return nonBlank(value) ?? 'workspace';
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is ConfigRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
