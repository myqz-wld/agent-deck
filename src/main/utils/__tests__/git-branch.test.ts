import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    execFileSync: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
}));

let subject: typeof import('../git-branch');

describe('detectGitBranchName', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    subject = await import('../git-branch');
  });

  it.each([null, undefined, ''])(
    'returns null without spawning git for an absent cwd (%s)',
    (cwd) => {
      expect(subject.detectGitBranchName(cwd)).toBeNull();
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    },
  );

  it('uses the exact argv, stdio, encoding, and timeout contract', () => {
    const hostileCwd =
      '/Users/private/repo with spaces;$(touch token)/https://secret.test';
    mocks.execFileSync.mockReturnValue('  feature/branch-snapshot \n');

    expect(subject.detectGitBranchName(hostileCwd)).toBe(
      'feature/branch-snapshot',
    );
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', hostileCwd, 'branch', '--show-current'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1_000,
      },
    );
  });

  it('normalizes empty and oversized branch output to null', () => {
    mocks.execFileSync
      .mockReturnValueOnce(' \n')
      .mockReturnValueOnce(`${'a'.repeat(256)}\n`);

    expect(subject.detectGitBranchName('/repo/empty')).toBeNull();
    expect(subject.detectGitBranchName('/repo/oversized')).toBeNull();
  });

  it('returns null for hostile cwd and execution errors', () => {
    const hostileCwd =
      '/Users/private/raw-repo?token=secret&url=https://private.test';
    const rawError = new Error(
      'RAW_GIT_ERROR token=private /Users/private/repo https://private.test',
    );
    rawError.name = 'PrivateGitError';
    mocks.execFileSync.mockImplementation(() => {
      throw rawError;
    });

    expect(subject.detectGitBranchName(hostileCwd)).toBeNull();
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', hostileCwd, 'branch', '--show-current'],
      expect.objectContaining({ timeout: 1_000 }),
    );
  });
});
