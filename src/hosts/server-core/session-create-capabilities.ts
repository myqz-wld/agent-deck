import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  AgentDeckClientErrorCode,
  SESSION_CONSOLE_CAPABILITY_SCHEMA_VERSION,
  SESSION_CONSOLE_CREATE_OPTION_KEYS,
  SESSION_CONSOLE_MAX_OPTION_VALUES,
  SESSION_CONSOLE_MAX_WORKING_DIRECTORY_BYTES,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_BYTES,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_COUNT,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES,
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES,
  type SessionConsoleAdapterCreateDescriptor,
  type SessionConsoleAdapterSummaryDescriptor,
  type SessionConsoleCapabilitiesParams,
  type SessionConsoleCapabilitiesResult,
  type SessionConsoleCreateOptionDescriptor,
  type SessionConsoleCreateOptionSchema,
  type SessionConsoleCreateOptions,
} from '@contracts/index';
import { DaemonRequestError } from '@hosts/daemon';
import {
  listClaudeGatewayProfilesCore,
  resolveClaudeGatewayProfileCore,
  type ClaudeGatewayProfileHost,
} from '@main/adapters/claude-code/gateway-profiles-core';
import {
  resolveSessionCreationDefaultsCore,
  type SessionCreationDefaultsHost,
} from '@main/adapters/session-creation-defaults-core';
import {
  getAdapterRuntimeProfile,
  isSessionAdapterId,
} from '@main/adapters/runtime-profiles';
import type { AgentAdapter } from '@main/adapters/types';
import {
  listCodexModelProviders,
  resolveCodexModelProvider,
} from '@main/codex-config/model-providers';
import type { SessionAdapterId, SessionCreationDefaults } from '@shared/types';
import {
  resolveServerCoreProjectWorkspace,
  resolveServerCoreWorkspaceDirectory,
  type ServerCoreProject,
} from './project-catalog';
import {
  SERVER_CORE_REMOTE_GROK_CONTAINER_REQUIRED_REASON,
  serverCoreProviderSandboxChoices,
} from './provider-sandbox-policy';
import type { ServerCoreProviderSettings } from './provider-settings';

const ADAPTER_IDS = Object.freeze([
  'claude-code',
  'codex-cli',
  'grok-build',
] as const satisfies readonly SessionAdapterId[]);
const UNSUPPORTED = '当前 adapter 不支持此选项。';
const ATTACHMENTS_UNSUPPORTED = '当前 Remote adapter 不支持图片输入。';
const REMOTE_GROK_SANDBOX_VALUES = Object.freeze([
  'read-only',
  'workspace',
  'off',
] as const);

export interface ServerCoreSessionCreateCapabilityRegistry {
  get(adapterId: string): AgentAdapter | undefined;
}

export interface ServerCoreSessionCreateCapabilityMetadata {
  currentRevision(): number;
}

export interface ServerCoreSessionCreateCapabilityOptions {
  grokContainer?: {
    readiness(): Promise<{ readonly available: boolean }>;
  };
  metadata: ServerCoreSessionCreateCapabilityMetadata;
  projects: readonly ServerCoreProject[];
  providerHomeRoot: string;
  registry: ServerCoreSessionCreateCapabilityRegistry;
  settings: ServerCoreProviderSettings;
  workspaceRoot: string;
}

function gatewayHost(): ClaudeGatewayProfileHost {
  return {
    joinPath: join,
    listDirectory: (directory) => readdirSync(directory, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
    isFile: (path) => statSync(path).isFile(),
    pathExists: existsSync,
    readText: (path) => readFileSync(path, 'utf8'),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function enabledOption(
  defaultValue: string,
  input: { allowedValues?: readonly string[]; allowCustom?: boolean; allowEmpty?: boolean } = {},
): SessionConsoleCreateOptionDescriptor {
  return Object.freeze({
    allowedValues: input.allowedValues ? [...input.allowedValues] : null,
    allowCustom: input.allowCustom === true,
    allowEmpty: input.allowEmpty === true,
    defaultValue,
    disabledReason: null,
    enabled: true,
  });
}

function disabledOption(reason = UNSUPPORTED): SessionConsoleCreateOptionDescriptor {
  return Object.freeze({
    allowedValues: [],
    allowCustom: false,
    allowEmpty: false,
    defaultValue: null,
    disabledReason: reason,
    enabled: false,
  });
}

function remoteGrokSandboxDefault(value: string): string {
  return REMOTE_GROK_SANDBOX_VALUES.includes(
    value as (typeof REMOTE_GROK_SANDBOX_VALUES)[number],
  ) ? value : 'workspace';
}

function adapterSummary(
  adapterId: SessionAdapterId,
  registry: ServerCoreSessionCreateCapabilityRegistry,
  grokAvailable: boolean,
): SessionConsoleAdapterSummaryDescriptor {
  const profile = getAdapterRuntimeProfile(adapterId);
  const adapter = registry.get(adapterId);
  const enabled = Boolean(adapter?.createSession && adapter.capabilities.canCreateSession);
  const remotelyEnabled = enabled && (adapterId !== 'grok-build' || grokAvailable);
  return Object.freeze({
    adapterId,
    displayName: profile.displayName,
    disabledReason: remotelyEnabled
      ? null
      : adapterId === 'grok-build' && enabled
        ? SERVER_CORE_REMOTE_GROK_CONTAINER_REQUIRED_REASON
        : '此 Remote Core 当前无法启动该 adapter。',
    enabled: remotelyEnabled,
  });
}

function optionSchema(
  adapterId: SessionAdapterId,
  defaults: SessionCreationDefaults,
  providers: readonly string[],
  grokAvailable: boolean,
): SessionConsoleCreateOptionSchema {
  const profile = getAdapterRuntimeProfile(adapterId);
  const common = {
    model: enabledOption(defaults.model, { allowCustom: true, allowEmpty: true }),
    thinking: enabledOption(defaults.thinking, {
      allowedValues: profile.model.thinkingLevels,
    }),
  };
  if (adapterId === 'claude-code') {
    return Object.freeze({
      approvalPolicy: disabledOption(),
      claudeCodeSandbox: enabledOption(defaults.claudeCodeSandbox, {
        allowedValues: ['off', 'workspace-write', 'strict'],
      }),
      codexSandbox: disabledOption(),
      grokSandbox: disabledOption(),
      ...common,
      permissionMode: enabledOption(defaults.permissionMode, {
        allowedValues: profile.runtimeControls.permissionModes,
      }),
      provider: enabledOption(defaults.provider, {
        allowedValues: providers,
        allowEmpty: true,
      }),
      sessionMode: disabledOption(),
    });
  }
  if (adapterId === 'codex-cli') {
    return Object.freeze({
      approvalPolicy: enabledOption(defaults.approvalPolicy, {
        allowedValues: ['untrusted', 'on-request', 'never'],
      }),
      claudeCodeSandbox: disabledOption(),
      codexSandbox: enabledOption(defaults.codexSandbox, {
        allowedValues: ['workspace-write', 'read-only', 'danger-full-access'],
      }),
      grokSandbox: disabledOption(),
      ...common,
      permissionMode: disabledOption(),
      provider: enabledOption(defaults.provider, {
        allowedValues: providers,
        allowEmpty: true,
      }),
      sessionMode: disabledOption(),
    });
  }
  return Object.freeze({
    approvalPolicy: disabledOption(),
    claudeCodeSandbox: disabledOption(),
    codexSandbox: disabledOption(),
    grokSandbox: grokAvailable
      ? enabledOption(remoteGrokSandboxDefault(defaults.grokSandbox), {
        allowedValues: REMOTE_GROK_SANDBOX_VALUES,
      })
      : disabledOption(SERVER_CORE_REMOTE_GROK_CONTAINER_REQUIRED_REASON),
    ...common,
    permissionMode: disabledOption(),
    provider: disabledOption(),
    sessionMode: enabledOption(defaults.sessionMode, {
      allowedValues: profile.runtimeControls.sessionModes,
    }),
  });
}

function assertCatalogBounded(values: readonly string[], field: string): void {
  if (values.length > SESSION_CONSOLE_MAX_OPTION_VALUES) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.CapabilityUnavailable,
      `${field} catalog exceeds the Remote capability limit`,
    );
  }
}

function assertOptionValue(
  key: (typeof SESSION_CONSOLE_CREATE_OPTION_KEYS)[number],
  value: string | null,
  descriptor: SessionConsoleCreateOptionDescriptor,
): void {
  if (!descriptor.enabled) {
    if (value !== null) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        `Remote session option ${key} is not supported`,
      );
    }
    return;
  }
  if (value === null || (!descriptor.allowEmpty && value.length === 0)) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.InvalidRequest,
      `Remote session option ${key} is required`,
    );
  }
  if (
    !descriptor.allowCustom && value.length > 0 &&
    !descriptor.allowedValues?.includes(value)
  ) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.InvalidRequest,
      `Remote session option ${key} is invalid`,
    );
  }
}

export class ServerCoreSessionCreateCapabilities {
  constructor(private readonly options: ServerCoreSessionCreateCapabilityOptions) {}

  resolveWorkingDirectory(reference: string): string {
    return this.resolveWorkspace(reference);
  }

  async describe(params: SessionConsoleCapabilitiesParams): Promise<SessionConsoleCapabilitiesResult> {
    const grokAvailable = await this.grokAvailable();
    const summaries = ADAPTER_IDS.map((adapterId) =>
      adapterSummary(adapterId, this.options.registry, grokAvailable));
    const requested = params.adapterId ?? summaries.find((item) => item.enabled)?.adapterId ??
      summaries[0]!.adapterId;
    if (!isSessionAdapterId(requested)) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Remote session adapter is invalid',
      );
    }
    if (requested === 'grok-build' && params.provider.length > 0) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Grok does not accept a provider override',
      );
    }
    const cwd = this.resolveWorkspace(params.workingDirectory);
    const providerHome = this.options.providerHomeRoot;
    const gatewaysDir = join(providerHome, '.claude', 'gateways');
    const codexConfigPath = join(providerHome, '.codex', 'config.toml');
    const grokConfigPath = join(providerHome, '.grok', 'config.toml');
    const host = gatewayHost();
    const providers = requested === 'claude-code'
      ? listClaudeGatewayProfilesCore({ gatewaysDir }, host).map((item) => item.id)
      : requested === 'codex-cli'
        ? listCodexModelProviders(codexConfigPath).map((item) => item.id)
        : [];
    assertCatalogBounded(providers, requested);
    if (params.provider && !providers.includes(params.provider)) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Selected Remote provider is unavailable',
      );
    }
    const defaults = await resolveSessionCreationDefaultsCore(
      requested,
      { cwd, ...(params.provider ? { provider: params.provider } : {}) },
      {
        settings: this.options.settings,
        userHome: providerHome,
        readCodexConfig: async () => ({}),
        resolveClaudeProfile: (provider) => resolveClaudeGatewayProfileCore(
          provider,
          { gatewaysDir },
          host,
        ),
        codexConfigPath,
        grokConfigPath,
      },
      this.defaultsHost(providerHome, gatewaysDir, codexConfigPath),
    );
    const summary = summaries.find((item) => item.adapterId === requested)!;
    const attachmentEnabled = requested !== 'grok-build' &&
      this.options.registry.get(requested)?.capabilities.canAcceptAttachments === true;
    const create: SessionConsoleAdapterCreateDescriptor = Object.freeze({
      ...summary,
      attachments: Object.freeze({
        disabledReason: attachmentEnabled ? null : ATTACHMENTS_UNSUPPORTED,
        enabled: attachmentEnabled,
        maxBytesEach: SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_BYTES,
        maxBytesTotal: SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES,
        maxCount: SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_COUNT,
        mimeTypes: [...SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES],
      }),
      options: optionSchema(requested, defaults, providers, grokAvailable),
      sandbox: Object.freeze({
        choices: [...serverCoreProviderSandboxChoices(requested, grokAvailable)],
        optionKey: requested === 'claude-code'
          ? 'claudeCodeSandbox'
          : requested === 'codex-cli' ? 'codexSandbox' : 'grokSandbox',
        scope: 'selected-directory',
        workspaceCeiling: 'required',
      }),
    });
    const stable = {
      adapters: summaries,
      create,
      directoryPolicy: {
        kind: 'workspace-relative',
        maxBytes: SESSION_CONSOLE_MAX_WORKING_DIRECTORY_BYTES,
        rootRef: '.',
        selectedDirectory: params.workingDirectory,
        symlinkPolicy: 'resolve-beneath-workspace',
      },
      schemaVersion: SESSION_CONSOLE_CAPABILITY_SCHEMA_VERSION,
      selectedAdapterId: requested,
    } as const;
    return Object.freeze({
      ...stable,
      capabilityRevision: `sha256:${createHash('sha256').update(canonical(stable)).digest('hex')}`,
      revision: this.options.metadata.currentRevision(),
    });
  }

  async validateCreate(
    adapterId: string,
    capabilityRevision: string,
    workingDirectory: string,
    options: SessionConsoleCreateOptions,
  ): Promise<SessionConsoleCapabilitiesResult> {
    const descriptor = await this.describe({
      adapterId,
      provider: options.provider ?? '',
      workingDirectory,
    });
    if (descriptor.capabilityRevision !== capabilityRevision) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.Conflict,
        'Remote session capabilities changed; refresh and retry',
      );
    }
    if (!descriptor.create.enabled) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.CapabilityUnavailable,
        'Adapter cannot create Remote sessions',
      );
    }
    for (const key of SESSION_CONSOLE_CREATE_OPTION_KEYS) {
      assertOptionValue(key, options[key], descriptor.create.options[key]);
    }
    return descriptor;
  }

  private resolveWorkspace(reference: string): string {
    const project = this.options.projects.find((candidate) => candidate.projectRef === reference);
    try {
      return project
        ? resolveServerCoreProjectWorkspace(project, this.options.workspaceRoot)
        : resolveServerCoreWorkspaceDirectory(reference, this.options.workspaceRoot);
    } catch {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Working directory is outside the authorized Workspace or unavailable',
      );
    }
  }

  private async grokAvailable(): Promise<boolean> {
    if (!this.options.grokContainer) return false;
    try {
      return (await this.options.grokContainer.readiness()).available === true;
    } catch {
      return false;
    }
  }

  private defaultsHost(
    providerHome: string,
    gatewaysDir: string,
    codexConfigPath: string,
  ): SessionCreationDefaultsHost {
    return {
      userHome: () => providerHome,
      anthropicModel: () => undefined,
      codexConfigPath: () => codexConfigPath,
      resolveCodexModelProvider: (provider, path) => resolveCodexModelProvider(provider, path),
      claudeGatewaySettingsPath: (provider) => join(gatewaysDir, `${provider}.json`),
    };
  }
}
