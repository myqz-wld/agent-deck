import { describe, expect, it } from 'vitest';

import {
  intersectProviderSandboxPolicy,
  parseWorkspaceSandboxSpec,
} from './workspace-sandbox';

function spec() {
  return {
    schemaVersion: 1,
    execution: 'relay-worker',
    workerConfigId: 'worker-config-a',
    workerId: 'worker-a',
    workspaceRoot: '/Users/test/workspace',
    privateRoot: '/Users/test/Library/Application Support/Agent Deck/remote-workers/profile-a',
    runtimeReadRoots: ['/Applications/Agent Deck.app', '/usr/bin', '/usr/lib'],
    environment: {
      coreConfigRoot: '/Users/test/Library/Application Support/Agent Deck/remote-workers/profile-a/core-config',
      coreRuntimeRoot: '/Users/test/Library/Application Support/Agent Deck/remote-workers/profile-a/core-runtime',
      coreStateRoot: '/Users/test/Library/Application Support/Agent Deck/remote-workers/profile-a/core-state',
      providerCacheRoot: '/Users/test/Library/Application Support/Agent Deck/remote-workers/profile-a/provider-cache',
      providerHomeRoot: '/Users/test/Library/Application Support/Agent Deck/remote-workers/profile-a/provider-home',
      providerTempRoot: '/Users/test/Library/Application Support/Agent Deck/remote-workers/profile-a/provider-tmp',
    },
    networkBoundary: 'provider-controlled',
  };
}

describe('WorkspaceSandboxSpec', () => {
  it('keeps one workspace and exact provider-visible private children', () => {
    const parsed = parseWorkspaceSandboxSpec(spec());

    expect(parsed).toMatchObject({
      execution: 'relay-worker',
      workerConfigId: 'worker-config-a',
      workerId: 'worker-a',
    });
    expect(parsed.environment.providerHomeRoot).toContain('/remote-workers/profile-a/');
  });

  it('rejects overlap, traversal, broad runtime roots, and whole-private exposure', () => {
    expect(() => parseWorkspaceSandboxSpec({
      ...spec(), privateRoot: '/Users/test/workspace/private',
    })).toThrow('overlap');
    expect(() => parseWorkspaceSandboxSpec({
      ...spec(), workspaceRoot: '/Users/test/../outside',
    })).toThrow('normalized');
    expect(() => parseWorkspaceSandboxSpec({
      ...spec(), runtimeReadRoots: ['/'],
    })).toThrow('overlap');
    expect(() => parseWorkspaceSandboxSpec({
      ...spec(),
      environment: { ...spec().environment, providerHomeRoot: spec().privateRoot },
    })).toThrow('whole private root');
  });

  it('intersects provider modes without adding host roots or weakening network policy', () => {
    const parsed = parseWorkspaceSandboxSpec(spec());
    const broad = intersectProviderSandboxPolicy(parsed, {
      adapterId: 'codex-cli',
      selectedDirectory: `${parsed.workspaceRoot}/project-a`,
      workspaceAccess: 'outer-full',
      networkBoundary: 'provider-controlled',
    });
    const strict = intersectProviderSandboxPolicy(parsed, {
      adapterId: 'claude-code',
      selectedDirectory: `${parsed.workspaceRoot}/project-a`,
      workspaceAccess: 'read-only',
      networkBoundary: 'provider-controlled',
    });

    expect(broad.readWriteRoots).toContain(parsed.workspaceRoot);
    expect(broad.readWriteRoots).not.toContain(parsed.privateRoot);
    expect(strict.readOnlyRoots).toContain(parsed.workspaceRoot);
    expect(strict.readWriteRoots).not.toContain(parsed.workspaceRoot);
    expect(broad.readWriteRoots).not.toContain(parsed.environment.providerHomeRoot);
    const selected = intersectProviderSandboxPolicy(parsed, {
      adapterId: 'grok-build',
      selectedDirectory: `${parsed.workspaceRoot}/project-a`,
      workspaceAccess: 'workspace-write',
      networkBoundary: 'provider-controlled',
    });
    expect(selected.readOnlyRoots).toContain(parsed.workspaceRoot);
    expect(selected.readWriteRoots).toEqual([`${parsed.workspaceRoot}/project-a`]);
    expect([...broad.readOnlyRoots, ...broad.readWriteRoots].join('\n')).not.toContain('/.ssh');
    expect(() => intersectProviderSandboxPolicy(parsed, {
      adapterId: 'codex-cli',
      selectedDirectory: `${parsed.workspaceRoot}/project-a`,
      workspaceAccess: 'outer-full',
      networkBoundary: 'unrestricted',
    } as never)).toThrow('network');
    expect(() => intersectProviderSandboxPolicy(parsed, {
      adapterId: 'grok-build',
      selectedDirectory: '/Users/test/outside',
      workspaceAccess: 'workspace-write',
      networkBoundary: 'provider-controlled',
    })).toThrow('escapes');
  });
});
