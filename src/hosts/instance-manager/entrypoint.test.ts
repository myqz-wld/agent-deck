import { describe, expect, it } from 'vitest';

import {
  parseInstanceManagerCliConfig,
  parseInstanceManagerCliRequest,
} from './cli-config';
import {
  executeInstanceManagerCommand,
  instanceManagerEntrypointFailure,
} from './entrypoint';
import { createHarness, DIGEST_A, FULL_RESOURCES } from './test-fixtures';
import { InstanceManagerError } from './validation';

function config() {
  return {
    schemaVersion: 1,
    roots: {
      serviceHome: '/var/lib/agent-deck',
      runtimeRoot: '/run/user/1001',
      unitRoot: '/var/lib/agent-deck/.config/containers/systemd',
      metadataRoot: '/var/lib/agent-deck-manager/metadata',
      backupRoot: '/var/lib/agent-deck-manager/backups',
      journalRoot: '/var/lib/agent-deck-manager/journals',
      cutoverEvidenceRoot: '/etc/agent-deck-manager/evidence',
      fullTemplatePath: '/opt/agent-deck/share/full/agent-deck-full@.container.in',
      fullPreflightPath: '/opt/agent-deck/libexec/agent-deck-full-preflight',
      relayTemplatePath: '/opt/agent-deck/share/relay/agent-deck-relay@.container',
      relayPreflightPath: '/opt/agent-deck/libexec/agent-deck-relay-preflight',
      relayEvidenceRoot: '/etc/agent-deck-manager/relay-evidence',
    },
    limits: {
      commandTimeoutMs: 60_000,
      lifecycleTimeoutMs: 120_000,
      healthTimeoutMs: 90_000,
      maxOutputBytes: 16_384,
      maxArtifactBytes: 1_048_576,
      maxEvidenceAgeMs: 86_400_000,
    },
    serviceUid: 1001,
    trustedRootUid: 0,
    trustedArtifactUid: 0,
    lockRoot: '/var/lib/agent-deck-manager/locks',
  };
}

describe('instance manager command entrypoint', () => {
  it('parses one exact production host configuration', () => {
    expect(parseInstanceManagerCliConfig(config())).toMatchObject({
      serviceUid: 1001,
      trustedRootUid: 0,
      lockRoot: '/var/lib/agent-deck-manager/locks',
    });
  });

  it('rejects extra host config fields and ambiguous request shapes', () => {
    expect(() => parseInstanceManagerCliConfig({ ...config(), extra: true })).toThrow(/missing or extra/);
    expect(() => parseInstanceManagerCliRequest('create', {
      topology: 'relay',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: {},
      fullResources: FULL_RESOURCES,
    })).toThrow(/missing or extra/);
    expect(() => parseInstanceManagerCliRequest('create', {
      topology: 'full',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: {},
    })).toThrow(/missing or extra/);
  });

  it('dispatches plan operations through the existing manager authority', async () => {
    const harness = createHarness();
    const request = parseInstanceManagerCliRequest('plan-create', {
      topology: 'full',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: { instanceId: 'tenant-a' },
      fullResources: FULL_RESOURCES,
    });
    await expect(executeInstanceManagerCommand(
      harness.manager,
      'plan-create',
      request,
    )).resolves.toMatchObject({
      action: 'create',
      topology: 'full',
      instanceId: 'tenant-a',
      destructive: false,
    });
  });

  it('returns deployment-only version state after create', async () => {
    const harness = createHarness();
    await harness.manager.create({
      topology: 'relay',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: {},
    });
    const request = parseInstanceManagerCliRequest('describe', {
      topology: 'relay',
      instanceId: 'tenant-a',
    });
    await expect(executeInstanceManagerCommand(
      harness.manager,
      'describe',
      request,
    )).resolves.toMatchObject({
      generation: 1,
      currentVersion: 'v1',
      previousVersion: null,
      versions: [{ version: 'v1', image: DIGEST_A }],
    });
  });

  it('emits a bounded localized failure without the internal message', () => {
    const output = instanceManagerEntrypointFailure(
      new InstanceManagerError('tampered', 'secret path and runtime input'),
    );
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      ok: false,
      code: 'tampered',
      message: '实例管理操作失败；详细输入已隐藏。',
    });
    expect(output).not.toContain('secret path');
  });
});
