import { beforeEach, describe, expect, it, vi } from 'vitest';

const setPermissionMode = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn(() => ({ id: 'session-host' })));
const emit = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
const error = vi.hoisted(() => vi.fn());

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { setPermissionMode, get },
}));
vi.mock('@main/event-bus', () => ({ eventBus: { emit } }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn, error }) },
}));

describe('desktop Claude permission responder host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('owns persistence, upsert publication, diagnostics, and time', async () => {
    const { desktopClaudePermissionResponderHost: host } = await import(
      './permission-responder-host'
    );
    const failure = new Error('failed');

    host.persistPermissionMode('session-host', 'acceptEdits');
    host.observeHotSwitchFailure('session-host', failure);
    host.observeColdSwitchFailure('session-host', failure);

    expect(setPermissionMode).toHaveBeenCalledWith('session-host', 'acceptEdits');
    expect(get).toHaveBeenCalledWith('session-host');
    expect(emit).toHaveBeenCalledWith('session-upserted', { id: 'session-host' });
    expect(warn).toHaveBeenCalledWith(
      '[sdk-bridge] hot-switch permission mode after approve failed: session-host',
      failure,
    );
    expect(error).toHaveBeenCalledWith(
      '[sdk-bridge] cold-switch to bypass after approve failed: session-host',
      failure,
    );
    expect(host.now()).toEqual(expect.any(Number));
  });
});
