import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_CONSOLE_CREATE_OPTION_KEYS,
  parseSessionConsoleCapabilitiesResult,
  type JsonObject,
  type SessionConsoleCapabilitiesResult,
  type SessionConsoleCreateOptions,
} from '@contracts/index';
import type { AgentAdapter } from '@main/adapters/types';
import { getAdapterRuntimeProfile } from '@main/adapters/runtime-profiles';
import { projectProviderSessionFiles } from '@hosts/provider-state/provider-session-projection';
import type { SessionAdapterId } from '@shared/types';
import { resolveServerCoreProviderSettings } from './provider-settings';
import { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import { resolveServerCoreSessionCreateCatalog } from './session-create-catalog';

const roots: string[] = [];

interface CapabilityHarness {
  providerHome: string;
  setRevision(value: number): void;
  subject: ServerCoreSessionCreateCapabilities;
  workspaceRoot: string;
}

function adapter(adapterId: SessionAdapterId): AgentAdapter {
  const profile = getAdapterRuntimeProfile(adapterId);
  return {
    id: adapterId,
    displayName: profile.displayName,
    capabilities: { ...profile.capabilities },
    createSession: vi.fn(),
  } as unknown as AgentAdapter;
}

function harness(enabled: readonly SessionAdapterId[] = [
  'claude-code', 'codex-cli', 'grok-build',
], grokAvailable = false, grokSandbox?: string, codexModel = 'gpt-remote',
ready: readonly SessionAdapterId[] = enabled): CapabilityHarness {
  const root = realpathSync(mkdtempSync(join(
    realpathSync(tmpdir()),
    'agent-deck-create-capabilities-',
  )));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const providerHome = join(root, 'provider-home');
  const providerSourceHome = join(root, 'provider-source-home');
  mkdirSync(join(workspaceRoot, 'repo', 'nested'), { recursive: true });
  mkdirSync(providerHome, { mode: 0o700 });
  mkdirSync(join(providerSourceHome, '.claude', 'gateways'), { recursive: true, mode: 0o700 });
  mkdirSync(join(providerSourceHome, '.codex'), { recursive: true, mode: 0o700 });
  mkdirSync(join(providerSourceHome, '.grok'), { recursive: true, mode: 0o700 });
  writeFileSync(join(providerSourceHome, '.claude', 'gateways', 'deepseek.json'), JSON.stringify({
    env: { ANTHROPIC_MODEL: 'gateway-sonnet', ANTHROPIC_AUTH_TOKEN: 'must-not-leak' },
  }));
  writeFileSync(join(providerSourceHome, '.codex', 'config.toml'), [
    `model = "${codexModel}"`,
    'model_provider = "team"',
    'model_reasoning_effort = "xhigh"',
    '[model_providers.team]',
    'name = "Team"',
    '[model_providers.openai]',
    'name = "OpenAI"',
  ].join('\n'));
  writeFileSync(join(providerSourceHome, '.grok', 'config.toml'), 'model = "grok-remote"\n');
  projectProviderSessionFiles(providerSourceHome, providerHome);
  const adapters = new Map(enabled.map((id) => [id, adapter(id)]));
  let revision = 7;
  const runtimeOptions: JsonObject = {
    ...(grokSandbox === undefined ? {} : { providerSettings: { grokSandbox } }),
  };
  const settings = resolveServerCoreProviderSettings(runtimeOptions);
  const subject = new ServerCoreSessionCreateCapabilities({
    ...(grokAvailable ? {
      grokContainer: { readiness: async () => ({ available: true }) },
    } : {}),
    metadata: { currentRevision: () => revision },
    projects: [],
    catalog: resolveServerCoreSessionCreateCatalog(providerHome, settings),
    registry: {
      get: (id) => adapters.get(id as SessionAdapterId),
      isReady: (id) => ready.includes(id as SessionAdapterId),
    },
    settings,
    workspaceRoot: realpathSync(workspaceRoot),
  });
  return {
    providerHome,
    setRevision: (value) => { revision = value; },
    subject,
    workspaceRoot: realpathSync(workspaceRoot),
  };
}

function defaults(descriptor: SessionConsoleCapabilitiesResult): SessionConsoleCreateOptions {
  return Object.fromEntries(SESSION_CONSOLE_CREATE_OPTION_KEYS.map((key) => [
    key,
    descriptor.create.options[key].defaultValue,
  ])) as unknown as SessionConsoleCreateOptions;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ServerCoreSessionCreateCapabilities', () => {
  it('does not advertise a registered adapter whose initialization failed', async () => {
    const { subject } = harness(['claude-code'], false, undefined, 'gpt-remote', []);
    const descriptor = await subject.describe({
      adapterId: 'claude-code',
      provider: '',
      workingDirectory: '.',
    });
    expect(descriptor.create).toMatchObject({
      enabled: false,
      disabledReason: '此 Remote Core 当前无法启动该 adapter。',
    });
    await expect(subject.validateCreate(
      'claude-code',
      descriptor.capabilityRevision,
      '.',
      defaults(descriptor),
    )).rejects.toMatchObject({ code: 'capability_unavailable' });
  });

  it('keeps the provider field enabled with an empty native value without custom definitions', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-create-empty-catalog-')));
    roots.push(root);
    const workspaceRoot = join(root, 'workspace');
    const providerHome = join(root, 'provider-home');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(providerHome, { mode: 0o700 });
    const settings = resolveServerCoreProviderSettings({});
    const subject = new ServerCoreSessionCreateCapabilities({
      metadata: { currentRevision: () => 1 },
      projects: [],
      catalog: resolveServerCoreSessionCreateCatalog(providerHome, settings),
      registry: { get: (id) => id === 'codex-cli' ? adapter('codex-cli') : undefined },
      settings,
      workspaceRoot: realpathSync(workspaceRoot),
    });
    const descriptor = await subject.describe({
      adapterId: 'codex-cli', provider: '', workingDirectory: '.',
    });
    expect(descriptor.create.options.provider).toEqual({
      allowedValues: [],
      allowCustom: false,
      allowEmpty: true,
      defaultValue: '',
      disabledReason: null,
      enabled: true,
    });
  });

  it('publishes exact adapter-owned defaults without private path or credential disclosure', async () => {
    const { providerHome, subject, workspaceRoot } = harness();
    rmSync(providerHome, { recursive: true, force: true });
    const requests = [
      { adapterId: 'claude-code', provider: 'deepseek', workingDirectory: 'repo' },
      { adapterId: 'codex-cli', provider: '', workingDirectory: 'repo' },
      { adapterId: 'grok-build', provider: '', workingDirectory: 'repo' },
    ] as const;

    for (const request of requests) {
      const descriptor = await subject.describe(request);
      expect(parseSessionConsoleCapabilitiesResult(structuredClone(descriptor), request))
        .toEqual(descriptor);
      expect(descriptor.create.adapterId).toBe(request.adapterId);
      expect(descriptor.directoryPolicy.selectedDirectory).toBe('repo');
      expect(descriptor.capabilityRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
      const serialized = JSON.stringify(descriptor);
      expect(serialized).not.toContain(providerHome);
      expect(serialized).not.toContain(workspaceRoot);
      expect(serialized).not.toContain('must-not-leak');
      expect(serialized).not.toMatch(/topology|instanceId|workerId|workspaceRoot|privateRoot/);
    }

    const claude = await subject.describe(requests[0]);
    expect(claude.create.options.provider.allowedValues).toEqual(['deepseek']);
    expect(claude.create.options.model.defaultValue).toBe('gateway-sonnet');
    const codex = await subject.describe(requests[1]);
    expect(codex.create.options.provider.allowedValues).toEqual(['team', 'openai']);
    expect(codex.create.options.provider.defaultValue).toBe('team');
    expect(codex.create.options.model.defaultValue).toBe('gpt-remote');
    const grok = await subject.describe(requests[2]);
    expect(grok.create.options.grokSandbox).toMatchObject({
      allowedValues: [],
      defaultValue: null,
      enabled: false,
    });
    expect(grok.create).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('Provider 会话容器'),
    });
    expect(grok.create.sandbox.choices).toEqual([
      expect.objectContaining({ value: 'read-only', enabled: false }),
      expect.objectContaining({ value: 'workspace', enabled: false }),
      expect.objectContaining({ value: 'off', enabled: false }),
    ]);
  });

  it('does not enable Grok when a same-process private auth file appears', async () => {
    const state = harness();
    const request = { adapterId: 'grok-build' as const, provider: '', workingDirectory: 'repo' };
    const unavailable = await state.subject.describe(request);
    mkdirSync(join(state.providerHome, '.grok'), { mode: 0o700 });
    writeFileSync(join(state.providerHome, '.grok', 'auth.json'), '{"scope":{"key":"private"}}\n', {
      mode: 0o600,
    });

    const stillUnavailable = await state.subject.describe(request);
    expect(stillUnavailable.capabilityRevision).toBe(unavailable.capabilityRevision);
    expect(stillUnavailable.create).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('Provider 会话容器'),
    });
  });

  it('enables fixed Grok container choices only after live supervisor and broker readiness', async () => {
    const { subject } = harness(undefined, true);
    const request = { adapterId: 'grok-build' as const, provider: '', workingDirectory: 'repo' };
    const descriptor = await subject.describe(request);

    expect(descriptor.create).toMatchObject({ enabled: true, disabledReason: null });
    expect(descriptor.create.options.grokSandbox).toEqual({
      allowedValues: ['read-only', 'workspace', 'off'],
      allowCustom: false,
      allowEmpty: false,
      defaultValue: 'workspace',
      disabledReason: null,
      enabled: true,
    });
    expect(descriptor.create.sandbox.choices).toEqual([
      expect.objectContaining({ value: 'read-only', enabled: true, disabledReason: null }),
      expect.objectContaining({ value: 'workspace', enabled: true, disabledReason: null }),
      expect.objectContaining({ value: 'off', enabled: true, disabledReason: null }),
    ]);
    await expect(subject.validateCreate(
      request.adapterId,
      descriptor.capabilityRevision,
      request.workingDirectory,
      defaults(descriptor),
    )).resolves.toMatchObject({ create: { enabled: true } });
  });

  it.each(['strict', 'project-locked'])(
    'projects unsupported configured Grok default %s to the safe Remote workspace default',
    async (grokSandbox) => {
      const { subject } = harness(undefined, true, grokSandbox);
      const request = { adapterId: 'grok-build' as const, provider: '', workingDirectory: 'repo' };
      const descriptor = await subject.describe(request);

      expect(parseSessionConsoleCapabilitiesResult(structuredClone(descriptor), request))
        .toEqual(descriptor);
      expect(descriptor.create.options.grokSandbox).toMatchObject({
        allowedValues: ['read-only', 'workspace', 'off'],
        allowCustom: false,
        defaultValue: 'workspace',
        enabled: true,
      });
      await expect(subject.validateCreate(
        request.adapterId,
        descriptor.capabilityRevision,
        request.workingDirectory,
        defaults(descriptor),
      )).resolves.toMatchObject({ create: { enabled: true } });
    },
  );

  it('keeps capability revisions stable across data revisions and changes semantic inputs', async () => {
    const state = harness();
    const request = { adapterId: 'codex-cli' as const, provider: '', workingDirectory: 'repo' };
    const first = await state.subject.describe(request);
    state.setRevision(99);
    const same = await state.subject.describe(request);
    expect(same.revision).toBe(99);
    expect(same.capabilityRevision).toBe(first.capabilityRevision);

    const nested = await state.subject.describe({ ...request, workingDirectory: 'repo/nested' });
    expect(nested.capabilityRevision).not.toBe(first.capabilityRevision);
    const provider = await state.subject.describe({ ...request, provider: 'openai' });
    expect(provider.capabilityRevision).not.toBe(first.capabilityRevision);

    writeFileSync(join(state.providerHome, '.codex', 'config.toml'), [
      'model = "gpt-changed"',
      'model_provider = "team"',
      '[model_providers.team]',
      'name = "Team"',
    ].join('\n'));
    const changed = await state.subject.describe(request);
    expect(changed.capabilityRevision).toBe(first.capabilityRevision);

    const safeCatalogChanged = harness(undefined, false, undefined, 'gpt-changed');
    const explicitlyChanged = await safeCatalogChanged.subject.describe(request);
    expect(explicitlyChanged.capabilityRevision).not.toBe(first.capabilityRevision);
  });

  it('rejects stale revisions, cross-adapter options, unavailable adapters and providers', async () => {
    const { subject } = harness(['codex-cli']);
    const request = { adapterId: 'codex-cli' as const, provider: '', workingDirectory: 'repo' };
    const descriptor = await subject.describe(request);
    const options = defaults(descriptor);
    await expect(subject.validateCreate(
      request.adapterId, descriptor.capabilityRevision, request.workingDirectory, options,
    )).resolves.toEqual(descriptor);
    await expect(subject.validateCreate(
      request.adapterId, `sha256:${'f'.repeat(64)}`, request.workingDirectory, options,
    )).rejects.toMatchObject({ code: 'conflict' });
    await expect(subject.validateCreate(
      request.adapterId,
      descriptor.capabilityRevision,
      request.workingDirectory,
      { ...options, permissionMode: 'bypassPermissions' },
    )).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(subject.describe({
      adapterId: 'grok-build', provider: '', workingDirectory: 'repo',
    })).resolves.toMatchObject({ create: { enabled: false } });
    await expect(subject.describe({
      adapterId: 'codex-cli', provider: 'missing', workingDirectory: 'repo',
    })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects symlink escape before reading provider defaults or validating create', async () => {
    const { subject, workspaceRoot } = harness();
    const outside = join(workspaceRoot, '..', 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(workspaceRoot, 'escape'));
    await expect(subject.describe({
      adapterId: 'codex-cli', provider: '', workingDirectory: 'escape',
    })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
