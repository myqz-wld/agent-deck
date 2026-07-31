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
  };
});

vi.mock('@main/adapters/codex-cli/app-server/client', () => ({
  CodexAppServerClient: mocks.CodexAppServerClient,
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: mocks.settingsStore,
}));

import { getCodexInstance, invalidateCodexInstance } from '../codex-instance-pool';

describe('codex oneshot instance pool', () => {
  beforeEach(() => {
    invalidateCodexInstance();
    mocks.clients.length = 0;
    mocks.CodexAppServerClient.mockClear();
    mocks.settingsStore.get.mockReset();
    mocks.settingsStore.get.mockReturnValue(null);
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

  it('shares one base app-server process across thread model providers', async () => {
    const first = await getCodexInstance();
    const second = await getCodexInstance();

    expect(second).toBe(first);
    expect(mocks.CodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(mocks.CodexAppServerClient).toHaveBeenCalledWith(
      expect.not.objectContaining({ profile: expect.anything() }),
    );
  });
});
