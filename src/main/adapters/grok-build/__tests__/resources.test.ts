import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ appPath: '', userData: '' }));
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => paths.appPath,
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected path ${name}`);
      return paths.userData;
    },
  },
}));
vi.mock('@main/utils/logger', () => ({
  default: {
    scope: () => ({ warn: vi.fn() }),
  },
}));

import {
  getActiveGrokAgentsMd,
  loadGrokBaselinePrompt,
  resetUserGrokAgentsMd,
  saveUserGrokAgentsMd,
} from '../resources';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-deck-grok-resources-'));
  paths.appPath = root;
  paths.userData = join(root, 'user-data');
  const configRoot = join(root, 'resources', 'grok-config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'GROK_AGENTS.md'), '# bundled\n', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Grok application convention', () => {
  it('uses an app-owned custom copy and restores the packaged default', async () => {
    await expect(getActiveGrokAgentsMd()).resolves.toEqual({
      content: '# bundled\n',
      isCustom: false,
    });

    await expect(saveUserGrokAgentsMd('# custom\n')).resolves.toEqual({
      content: '# custom\n',
      isCustom: true,
    });
    await expect(loadGrokBaselinePrompt()).resolves.toBe('# custom');
    await expect(
      readFile(join(paths.userData, 'agent-deck-grok-agents.md'), 'utf8'),
    ).resolves.toBe('# custom\n');

    await resetUserGrokAgentsMd();
    await expect(getActiveGrokAgentsMd()).resolves.toEqual({
      content: '# bundled\n',
      isCustom: false,
    });
  });
});
