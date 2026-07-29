import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    safeDiagnostic: vi.fn((value: unknown) => value),
    getProcessRunId: vi.fn(() => 'shell-path-test-run'),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: mocks.loggerScope },
}));
vi.mock('@main/utils/safe-diagnostic', () => ({
  safeDiagnostic: mocks.safeDiagnostic,
}));
vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: mocks.getProcessRunId,
}));

type Subject = typeof import('../user-shell-path');

async function freshImport(): Promise<Subject> {
  vi.resetModules();
  return import('../user-shell-path');
}

function wrap(marker: string, path: string): string {
  return `${marker}${path}${marker}\n`;
}

function loggedText(): string {
  return [
    ...mocks.logger.info.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.error.mock.calls,
  ].flat().map(String).join(' ');
}

describe('captureUserShellPath', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loggerScope.mockReturnValue(mocks.logger);
    mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
    mocks.getProcessRunId.mockReturnValue('shell-path-test-run');
    vi.stubEnv('SHELL', '/bin/test-shell');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses exact shell argv/options and returns the first valid marked PATH', async () => {
    const subject = await freshImport();
    const hostilePath =
      '/Users/private/.nvm/bin:/opt/homebrew/bin:/path?token=secret';
    mocks.execFileSync.mockReturnValue(
      `rc noise ${subject.NONCE_MARKER}unterminated\n` +
        wrap(subject.NONCE_MARKER, hostilePath) +
        wrap(subject.NONCE_MARKER, '/later/path'),
    );

    expect(subject.captureUserShellPath()).toBe(hostilePath);
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      '/bin/test-shell',
      [
        '-ilc',
        `printf "${subject.NONCE_MARKER}%s${subject.NONCE_MARKER}\\n" "$PATH"`,
      ],
      {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('preserves empty marked PATH as distinct from a missing marker', async () => {
    const subject = await freshImport();
    mocks.execFileSync.mockReturnValue(wrap(subject.NONCE_MARKER, ''));

    expect(subject.captureUserShellPath()).toBe('');
    expect(subject.captureUserShellPath()).toBe('');
    expect(subject.unionUserShellPath('/process/bin')).toBe('/process/bin');
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('warns once with fixed fields for a missing marker and memoizes null', async () => {
    const subject = await freshImport();
    mocks.execFileSync.mockReturnValue(
      'RAW_STDOUT token=private /Users/private/repo https://private.test\n',
    );

    expect(subject.captureUserShellPath()).toBeNull();
    expect(subject.captureUserShellPath()).toBeNull();
    expect(subject.unionUserShellPath('/process/bin')).toBe('/process/bin');
    expect(subject.unionUserShellPath(undefined)).toBe('');
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'user shell path capture unavailable',
      {
        event: 'user-shell-path',
        runId: 'shell-path-test-run',
        state: 'missing-marker',
        fallback: 'process-env',
      },
    );
    expect(Object.keys(
      mocks.logger.warn.mock.calls[0]?.[1] as Record<string, unknown>,
    ).sort()).toEqual(['event', 'fallback', 'runId', 'state']);
    expect(loggedText()).not.toMatch(
      /RAW_STDOUT|private|\/Users\/private|https:\/\//,
    );
  });

  it('warns once with fixed fields for capture failure and memoizes null', async () => {
    vi.stubEnv(
      'SHELL',
      '/Users/private/hostile shell;token=secret https://private.test',
    );
    const subject = await freshImport();
    const rawError = new Error(
      'RAW_SHELL_ERROR token=private /Users/private/repo https://private.test',
    );
    rawError.name = 'PrivateShellError';
    mocks.execFileSync.mockImplementation(() => {
      throw rawError;
    });

    expect(subject.captureUserShellPath()).toBeNull();
    expect(subject.captureUserShellPath()).toBeNull();
    expect(subject.unionUserShellPath('/fallback/bin')).toBe('/fallback/bin');
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'user shell path capture unavailable',
      {
        event: 'user-shell-path',
        runId: 'shell-path-test-run',
        state: 'capture-failed',
        fallback: 'process-env',
      },
    );
    expect(loggedText()).not.toMatch(
      /RAW_SHELL|PrivateShellError|hostile shell|private|\/Users\/private|https:\/\//,
    );
  });

  it('falls back to /bin/zsh when SHELL is empty', async () => {
    vi.stubEnv('SHELL', '');
    const subject = await freshImport();
    mocks.execFileSync.mockReturnValue(wrap(subject.NONCE_MARKER, '/usr/bin'));

    expect(subject.captureUserShellPath()).toBe('/usr/bin');
    expect(mocks.execFileSync.mock.calls[0]?.[0]).toBe('/bin/zsh');
  });

  it('memoizes successful capture across direct and union callers', async () => {
    const subject = await freshImport();
    mocks.execFileSync.mockReturnValue(
      wrap(subject.NONCE_MARKER, '/user/bin:/usr/bin'),
    );

    expect(subject.captureUserShellPath()).toBe('/user/bin:/usr/bin');
    expect(subject.captureUserShellPath()).toBe('/user/bin:/usr/bin');
    expect(subject.unionUserShellPath('/usr/bin:/process/bin')).toBe(
      '/user/bin:/usr/bin:/process/bin',
    );
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
  });

  it.each([
    ['serializer', () => mocks.safeDiagnostic.mockImplementation(() => {
      throw new Error('RAW_SERIALIZER');
    })],
    ['run id', () => mocks.getProcessRunId.mockImplementation(() => {
      throw new Error('RAW_RUN_ID');
    })],
    ['sink', () => mocks.logger.warn.mockImplementation(() => {
      throw new Error('RAW_SINK');
    })],
  ])('contains %s failure and preserves failed memo and union fallback', async (
    _name,
    fail,
  ) => {
    const subject = await freshImport();
    fail();
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('RAW_CAPTURE');
    });

    expect(subject.captureUserShellPath()).toBeNull();
    expect(subject.captureUserShellPath()).toBeNull();
    expect(subject.unionUserShellPath('/process/bin')).toBe('/process/bin');
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
  });

  it('contains logger scope failure and preserves failed memo and fallback', async () => {
    mocks.loggerScope.mockImplementation(() => {
      throw new Error('RAW_SCOPE');
    });
    const subject = await freshImport();
    mocks.execFileSync.mockReturnValue('missing marker');

    expect(subject.captureUserShellPath()).toBeNull();
    expect(subject.captureUserShellPath()).toBeNull();
    expect(subject.unionUserShellPath('/process/bin')).toBe('/process/bin');
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
  });

  it('does not emit shell, PATH, output, error, or nonce content', async () => {
    vi.stubEnv('SHELL', '/private/nonce-shell');
    const subject = await freshImport();
    mocks.execFileSync.mockReturnValue(
      `output=${subject.NONCE_MARKER} RAW_NONCE_OUTPUT /Users/private`,
    );

    expect(subject.captureUserShellPath()).toBeNull();
    expect(loggedText()).not.toContain(subject.NONCE_MARKER);
    expect(loggedText()).not.toMatch(
      /nonce-shell|RAW_NONCE_OUTPUT|\/Users\/private/,
    );
  });
});

describe('nonce and PATH union behavior', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loggerScope.mockReturnValue(mocks.logger);
    mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
    mocks.getProcessRunId.mockReturnValue('shell-path-test-run');
    vi.stubEnv('SHELL', '/bin/test-shell');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('generates a fresh UUID marker for each module load', async () => {
    const first = (await freshImport()).NONCE_MARKER;
    const second = (await freshImport()).NONCE_MARKER;
    const third = (await freshImport()).NONCE_MARKER;

    expect(new Set([first, second, third]).size).toBe(3);
    expect(first).toMatch(
      /^__AD_PATH_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}__$/,
    );
  });

  it('deduplicates in order while preserving one empty segment', async () => {
    const subject = await freshImport();

    expect(subject.dedupePath(undefined)).toBe('');
    expect(subject.dedupePath('')).toBe('');
    expect(subject.dedupePath('/a:/b:/a:/c:/b')).toBe('/a:/b:/c');
    expect(subject.dedupePath('/a::/a::/b')).toBe('/a::/b');
  });

  it('keeps user PATH first and original PATH as the fallback tail', async () => {
    const subject = await freshImport();
    mocks.execFileSync.mockReturnValue(
      wrap(subject.NONCE_MARKER, '/user/bin:/usr/bin'),
    );

    expect(subject.unionUserShellPath('/usr/bin:/process/bin')).toBe(
      '/user/bin:/usr/bin:/process/bin',
    );
  });

  it.each([undefined, ''])(
    'returns only user PATH when original PATH is %s',
    async (originalPath) => {
      const subject = await freshImport();
      mocks.execFileSync.mockReturnValue(
        wrap(subject.NONCE_MARKER, '/user/bin:/usr/bin'),
      );

      expect(subject.unionUserShellPath(originalPath)).toBe(
        '/user/bin:/usr/bin',
      );
    },
  );

  it('preserves original fallback for an explicitly unsupported shell', async () => {
    vi.stubEnv('SHELL', '/usr/local/bin/fish');
    const subject = await freshImport();
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('unsupported -ilc');
    });

    expect(subject.unionUserShellPath('/process/bin')).toBe('/process/bin');
    expect(mocks.execFileSync).toHaveBeenCalledOnce();
  });
});
