import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => {
  const fn = vi.fn();
  const custom = Symbol.for('nodejs.util.promisify.custom');
  Object.assign(fn, {
    [custom]: (cmd: string, args: string[], opts: unknown) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        fn(cmd, args, opts, (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      }),
  });
  return fn;
});
const existsSyncMock = vi.hoisted(() => vi.fn());
const sessionRepoMock = vi.hoisted(() => ({ get: vi.fn() }));
const fileChangeRepoMock = vi.hoisted(() => ({ listForSession: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: sessionRepoMock }));
vi.mock('@main/store/file-change-repo', () => ({ fileChangeRepo: fileChangeRepoMock }));

import { getSessionFileFinalDiff } from '../final-file-diff';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function mockGit(responses: Array<{ stdout?: string; stderr?: string; code?: number }>): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      const next = responses.shift();
      if (!next) throw new Error('unexpected git call');
      if (next.code !== undefined) {
        const err = new Error(next.stderr ?? `exit ${next.code}`) as Error & {
          stdout?: string;
          stderr?: string;
          code?: number;
        };
        err.stdout = next.stdout ?? '';
        err.stderr = next.stderr ?? '';
        err.code = next.code;
        cb(err, err.stdout, err.stderr);
        return;
      }
      cb(null, next.stdout ?? '', next.stderr ?? '');
    },
  );
}

describe('getSessionFileFinalDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRepoMock.get.mockReturnValue({ id: 's1', cwd: '/repo' });
    fileChangeRepoMock.listForSession.mockReturnValue([
      { filePath: '/repo/src/a.ts' },
      { filePath: '/repo/new.txt' },
    ]);
    existsSyncMock.mockReturnValue(true);
  });

  it('rejects paths that are not recorded in file_changes for the session', async () => {
    const result = await getSessionFileFinalDiff('s1', '/repo/other.ts');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_in_session');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns git diff HEAD for tracked files', async () => {
    mockGit([
      { stdout: '/repo\n' },
      { stdout: 'src/a.ts\n' },
      { stdout: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' },
    ]);

    const result = await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(result.ok).toBe(true);
    expect(result.diff).toContain('diff --git');
    expect(execFileMock.mock.calls[2][1]).toEqual([
      'diff',
      '--no-ext-diff',
      'HEAD',
      '--',
      'src/a.ts',
    ]);
  });

  it('uses no-index diff for untracked new files', async () => {
    mockGit([
      { stdout: '/repo\n' },
      { code: 1, stderr: 'not tracked' },
      { code: 1, stdout: 'diff --git a/dev/null b/repo/new.txt\n+hello\n' },
    ]);

    const result = await getSessionFileFinalDiff('s1', '/repo/new.txt');

    expect(result.ok).toBe(true);
    expect(result.diff).toContain('+hello');
    expect(execFileMock.mock.calls[2][1]).toEqual([
      'diff',
      '--no-ext-diff',
      '--no-index',
      '--',
      '/dev/null',
      '/repo/new.txt',
    ]);
  });
});
