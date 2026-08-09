import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateCodexUsageSnapshotClient,
  readCodexUsageSnapshotWithHost,
  type CodexUsageSnapshotHost,
} from './usage-snapshot-core';

function host(
  createClient: CodexUsageSnapshotHost['createClient'],
): CodexUsageSnapshotHost {
  return {
    createClient,
    readCodexCliPath: vi.fn(() => '  /opt/codex  '),
    readProbeCwd: vi.fn(() => '/usage-probe'),
    snapshotProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
  };
}

describe('Codex usage snapshot Core', () => {
  afterEach(() => {
    invalidateCodexUsageSnapshotClient();
  });

  it('normalizes host values and owns the SDK origin identity', async () => {
    const request = vi.fn().mockResolvedValue({ rateLimitsByLimitId: {} });
    const dispose = vi.fn();
    const createClient = vi.fn(() => ({ request, dispose }));
    const dependencies = host(createClient);

    await readCodexUsageSnapshotWithHost(dependencies, {
      cacheClient: false,
    });

    expect(dependencies.readCodexCliPath).toHaveBeenCalledOnce();
    expect(dependencies.readProbeCwd).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      codexPathOverride: '/opt/codex',
      config: null,
      cwd: '/usage-probe',
      env: { AGENT_DECK_ORIGIN: 'sdk', PATH: '/usr/bin' },
    });
    expect(request).toHaveBeenCalledWith('account/rateLimits/read', undefined);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps explicit probe dependencies ahead of host discovery', async () => {
    const makeClient = vi.fn(() => ({
      request: vi.fn().mockResolvedValue({ rateLimitsByLimitId: {} }),
      dispose: vi.fn(),
    }));
    const dependencies = host(vi.fn());

    await readCodexUsageSnapshotWithHost(dependencies, {
      codexPathOverride: ' /custom/codex ',
      getProbeCwdFn: () => '/custom/probe',
      makeClient,
    });

    expect(dependencies.readCodexCliPath).not.toHaveBeenCalled();
    expect(dependencies.readProbeCwd).not.toHaveBeenCalled();
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(makeClient).toHaveBeenCalledWith({
      codexPathOverride: '/custom/codex',
      cwd: '/custom/probe',
      env: { AGENT_DECK_ORIGIN: 'sdk', PATH: '/usr/bin' },
    });
  });
});
