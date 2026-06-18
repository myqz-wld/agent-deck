import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const client = { dispose: vi.fn() };
  return {
    client,
    CodexAppServerClient: vi.fn(() => client),
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
    mocks.client.dispose.mockClear();
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
});
