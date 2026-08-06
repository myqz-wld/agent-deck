import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HookInstallerCore } from './hook-installer-core';

describe('Claude hook installer Core', () => {
  it('degrades malformed status to repairable absence through the injected observer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-deck-hook-core-'));
    try {
      await mkdir(join(cwd, '.claude'), { recursive: true });
      await writeFile(join(cwd, '.claude', 'settings.json'), '{"hooks":', 'utf8');
      const observer = { statusReadFailed: vi.fn() };
      const installer = new HookInstallerCore(
        47_821,
        'a'.repeat(64),
        join(cwd, 'relay'),
        observer,
      );

      expect(installer.status({ scope: 'project', cwd })).toEqual({
        installed: false,
        scope: 'project',
        settingsPath: join(cwd, '.claude', 'settings.json'),
        installedHooks: [],
      });
      expect(observer.statusReadFailed).toHaveBeenCalledOnce();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
