import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexAgentsMdStore } from './agents-md-store';

let root = '';
let builtinPath = '';
let userPath = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-deck-codex-agents-store-'));
  builtinPath = join(root, 'resources', 'codex-config', 'CODEX_AGENTS.md');
  userPath = join(root, 'user-data', 'agent-deck-codex-agents.md');
  mkdirSync(join(root, 'resources', 'codex-config'), { recursive: true });
  writeFileSync(builtinPath, '# bundled\n', 'utf8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Codex agents markdown store', () => {
  it('caches active content and invalidates after explicit mutations', () => {
    const store = createCodexAgentsMdStore({ builtinPath, userPath });

    expect(store.getContent()).toBe('# bundled\n');
    writeFileSync(builtinPath, '# bundled v2\n', 'utf8');
    expect(store.getContent()).toBe('# bundled\n');
    store.invalidate();
    expect(store.getContent()).toBe('# bundled v2\n');

    expect(store.saveUser('# custom\n')).toEqual({
      content: '# custom\n',
      isCustom: true,
    });
    expect(store.getContent()).toBe('# custom\n');
    expect(store.getActive()).toEqual({ content: '# custom\n', isCustom: true });

    store.resetUser();
    expect(store.getActive()).toEqual({
      content: '# bundled v2\n',
      isCustom: false,
    });
  });

  it('reports an unreadable custom source and falls back to the bundle', () => {
    mkdirSync(userPath, { recursive: true });
    const warn = vi.fn();
    const store = createCodexAgentsMdStore({
      builtinPath,
      userPath,
      diagnostics: { warn },
    });

    expect(store.getActive()).toEqual({ content: '# bundled\n', isCustom: false });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[codex-agents-md] failed to read custom application convention',
    );
  });

  it('distinguishes required session content from best-effort settings reads', () => {
    const warn = vi.fn();
    const store = createCodexAgentsMdStore({
      builtinPath: join(root, 'missing', 'CODEX_AGENTS.md'),
      userPath,
      diagnostics: { warn },
    });

    expect(() => store.getContent()).toThrow(
      'codex-config/CODEX_AGENTS.md missing or unreadable, build/dev config error',
    );
    expect(store.getBuiltin()).toBe('');
    expect(warn).toHaveBeenCalledOnce();
  });
});
