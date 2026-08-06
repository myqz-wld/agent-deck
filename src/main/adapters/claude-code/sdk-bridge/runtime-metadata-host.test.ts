import { describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const setModel = vi.hoisted(() => vi.fn());
const setThinking = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('@main/event-bus', () => ({ eventBus: { emit } }));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get, setModel, setThinking },
}));
vi.mock('@main/utils/logger', () => ({ default: { scope: () => ({ warn }) } }));

describe('desktop Claude runtime metadata host', () => {
  it('owns persistence, updated-row publication, and diagnostics', async () => {
    const record = { id: 'session', model: 'claude-opus-4-8', thinking: 'xhigh' };
    get.mockReturnValue(record);
    const { desktopClaudeRuntimeMetadataHost: host } = await import('./runtime-metadata-host');
    expect(host.read('session')).toBe(record);
    host.setModel('session', 'claude-opus-4-8');
    host.setEffort('session', 'xhigh');
    host.emitUpdated('session');
    host.warnFailure('model', 'session', new Error('failure'));

    expect(setModel).toHaveBeenCalledWith('session', 'claude-opus-4-8');
    expect(setThinking).toHaveBeenCalledWith('session', 'xhigh');
    expect(emit).toHaveBeenCalledWith('session-upserted', record);
    expect(warn).toHaveBeenCalledWith(
      '[claude-bridge] runtime model sync failed for session',
      expect.any(Error),
    );
  });
});
