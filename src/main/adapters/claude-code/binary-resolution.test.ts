import { describe, expect, it, vi } from 'vitest';
import { resolveClaudeBinaryFromConfig } from './binary-resolution';

describe('Claude binary resolution policy', () => {
  it.each([null, undefined, '', '  \t  '])(
    'uses the bundled binary for an absent override: %j',
    (configuredPath) => {
      const pathExists = vi.fn(() => false);
      const bundledBinary = vi.fn(() => '/opt/agent-deck/bin/claude');
      const observeState = vi.fn();

      expect(
        resolveClaudeBinaryFromConfig(configuredPath, {
          pathExists,
          bundledBinary,
          observeState,
        }),
      ).toBe('/opt/agent-deck/bin/claude');
      expect(pathExists).not.toHaveBeenCalled();
      expect(bundledBinary).toHaveBeenCalledOnce();
      expect(observeState).toHaveBeenCalledWith('healthy');
    },
  );

  it('trims and prefers an existing caller override', () => {
    const pathExists = vi.fn(() => true);
    const bundledBinary = vi.fn(() => '/bundled/claude');
    const observeState = vi.fn();

    expect(
      resolveClaudeBinaryFromConfig('  /srv/tools/claude  ', {
        pathExists,
        bundledBinary,
        observeState,
      }),
    ).toBe('/srv/tools/claude');
    expect(pathExists).toHaveBeenCalledWith('/srv/tools/claude');
    expect(bundledBinary).not.toHaveBeenCalled();
    expect(observeState).toHaveBeenCalledWith('healthy');
  });

  it('falls back and reports a missing non-empty override', () => {
    const observeState = vi.fn();

    expect(
      resolveClaudeBinaryFromConfig('/missing/claude', {
        pathExists: () => false,
        bundledBinary: () => '/bundled/claude',
        observeState,
      }),
    ).toBe('/bundled/claude');
    expect(observeState).toHaveBeenCalledWith('override-missing');
  });

  it('contains observer failures but preserves filesystem and fallback errors', () => {
    expect(
      resolveClaudeBinaryFromConfig('/existing/claude', {
        pathExists: () => true,
        bundledBinary: () => '/bundled/claude',
        observeState: () => {
          throw new Error('diagnostic failure');
        },
      }),
    ).toBe('/existing/claude');

    const existsError = new Error('exists failure');
    expect(() =>
      resolveClaudeBinaryFromConfig('/override', {
        pathExists: () => {
          throw existsError;
        },
        bundledBinary: () => '/bundled/claude',
      }),
    ).toThrow(existsError);

    const fallbackError = new Error('fallback failure');
    expect(() =>
      resolveClaudeBinaryFromConfig(null, {
        pathExists: () => false,
        bundledBinary: () => {
          throw fallbackError;
        },
      }),
    ).toThrow(fallbackError);
  });
});
