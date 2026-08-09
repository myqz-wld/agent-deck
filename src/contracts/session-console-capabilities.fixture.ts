import type {
  SessionConsoleAdapterCreateDescriptor,
  SessionConsoleCapabilitiesResult,
  SessionConsoleCreateOptionDescriptor,
  SessionConsoleCreateOptions,
} from './session-console-capabilities';

function disabled(): SessionConsoleCreateOptionDescriptor {
  return Object.freeze({
    allowedValues: [],
    allowCustom: false,
    allowEmpty: false,
    defaultValue: null,
    disabledReason: 'Unavailable in fixture',
    enabled: false,
  });
}

function enabled(
  value: string,
  allowedValues: string[] | null,
  allowCustom = false,
  allowEmpty = false,
): SessionConsoleCreateOptionDescriptor {
  return Object.freeze({
    allowedValues,
    allowCustom,
    allowEmpty,
    defaultValue: value,
    disabledReason: null,
    enabled: true,
  });
}

export function sessionConsoleCreateOptionsFixture(
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build' = 'codex-cli',
): SessionConsoleCreateOptions {
  return adapterId === 'claude-code'
    ? {
        approvalPolicy: null,
        claudeCodeSandbox: 'workspace-write',
        codexSandbox: null,
        grokSandbox: null,
        model: 'sonnet',
        permissionMode: 'bypassPermissions',
        provider: '',
        sessionMode: null,
        thinking: 'high',
      }
    : adapterId === 'codex-cli'
      ? {
          approvalPolicy: 'on-request',
          claudeCodeSandbox: null,
          codexSandbox: 'workspace-write',
          grokSandbox: null,
          model: 'gpt-5',
          permissionMode: null,
          provider: '',
          sessionMode: null,
          thinking: 'high',
        }
      : {
          approvalPolicy: null,
          claudeCodeSandbox: null,
          codexSandbox: null,
          grokSandbox: 'workspace',
          model: 'grok-4.5',
          permissionMode: null,
          provider: null,
          sessionMode: 'default',
          thinking: 'high',
        };
}

function createDescriptor(
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build',
): SessionConsoleAdapterCreateDescriptor {
  const values = sessionConsoleCreateOptionsFixture(adapterId);
  const sandboxKey = adapterId === 'claude-code'
    ? 'claudeCodeSandbox'
    : adapterId === 'codex-cli' ? 'codexSandbox' : 'grokSandbox';
  const sandboxAllowedValues = adapterId === 'claude-code'
    ? ['off', 'workspace-write', 'strict']
    : adapterId === 'codex-cli'
      ? ['workspace-write', 'read-only', 'danger-full-access']
      : ['read-only', 'workspace', 'off'];
  return {
    adapterId,
    displayName: adapterId === 'claude-code'
      ? 'Claude Code' : adapterId === 'codex-cli' ? 'Codex CLI' : 'Grok Build',
    disabledReason: null,
    enabled: true,
    attachments: {
      disabledReason: 'Unavailable in fixture',
      enabled: false,
      maxBytesEach: 20 * 1024 * 1024,
      maxBytesTotal: 30 * 1024 * 1024,
      maxCount: 20,
      mimeTypes: ['image/png'],
    },
    options: {
      approvalPolicy: values.approvalPolicy === null
        ? disabled() : enabled(values.approvalPolicy, ['untrusted', 'on-request', 'never']),
      claudeCodeSandbox: values.claudeCodeSandbox === null
        ? disabled() : enabled(values.claudeCodeSandbox, ['off', 'workspace-write', 'strict']),
      codexSandbox: values.codexSandbox === null
        ? disabled() : enabled(values.codexSandbox, ['workspace-write', 'read-only', 'danger-full-access']),
      grokSandbox: values.grokSandbox === null
        ? disabled() : enabled(values.grokSandbox, ['read-only', 'workspace', 'off']),
      model: enabled(values.model!, null, true, true),
      permissionMode: values.permissionMode === null
        ? disabled() : enabled(values.permissionMode, ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']),
      provider: values.provider === null
        ? disabled() : enabled(values.provider, [], false, true),
      sessionMode: values.sessionMode === null
        ? disabled() : enabled(values.sessionMode, ['default', 'plan', 'ask']),
      thinking: enabled(values.thinking!, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    },
    sandbox: {
      choices: sandboxAllowedValues.map((value) => ({
        disabledReason: null,
        effectiveAccess: value === 'strict'
          ? 'provider-strict'
          : value === 'read-only'
            ? 'workspace-read-only'
            : value === 'off' || value === 'danger-full-access'
              ? 'workspace-read-write'
              : 'selected-directory-read-write',
        enabled: true,
        value,
      })),
      optionKey: sandboxKey,
      scope: 'selected-directory',
      workspaceCeiling: 'required',
    },
  };
}

export function sessionConsoleCapabilitiesFixture(
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build' = 'codex-cli',
  workingDirectory = '.',
): SessionConsoleCapabilitiesResult {
  return {
    adapters: [
      { adapterId: 'claude-code', displayName: 'Claude Code', disabledReason: null, enabled: true },
      { adapterId: 'codex-cli', displayName: 'Codex CLI', disabledReason: null, enabled: true },
      { adapterId: 'grok-build', displayName: 'Grok Build', disabledReason: null, enabled: true },
    ],
    capabilityRevision: `sha256:${'a'.repeat(64)}`,
    create: createDescriptor(adapterId),
    directoryPolicy: {
      kind: 'workspace-relative',
      maxBytes: 1_024,
      rootRef: '.',
      selectedDirectory: workingDirectory,
      symlinkPolicy: 'resolve-beneath-workspace',
    },
    revision: 1,
    schemaVersion: 1,
    selectedAdapterId: adapterId,
  };
}
