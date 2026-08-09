import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  providerSessionSupervisorEntrypointFailureMessage,
  runProviderSessionSupervisorEntrypoint,
} from './host-entrypoint';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('Provider supervisor host entrypoint diagnostics', () => {
  it('prepares missing runtime roots from one trusted exact config', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-host-')));
    roots.push(root);
    const privateRoot = join(root, 'private');
    const configPath = join(root, 'provider.json');
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      brokerRoot: join(privateRoot, 'broker'),
      desktopSocketPath: join(root, 'engine.sock'),
      desktopVm: 'colima',
      engine: 'docker-desktop',
      executable: '/opt/agent-deck/bin/docker',
      images: {
        'claude-code-v1': null,
        'codex-cli-v1': null,
        'grok-build-v1': `sha256:${'a'.repeat(64)}`,
      },
      instanceId: 'instance-a',
      maxActive: 8,
      privateRoot,
      rootlessHome: null,
      rootlessRuntimeDirectory: null,
      stateRoot: join(privateRoot, 'state'),
      transportRuntimeDirectory: join(privateRoot, 'supervisor'),
      transportSocketPath: join(privateRoot, 'supervisor', 's.sock'),
      workspaceRoot: join(root, 'workspace'),
    }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    await expect(runProviderSessionSupervisorEntrypoint([
      'prepare-runtime', '--config', configPath,
    ])).resolves.toBe(0);
    for (const path of [privateRoot, join(privateRoot, 'broker'),
      join(privateRoot, 'state'), join(privateRoot, 'supervisor')]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it('shows bounded diagnostic causes while keeping serve failures private', () => {
    expect(providerSessionSupervisorEntrypointFailureMessage(
      ['runtime-paths'], new Error('socket namespace\nexceeded'),
    )).toBe('Provider supervisor runtime-paths 失败：socket namespace exceeded');
    expect(providerSessionSupervisorEntrypointFailureMessage(
      ['check-config'], new Error('headless config could not be read safely', {
        cause: new Error('config file trust check failed\nmode must be private'),
      }),
    )).toBe(
      'Provider supervisor check-config 失败：headless config could not be read safely：' +
      'config file trust check failed mode must be private',
    );
    expect(providerSessionSupervisorEntrypointFailureMessage(
      ['serve'], new Error('private detail'),
    )).toBe('Provider supervisor 启动失败；详细输入已隐藏。');
  });
});
