import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
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

function waitForWriterReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('FIFO writer did not become ready'));
    }, 1_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const onData = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`FIFO writer exited before ready (${code ?? 'signal'})`));
    };
    child.stdout?.once('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForChildExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('FIFO writer exceeded its bounded lifetime'));
    }, 1_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function startBoundedFifoWriter(fifoPath: string, payload: string): ChildProcess {
  return spawn(
    process.execPath,
    [
      '-e',
      [
        "const fs = require('node:fs');",
        'const fd = fs.openSync(process.argv[1], fs.constants.O_WRONLY);',
        "fs.writeFileSync(fd, process.argv[2], 'utf8');",
        "process.stdout.write('ready\\n');",
        'setTimeout(() => fs.closeSync(fd), 250);',
      ].join(' '),
      fifoPath,
      payload,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
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

  it('does not replace a dangling hook-config symlink mistaken for an absent file', () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    const missingTarget = join(root, 'missing-user-owned.json');
    symlinkSync(missingTarget, path);

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
    expect(
      readdirSync(join(root, 'nested')).filter((name) =>
        name.includes('.tmp.'),
      ),
    ).toEqual([]);
  });

  it('detects a dangling symlink that replaces an absent target during CAS', () => {
    const missingTarget = join(root, 'missing-competing.json');

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
          beforeCommit: () => symlinkSync(missingTarget, path),
        },
      ),
    ).toThrow('changed type while Agent Deck was preparing hooks');

    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(
      readdirSync(join(root, 'nested')).filter((name) =>
        name.includes('.tmp.'),
      ),
    ).toEqual([]);
  });

  it('rejects a symlink to a FIFO before reading it with bounded process cleanup', async () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    const fifoPath = join(root, 'hook-config-fifo');
    execFileSync('mkfifo', [fifoPath], { timeout: 1_000 });
    symlinkSync(fifoPath, path);
    const payload = '{"mustRemainUnread":true}\n';
    const guardFd = openSync(
      fifoPath,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    const writer = startBoundedFifoWriter(fifoPath, payload);

    try {
      await waitForWriterReady(writer);
      expect(() =>
        updateHookConfig(
          path,
          () => ({ changes: [] }),
          DEFAULT_OPTIONS,
        ),
      ).toThrow('symbolic link');
      expect(await waitForChildExit(writer)).toBe(0);

      const remaining = Buffer.alloc(Buffer.byteLength(payload) + 1);
      const bytesRead = readSync(
        guardFd,
        remaining,
        0,
        remaining.length,
        null,
      );
      expect(remaining.subarray(0, bytesRead).toString('utf8')).toBe(payload);
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill('SIGKILL');
        await waitForChildExit(writer).catch(() => undefined);
      }
      closeSync(guardFd);
    }
  }, 3_000);

  it('rejects a non-regular FIFO before reading it with bounded process cleanup', async () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    execFileSync('mkfifo', [path], { timeout: 1_000 });
    const payload = '{"fifoMustRemainUnread":true}\n';
    const guardFd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    const writer = startBoundedFifoWriter(path, payload);

    try {
      await waitForWriterReady(writer);
      expect(() =>
        updateHookConfig(
          path,
          () => ({ changes: [] }),
          DEFAULT_OPTIONS,
        ),
      ).toThrow('not a regular file');
      expect(await waitForChildExit(writer)).toBe(0);

      const remaining = Buffer.alloc(Buffer.byteLength(payload) + 1);
      const bytesRead = readSync(
        guardFd,
        remaining,
        0,
        remaining.length,
        null,
      );
      expect(remaining.subarray(0, bytesRead).toString('utf8')).toBe(payload);
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill('SIGKILL');
        await waitForChildExit(writer).catch(() => undefined);
      }
      closeSync(guardFd);
    }
  }, 3_000);

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
