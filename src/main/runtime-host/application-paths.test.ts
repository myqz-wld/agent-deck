import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createApplicationHostPaths,
  getApplicationHostPaths,
  installApplicationHostPaths,
} from './application-paths';
import { resolveApplicationResourcesRoot } from './application-resources';
import {
  resolveImageUploadsDir,
  resolveProviderUsageProbeCwd,
} from '@main/paths';
import { resolveCodexAgentDeckPluginPath } from '@main/adapters/codex-cli/codex-config-paths';

const base = Object.freeze({
  isPackaged: false,
  appPath: '/opt/agent-deck/source',
  resourcesPath: '/opt/agent-deck/resources',
  userDataPath: '/var/lib/agent-deck/instance-a',
});

describe('application host paths', () => {
  it('validates and freezes one bounded absolute host identity', () => {
    const paths = createApplicationHostPaths(base);
    expect(paths).toEqual(base);
    expect(Object.isFrozen(paths)).toBe(true);
    expect(() => createApplicationHostPaths({ ...base, appPath: 'relative' }))
      .toThrow('bounded absolute host path');
    expect(() => createApplicationHostPaths({ ...base, userDataPath: `/tmp/${'x'.repeat(4_096)}` }))
      .toThrow('bounded absolute host path');
  });

  it('keeps the installed process identity immutable', () => {
    const installed = getApplicationHostPaths();
    expect(() => installApplicationHostPaths(installed)).not.toThrow();
    expect(() => installApplicationHostPaths({ ...installed, userDataPath: '/tmp/other-host' }))
      .toThrow('already installed for another host');
  });

  it('derives Core-owned data paths without Electron or launch cwd', () => {
    expect(resolveImageUploadsDir(base)).toBe(
      join(base.userDataPath, 'image-uploads'),
    );
    expect(resolveProviderUsageProbeCwd(base)).toBe(
      join(base.userDataPath, 'provider-usage-probe-cwd'),
    );
  });

  it('resolves Codex bundled assets from explicit dev and packaged hosts', () => {
    expect(resolveApplicationResourcesRoot(base)).toBe(join(base.appPath, 'resources'));
    expect(resolveApplicationResourcesRoot({ ...base, isPackaged: true })).toBe(
      base.resourcesPath,
    );
    expect(resolveCodexAgentDeckPluginPath(base)).toBe(
      join(base.appPath, 'resources', 'codex-config', 'agent-deck-plugin'),
    );
    expect(resolveCodexAgentDeckPluginPath({ ...base, isPackaged: true })).toBe(
      join(base.resourcesPath, 'codex-config', 'agent-deck-plugin'),
    );
  });
});
