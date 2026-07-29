import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    logger,
    execFileSync: vi.fn(),
    loggerScope: vi.fn(() => logger),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: mocks.loggerScope },
}));

let subject: typeof import('../git-branch');

function loggedText(): string {
  return [
    ...mocks.logger.debug.mock.calls,
    ...mocks.logger.info.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.error.mock.calls,
  ].flat().map(String).join(' ');
}

describe('detectGitBranchName', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.loggerScope.mockReturnValue(mocks.logger);
    subject = await import('../git-branch');
  });

  it.each([null, undefined, ''])(
    'returns null without spawning git for an absent cwd (%s)',
    (cwd) => {
      expect(subject.detectGitBranchName(cwd)).toBeNull();
      expect(mocks.execFileSync).not.toHaveBeenCalled();
      expect(mocks.loggerScope).not.toHaveBeenCalled();
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
    expect(mocks.loggerScope).not.toHaveBeenCalled();
  });

  it('normalizes empty and oversized branch output to null', () => {
    mocks.execFileSync
      .mockReturnValueOnce(' \n')
      .mockReturnValueOnce(`${'a'.repeat(256)}\n`);

    expect(subject.detectGitBranchName('/repo/empty')).toBeNull();
    expect(subject.detectGitBranchName('/repo/oversized')).toBeNull();
    expect(mocks.logger.debug).not.toHaveBeenCalled();
  });

  it('keeps hostile cwd and execution errors silent while returning null', () => {
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
    expect(mocks.loggerScope).not.toHaveBeenCalled();
    expect(mocks.logger.debug).not.toHaveBeenCalled();
    expect(loggedText()).toBe('');
  });
});
