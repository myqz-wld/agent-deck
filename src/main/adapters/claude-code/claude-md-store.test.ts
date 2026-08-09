import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeMdStore } from './claude-md-store';

let root = '';
let builtinPath = '';
let userPath = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-deck-claude-md-store-'));
  builtinPath = join(root, 'resources', 'claude-config', 'CLAUDE.md');
  userPath = join(root, 'user-data', 'agent-deck-claude.md');
  mkdirSync(join(root, 'resources', 'claude-config'), { recursive: true });
  writeFileSync(builtinPath, '# bundled\n', 'utf8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Claude markdown store', () => {
  it('owns app-local custom convention mutations through explicit paths', () => {
    const store = createClaudeMdStore({ builtinPath, userPath });

    expect(store.getActive()).toEqual({ content: '# bundled\n', isCustom: false });
    expect(store.saveUser('# custom\n')).toEqual({
      content: '# custom\n',
      isCustom: true,
    });
    expect(store.getActive()).toEqual({ content: '# custom\n', isCustom: true });

    store.resetUser();
    expect(store.getActive()).toEqual({ content: '# bundled\n', isCustom: false });
  });

  it('reports an unreadable custom source and falls back to the bundle', () => {
    mkdirSync(userPath, { recursive: true });
    const warn = vi.fn();
    const store = createClaudeMdStore({
      builtinPath,
      userPath,
      diagnostics: { warn },
    });

    expect(store.getActive()).toEqual({ content: '# bundled\n', isCustom: false });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[claude-md] failed to read custom application convention',
    );
  });

  it('keeps a missing bundled baseline observable and non-blocking', () => {
    const warn = vi.fn();
    const store = createClaudeMdStore({
      builtinPath: join(root, 'missing', 'CLAUDE.md'),
      userPath,
      diagnostics: { warn },
    });

    expect(store.getBuiltin()).toBe('');
    expect(store.getActive()).toEqual({ content: '', isCustom: false });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
