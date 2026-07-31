import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clients: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  return {
    clients,
    CodexAppServerClient: vi.fn(() => {
      const client = { dispose: vi.fn() };
      clients.push(client);
      return client;
    }),
    settingsStore: {
      get: vi.fn(() => null),
    },
    resolveCodexConfigProfile: vi.fn((value: string | null | undefined) => {
      const id = value?.trim();
      return id ? { id, configPath: `/profiles/${id}.config.toml` } : null;
    }),
  };
});

vi.mock('@main/adapters/codex-cli/app-server/client', () => ({
  CodexAppServerClient: mocks.CodexAppServerClient,
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: mocks.settingsStore,
}));
vi.mock('@main/codex-config/profiles', () => ({
  resolveCodexConfigProfile: mocks.resolveCodexConfigProfile,
}));

import { getCodexInstance, invalidateCodexInstance } from '../codex-instance-pool';

describe('codex oneshot instance pool', () => {
  beforeEach(() => {
    invalidateCodexInstance();
    mocks.clients.length = 0;
    mocks.CodexAppServerClient.mockClear();
    mocks.settingsStore.get.mockReset();
    mocks.settingsStore.get.mockReturnValue(null);
    mocks.resolveCodexConfigProfile.mockClear();
  });

  afterEach(() => {
    invalidateCodexInstance();
  });

  it('marks summarizer/handoff app-server children as SDK-origin hooks', async () => {
    await getCodexInstance();

    expect(mocks.CodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          AGENT_DECK_ORIGIN: 'sdk',
        }),
      }),
    );
  });

  it('keeps independent app-server clients for separate native profiles', async () => {
    const first = await getCodexInstance('first');
    const second = await getCodexInstance('second');
    const cachedFirst = await getCodexInstance('first');

    expect(first).not.toBe(second);
    expect(cachedFirst).toBe(first);
    expect(mocks.CodexAppServerClient).toHaveBeenCalledTimes(2);
    expect(mocks.CodexAppServerClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ profile: 'first' }),
    );
    expect(mocks.CodexAppServerClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ profile: 'second' }),
    );
  });
});
