import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  changedHookEvent,
  hooksObject,
  strictHookGroups,
  updateHookConfig,
  type HookGroup,
} from './hook-config-file';

const DEFAULT_OPTIONS = {
  modeForNew: 0o600,
  directoryMode: 0o700,
};

function sessionStartGroup(command: string): HookGroup {
  return {
    hooks: [{ type: 'command', command }],
  };
}

describe('hook config file writer', () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-hook-config-'));
    path = join(root, 'nested', 'hooks.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('changes only an event subtree while preserving comments and unrelated fields', () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    const original = [
      '{',
      '  // user-owned top-level comment',
      '  "custom": { "keep": true },',
      '  "hooks": {',
      '    "SessionStart": [',
      '      { "hooks": [{ "type": "command", "command": "user-hook" }] },',
      '    ],',
      '    "Stop": [{ "hooks": [{ "command": "keep-stop" }] }],',
      '  },',
      '}',
      '',
    ].join('\n');
    writeFileSync(path, original, 'utf8');

    const changed = updateHookConfig(
      path,
      (document) => {
        const hooks = hooksObject(document);
        const before = strictHookGroups(document, hooks, 'SessionStart');
        const change = changedHookEvent('SessionStart', before, [
          ...before,
          sessionStartGroup('agent-deck-hook'),
        ]);
        return { changes: change ? [change] : [] };
      },
      DEFAULT_OPTIONS,
    );
    const after = readFileSync(path, 'utf8');

    expect(changed).toBe(true);
    expect(after).toContain('// user-owned top-level comment');
    expect(after).toContain('"custom": { "keep": true }');
    expect(after).toContain('"command": "keep-stop"');
    expect(after).toContain('"command": "agent-deck-hook"');
  });

  it('uses private defaults for new files and preserves an existing file mode', () => {
    updateHookConfig(
      path,
      () => ({
        changes: [
          {
            path: ['hooks', 'SessionStart'],
            value: [sessionStartGroup('agent-deck-hook')],
          },
        ],
      }),
      DEFAULT_OPTIONS,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'nested')).mode & 0o777).toBe(0o700);

    chmodSync(path, 0o640);
    updateHookConfig(
      path,
      (document) => {
        const hooks = hooksObject(document);
        const before = strictHookGroups(document, hooks, 'Stop');
        const change = changedHookEvent('Stop', before, [
          sessionStartGroup('second-hook'),
        ]);
        return { changes: change ? [change] : [] };
      },
      DEFAULT_OPTIONS,
    );
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('is a true no-op when the updater reports no changes', () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(path, '{"custom":true}\n', 'utf8');
    const before = statSync(path);

    const changed = updateHookConfig(
      path,
      () => ({ changes: [] }),
      DEFAULT_OPTIONS,
    );

    expect(changed).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{"custom":true}\n');
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  });

  it('rejects hook-config symlinks without changing the link or its target', () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    const target = join(root, 'user-owned.json');
    writeFileSync(target, '{"custom":true}\n', 'utf8');
    symlinkSync(target, path);

    expect(() =>
      updateHookConfig(
        path,
        () => ({
          changes: [
            {
              path: ['hooks', 'SessionStart'],
              value: [sessionStartGroup('agent-deck-hook')],
            },
          ],
        }),
        DEFAULT_OPTIONS,
      ),
    ).toThrow('symbolic link');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"custom":true}\n');
  });

  it('detects a competing write before rename and removes its temporary file', () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(path, '{"custom":"before"}\n', 'utf8');
    const competing = '{"custom":"competing"}\n';

    expect(() =>
      updateHookConfig(
        path,
        () => ({
          changes: [
            {
              path: ['hooks', 'SessionStart'],
              value: [sessionStartGroup('agent-deck-hook')],
            },
          ],
        }),
        {
          ...DEFAULT_OPTIONS,
          beforeCommit: () => writeFileSync(path, competing, 'utf8'),
        },
      ),
    ).toThrow('changed while Agent Deck was preparing hooks');

    expect(readFileSync(path, 'utf8')).toBe(competing);
    expect(
      readdirSync(join(root, 'nested')).filter((name) =>
        name.includes('.tmp.'),
      ),
    ).toEqual([]);
  });
});
