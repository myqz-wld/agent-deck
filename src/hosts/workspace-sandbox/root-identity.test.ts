import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseWorkspaceSandboxSpec } from '@contracts/index';

import {
  assertWorkspaceSandboxIdentity,
  captureWorkspaceSandboxIdentity,
} from './root-identity';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-workspace-roots-')));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const privateRoot = join(root, 'private');
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(workspaceRoot, { mode: 0o700 });
  mkdirSync(privateRoot, { mode: 0o700 });
  mkdirSync(runtimeRoot, { mode: 0o755 });
  const environment = {
    coreConfigRoot: join(privateRoot, 'core-config'),
    coreRuntimeRoot: join(privateRoot, 'core-runtime'),
    coreStateRoot: join(privateRoot, 'core-state'),
    providerCacheRoot: join(privateRoot, 'provider-cache'),
    providerHomeRoot: join(privateRoot, 'provider-home'),
    providerTempRoot: join(privateRoot, 'provider-tmp'),
  };
  for (const path of Object.values(environment)) mkdirSync(path, { mode: 0o700 });
  return {
    root,
    spec: parseWorkspaceSandboxSpec({
      schemaVersion: 1,
      execution: 'relay-worker',
      workerConfigId: 'worker-config-a',
      workerId: 'worker-a',
      workspaceRoot,
      privateRoot,
      runtimeReadRoots: [runtimeRoot],
      environment,
      networkBoundary: 'provider-controlled',
    }),
  };
}

describe('workspace sandbox root identity', () => {
  it('captures and rechecks every authorized root', () => {
    const { spec } = fixture();
    const snapshot = captureWorkspaceSandboxIdentity(spec);

    expect(snapshot.roots).toHaveLength(9);
    expect(() => assertWorkspaceSandboxIdentity(snapshot)).not.toThrow();
  });

  it('fails closed when a root mode changes after capture', () => {
    const { spec } = fixture();
    const snapshot = captureWorkspaceSandboxIdentity(spec);
    chmodSync(spec.workspaceRoot, 0o777);

    expect(() => assertWorkspaceSandboxIdentity(snapshot)).toThrow('unsafe');
  });

  it('rejects a symlinked private root instead of following it', () => {
    const { root, spec } = fixture();
    const target = join(root, 'replacement');
    mkdirSync(target, { mode: 0o700 });
    rmSync(spec.privateRoot, { recursive: true });
    symlinkSync(target, spec.privateRoot);

    expect(() => captureWorkspaceSandboxIdentity(spec)).toThrow('canonical');
  });
});
