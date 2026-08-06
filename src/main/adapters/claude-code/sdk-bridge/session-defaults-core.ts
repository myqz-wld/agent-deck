import {
  isClaudeThinkingLevel,
  type ClaudeThinkingLevel,
} from '@shared/session-metadata';
import type { SessionRecord } from '@shared/types';
import {
  selectClaudeModel,
  selectClaudeSandboxMode,
  type ClaudeSandboxMode,
} from '../runtime-selection';
import type { ClaudeGatewayModelAliases } from './runtime-metadata-core';

export interface ResolvedClaudeGatewayProfile {
  id: string;
  settingsPath: string;
  configRoot?: string;
  defaultModel?: string;
  modelAliases: ClaudeGatewayModelAliases;
}

export type ClaudePersistedSessionDefaults = Partial<Pick<
  SessionRecord,
  | 'agentPluginDir'
  | 'agentProfileName'
  | 'claudeCodeSandbox'
  | 'cliSessionId'
  | 'lifecycle'
  | 'model'
  | 'runtimeProvider'
  | 'thinking'
>>;

export interface ClaudeSessionDefaultsHost {
  readPersistedSession(sessionId: string): ClaudePersistedSessionDefaults | null;
  readSandboxDefault(): ClaudeSandboxMode | null | undefined;
  resolveGatewayProfile(gateway: string | null | undefined): ResolvedClaudeGatewayProfile | null;
}

/** Complete repository/settings boundary required by one Claude create or native resume. */
export interface ClaudeCreateSessionHost extends ClaudeSessionDefaultsHost {
  readPersistedSession(sessionId: string): SessionRecord | null;
  deleteTransientSession(sessionId: string): void;
}

export interface ClaudeSessionDefaultsOptions {
  resume?: string;
  model?: string;
  profileDefaultModel?: string;
  claudeCodeSandbox?: ClaudeSandboxMode;
  claudeCodeEffortLevel?: ClaudeThinkingLevel;
  gateway?: string;
  settingsPath?: string;
  gatewayModelAliases?: ClaudeGatewayModelAliases;
}

export function resolveClaudeModelCore(
  opts: Pick<ClaudeSessionDefaultsOptions, 'resume' | 'model' | 'profileDefaultModel'>,
  host: ClaudeSessionDefaultsHost,
): string | undefined {
  const persisted = opts.resume
    ? (host.readPersistedSession(opts.resume)?.model ?? null)
    : null;
  return selectClaudeModel({
    requested: opts.model,
    persisted,
    profileDefault: opts.profileDefaultModel,
  });
}

export function resolveClaudeSandboxModeCore(
  opts: Pick<ClaudeSessionDefaultsOptions, 'resume' | 'claudeCodeSandbox'>,
  host: ClaudeSessionDefaultsHost,
): ClaudeSandboxMode {
  const persisted = opts.resume
    ? (host.readPersistedSession(opts.resume)?.claudeCodeSandbox ?? null)
    : null;
  return selectClaudeSandboxMode({
    requested: opts.claudeCodeSandbox,
    persisted,
    readDefault: () => host.readSandboxDefault(),
  });
}

export function resolveClaudeEffortCore(
  opts: Pick<ClaudeSessionDefaultsOptions, 'resume' | 'claudeCodeEffortLevel'>,
  host: ClaudeSessionDefaultsHost,
): ClaudeThinkingLevel | undefined {
  const persisted = opts.resume
    ? host.readPersistedSession(opts.resume)?.thinking
    : null;
  return opts.claudeCodeEffortLevel
    ?? (isClaudeThinkingLevel(persisted) ? persisted : undefined);
}

export function withResolvedClaudeGatewayCore<T extends ClaudeSessionDefaultsOptions>(
  opts: T,
  host: ClaudeSessionDefaultsHost,
): T {
  const persistedGateway = opts.resume
    ? host.readPersistedSession(opts.resume)?.runtimeProvider
    : null;
  const profile = host.resolveGatewayProfile(opts.gateway ?? persistedGateway ?? undefined);
  if (!profile) return opts;
  return {
    ...opts,
    gateway: profile.id,
    settingsPath: profile.settingsPath,
    profileDefaultModel: profile.defaultModel,
    gatewayModelAliases: profile.modelAliases,
  } as T;
}
