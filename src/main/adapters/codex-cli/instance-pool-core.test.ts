import { describe, expect, it, vi } from 'vitest';
import {
  createCodexInstancePool,
  type CodexInstancePoolHost,
} from './instance-pool-core';

interface TestClient {
  dispose(): void;
  name: string;
}

function host(
  createClient: CodexInstancePoolHost<TestClient>['createClient'],
): CodexInstancePoolHost<TestClient> {
  return {
    createClient,
    readCodexCliPath: vi.fn(() => '  /opt/codex  '),
    snapshotProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
  };
}

describe('Codex instance pool Core', () => {
  it('reads the current path on every get but constructs host state only on a miss', () => {
    const client = { dispose: vi.fn(), name: 'client-a' };
    const createClient = vi.fn(() => client);
    const dependencies = host(createClient);
    const pool = createCodexInstancePool(dependencies);

    expect(pool.get()).toBe(client);
    expect(pool.get()).toBe(client);
    expect(dependencies.readCodexCliPath).toHaveBeenCalledTimes(2);
    expect(dependencies.snapshotProcessEnv).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      codexPathOverride: '/opt/codex',
      config: null,
      env: { AGENT_DECK_ORIGIN: 'sdk', PATH: '/usr/bin' },
    });
  });

  it('retires the old identity before constructing a changed path', () => {
    const first = { dispose: vi.fn(), name: 'client-a' };
    const second = { dispose: vi.fn(), name: 'client-b' };
    const createClient = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const dependencies = host(createClient);
    vi.mocked(dependencies.readCodexCliPath)
      .mockReturnValueOnce('/opt/codex-a')
      .mockReturnValueOnce('/opt/codex-b');
    const pool = createCodexInstancePool(dependencies);

    expect(pool.get()).toBe(first);
    expect(pool.get()).toBe(second);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(createClient.mock.calls.map(([options]) => options.codexPathOverride))
      .toEqual(['/opt/codex-a', '/opt/codex-b']);
  });
});
