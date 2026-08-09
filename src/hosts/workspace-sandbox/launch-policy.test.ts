import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseWorkspaceSandboxSpec } from '@contracts/index';

import {
  buildDarwinWorkspaceSandboxLaunch,
  buildLinuxWorkspaceSandboxLaunch,
} from './launch-policy';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-launch-policy-')));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const privateRoot = join(root, 'private');
  const runtimeRoot = join(root, 'runtime');
  const environment = {
    coreConfigRoot: join(privateRoot, 'core-config'),
    coreRuntimeRoot: join(privateRoot, 'core-runtime'),
    coreStateRoot: join(privateRoot, 'core-state'),
    providerCacheRoot: join(privateRoot, 'provider-cache'),
    providerHomeRoot: join(privateRoot, 'provider-home'),
    providerTempRoot: join(privateRoot, 'provider-tmp'),
  };
  for (const path of [workspaceRoot, privateRoot, runtimeRoot, ...Object.values(environment)]) {
    mkdirSync(path, { mode: 0o700 });
  }
  const configFile = join(privateRoot, 'worker.json');
  const bookmarkPath = join(privateRoot, 'workspace.bookmark');
  const launcherPath = join(runtimeRoot, 'agent-deck-worker-sandbox');
  const wrapperPath = join(runtimeRoot, 'agent-deck-worker');
  writeFileSync(configFile, '{}\n', { mode: 0o600 });
  writeFileSync(bookmarkPath, 'bookmark\n', { mode: 0o600 });
  writeFileSync(launcherPath, '#!/bin/bash\nexit 0\n', { mode: 0o700 });
  writeFileSync(wrapperPath, '#!/bin/bash\nexit 0\n', { mode: 0o700 });
  chmodSync(launcherPath, 0o700);
  chmodSync(wrapperPath, 0o700);
  const spec = parseWorkspaceSandboxSpec({
    schemaVersion: 1,
    execution: 'relay-worker',
    workerConfigId: 'worker-config-a',
    workerId: 'worker-a',
    workspaceRoot,
    privateRoot,
    runtimeReadRoots: [runtimeRoot],
    environment,
    networkBoundary: 'provider-controlled',
  });
  return {
    bookmarkPath,
    configFile,
    environment,
    launcherPath,
    privateRoot,
    root,
    runtimeRoot,
    spec,
    workspaceRoot,
    wrapperPath,
  };
}

describe('workspace sandbox launch policy', () => {
  it('builds a bookmark-authorized macOS Worker launch without an outer Seatbelt layer', () => {
    const paths = fixture();
    const launch = buildDarwinWorkspaceSandboxLaunch(paths.spec, {
      bookmarkPath: paths.bookmarkPath,
      configFile: paths.configFile,
      launcherPath: paths.launcherPath,
      wrapperPath: paths.wrapperPath,
    });

    expect(launch.executable).toBe(paths.launcherPath);
    expect(launch.args).toEqual([
      '--bookmark', paths.bookmarkPath,
      '--workspace', paths.workspaceRoot,
      '--', paths.wrapperPath, 'serve', '--config', paths.configFile,
    ]);
    expect(launch.environment.HOME).toBe(paths.environment.providerHomeRoot);
    expect(launch.environment).toMatchObject({
      CLAUDE_CONFIG_DIR: join(paths.environment.providerHomeRoot, '.claude'),
      CODEX_HOME: join(paths.environment.providerHomeRoot, '.codex'),
      GROK_HOME: join(paths.environment.providerHomeRoot, '.grok'),
      XDG_CACHE_HOME: paths.environment.providerCacheRoot,
      TMPDIR: paths.environment.providerTempRoot,
    });
  });

  it('builds one Linux bwrap namespace with exact writable roots', () => {
    const paths = fixture();
    const providerRuntimeRoot = join(paths.root, 'provider-runtime');
    mkdirSync(providerRuntimeRoot, { mode: 0o700 });
    const launch = buildLinuxWorkspaceSandboxLaunch(paths.spec, {
      configFile: paths.configFile,
      providerRuntimeRoot,
      wrapperPath: paths.wrapperPath,
    });

    expect(launch.executable).toBe('/usr/bin/bwrap');
    expect(launch.args).toContain('--unshare-all');
    expect(launch.args).toContain('--share-net');
    expect(launch.args).toContain('--clearenv');
    expect(launch.args).toContain(paths.runtimeRoot);
    expect(launch.args).toContain(paths.workspaceRoot);
    expect(launch.args).toContain(paths.privateRoot);
    expect(launch.args).toContain(providerRuntimeRoot);
    expect(launch.args.slice(-7)).toEqual([
      '--chdir', paths.workspaceRoot, '--',
      paths.wrapperPath, 'serve', '--config', paths.configFile,
    ]);
    expect(launch.args).not.toContain(paths.root);
    expect(launch.args).toContain(join(paths.environment.providerHomeRoot, '.codex'));
  });

});
