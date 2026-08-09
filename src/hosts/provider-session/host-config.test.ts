import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseProviderSessionSupervisorHostConfig } from './host-config';

const DIGEST = `registry.invalid/agent-deck/grok@sha256:${'a'.repeat(64)}`;

function config(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    brokerRoot: '/srv/agent-deck/provider/broker',
    desktopSocketPath: null,
    desktopVm: null,
    engine: 'rootless-podman',
    executable: '/usr/bin/podman',
    images: {
      'claude-code-v1': null,
      'codex-cli-v1': null,
      'grok-build-v1': DIGEST,
    },
    instanceId: 'instance-a',
    maxActive: 8,
    privateRoot: '/srv/agent-deck/provider',
    rootlessHome: '/var/lib/agent-deck',
    rootlessRuntimeDirectory: '/run/user/1001',
    stateRoot: '/srv/agent-deck/provider/state',
    transportRuntimeDirectory: '/srv/agent-deck/provider/transport',
    transportSocketPath: '/srv/agent-deck/provider/transport/s.sock',
    workspaceRoot: '/srv/workspaces',
    ...overrides,
  };
}

describe('Provider supervisor host config', () => {
  it('accepts exact rootless and Colima authority without exposing it to public DTOs', () => {
    expect(parseProviderSessionSupervisorHostConfig(config())).toMatchObject({
      engine: 'rootless-podman',
      images: { 'grok-build-v1': DIGEST },
    });
    expect(parseProviderSessionSupervisorHostConfig(config({
      desktopSocketPath: '/Users/agent/.colima/default/docker.sock',
      desktopVm: 'colima',
      engine: 'docker-desktop',
      executable: '/opt/homebrew/Cellar/docker/29.7.2/bin/docker',
      images: {
        'claude-code-v1': null,
        'codex-cli-v1': null,
        'grok-build-v1': `sha256:${'b'.repeat(64)}`,
      },
      rootlessHome: null,
      rootlessRuntimeDirectory: null,
    }))).toMatchObject({ engine: 'docker-desktop', desktopVm: 'colima' });
    const longRoot = `/var/lib/agent-deck/${'volume-data/'.repeat(8)}provider`;
    expect(parseProviderSessionSupervisorHostConfig(config({
      privateRoot: longRoot,
      brokerRoot: `${longRoot}/broker`,
      stateRoot: `${longRoot}/state`,
      transportRuntimeDirectory: `${longRoot}/supervisor`,
      transportSocketPath: `${longRoot}/supervisor/s.sock`,
    })).transportSocketPath).toBe(`${longRoot}/supervisor/s.sock`);
  });

  it.each([
    { typo: true },
    { brokerRoot: '/srv/workspaces/broker' },
    { stateRoot: '/srv/agent-deck/provider/transport/state' },
    { transportSocketPath: '/srv/agent-deck/provider/s.sock' },
    { images: { 'claude-code-v1': null, 'codex-cli-v1': null, 'grok-build-v1': 'latest' } },
    { desktopSocketPath: '/run/docker.sock' },
  ])('rejects widened, overlapping, or internally inconsistent authority %#', (override) => {
    expect(() => parseProviderSessionSupervisorHostConfig(config(override))).toThrow();
  });

  it('keeps every shipped provisioning example parseable and socket-reachable', () => {
    for (const name of [
      'rootless-podman.config.example.json',
      'rootless-podman-full.config.example.json',
      'colima.config.example.json',
    ]) {
      const parsed = parseProviderSessionSupervisorHostConfig(JSON.parse(readFileSync(resolve(
        'deploy/linux/provider-session', name,
      ), 'utf8')));
      if (name === 'colima.config.example.json') {
        expect(Buffer.byteLength(parsed.transportSocketPath)).toBeLessThanOrEqual(103);
      }
      if (name === 'rootless-podman-full.config.example.json') {
        expect(Buffer.byteLength(parsed.transportSocketPath)).toBeGreaterThan(103);
      }
    }
  });
});
