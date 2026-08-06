import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  get: vi.fn(),
  off: vi.fn(),
  on: vi.fn(),
  setPermissionMode: vi.fn(),
  setSandbox: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@main/event-bus', () => ({
  eventBus: { emit: mocks.emit, off: mocks.off, on: mocks.on },
}));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: mocks.get,
    setClaudeCodeSandbox: mocks.setSandbox,
    setPermissionMode: mocks.setPermissionMode,
  },
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: mocks.warn }) },
}));

describe('desktop Claude restart session host', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps persistence and renderer publication in one host operation', async () => {
    const record = { id: 'session-a' };
    mocks.get.mockReturnValue(record);
    const { desktopClaudeRestartSessionHost: host } = await import('./restart-session-host');

    expect(host.readSession('session-a')).toBe(record);
    host.setPermissionModeAndPublish('session-a', 'plan');
    host.setSandboxAndPublish('session-a', 'strict');
    const error = new Error('capture failed');
    host.warn('restart warning', error);

    expect(mocks.setPermissionMode).toHaveBeenCalledWith('session-a', 'plan');
    expect(mocks.setSandbox).toHaveBeenCalledWith('session-a', 'strict');
    expect(mocks.emit).toHaveBeenNthCalledWith(1, 'session-upserted', record);
    expect(mocks.emit).toHaveBeenNthCalledWith(2, 'session-upserted', record);
    expect(mocks.warn).toHaveBeenCalledWith('restart warning', error);
  });

  it('returns an exact rename unsubscriber', async () => {
    const { desktopClaudeRestartSessionHost: host } = await import('./restart-session-host');
    const listener = vi.fn();

    const unsubscribe = host.subscribeRenames(listener);
    expect(mocks.on).toHaveBeenCalledWith('session-renamed', listener);

    unsubscribe();
    expect(mocks.off).toHaveBeenCalledWith('session-renamed', listener);
  });
});
