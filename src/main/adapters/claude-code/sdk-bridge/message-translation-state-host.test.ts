import { describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const setPermissionMode = vi.hoisted(() => vi.fn());
vi.mock('@main/event-bus', () => ({ eventBus: { emit } }));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get, setPermissionMode },
}));

describe('desktop Claude message translation state host', () => {
  it('owns record reads, permission persistence, and updated-row publication', async () => {
    const record = {
      id: 'session-a',
      model: 'claude-opus-4-8',
      permissionMode: 'auto',
    };
    get.mockReturnValue(record);
    const { desktopClaudeMessageTranslationStateHost: host } = await import(
      './message-translation-state-host'
    );

    expect(host.read('session-a')).toBe(record);
    host.setPermissionMode('session-a', 'auto');
    host.publishUpdated('session-a');

    expect(setPermissionMode).toHaveBeenCalledWith('session-a', 'auto');
    expect(emit).toHaveBeenCalledWith('session-upserted', record);
  });
});
