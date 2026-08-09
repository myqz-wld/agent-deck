import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrokResourceStore } from '../resource-store';

let root = '';
let configRoot = '';
let userDataPath = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-deck-grok-resource-store-'));
  configRoot = join(root, 'grok-config');
  userDataPath = join(root, 'user-data');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'GROK_AGENTS.md'), '# bundled\n', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Grok resource store', () => {
  it('owns custom convention files through explicit roots', async () => {
    const store = createGrokResourceStore({ configRoot, userDataPath });

    await expect(store.getActiveAgents()).resolves.toEqual({
      content: '# bundled\n',
      isCustom: false,
    });
    await expect(store.saveUserAgents('# custom\n')).resolves.toEqual({
      content: '# custom\n',
      isCustom: true,
    });
    await expect(store.loadBaselinePrompt()).resolves.toBe('# custom');

    await store.resetUserAgents();
    await expect(store.getActiveAgents()).resolves.toEqual({
      content: '# bundled\n',
      isCustom: false,
    });
  });

  it('reports non-missing custom read failures without losing the baseline', async () => {
    await writeFile(userDataPath, 'not-a-directory', 'utf8');
    const warn = vi.fn();
    const store = createGrokResourceStore({
      configRoot,
      userDataPath,
      diagnostics: { warn },
    });

    await expect(store.getActiveAgents()).resolves.toEqual({
      content: '# bundled\n',
      isCustom: false,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[grok-resources] failed to read custom application convention',
    );
  });

  it('deduplicates and materializes capability-specific plugin mirrors', async () => {
    const pluginRoot = join(configRoot, 'agent-deck-plugin');
    await mkdir(join(pluginRoot, 'skills'), { recursive: true });
    await mkdir(join(pluginRoot, 'agents'), { recursive: true });
    await writeFile(join(pluginRoot, 'plugin.json'), '{"name":"fixture"}', 'utf8');
    await writeFile(join(pluginRoot, 'skills', 'skill.md'), '# skill', 'utf8');
    await writeFile(join(pluginRoot, 'agents', 'agent.md'), '# agent', 'utf8');
    const store = createGrokResourceStore({ configRoot, userDataPath });

    const first = store.preparePluginProfile({ includeSkills: true, includeAgents: false });
    const second = store.preparePluginProfile({ includeSkills: true, includeAgents: false });
    expect(second).toBe(first);

    const target = await first;
    expect(target).toBe(join(userDataPath, 'grok-plugin-profiles', 'skills'));
    await expect(readFile(join(target!, 'plugin.json'), 'utf8')).resolves.toBe(
      '{"name":"fixture"}',
    );
    await expect(readFile(join(target!, 'skills', 'skill.md'), 'utf8')).resolves.toBe(
      '# skill',
    );
    await expect(access(join(target!, 'agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      store.preparePluginProfile({ includeSkills: false, includeAgents: false }),
    ).resolves.toBeNull();
  });
});
