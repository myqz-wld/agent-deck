import { describe, expect, it, vi } from 'vitest';

const cleanupSession = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock('./pending-cancellation', () => ({ runCloseSessionCleanup: cleanupSession }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: { get } }));
vi.mock('@main/utils/logger', () => ({ default: { scope: () => ({ warn, info }) } }));

describe('desktop Claude session lifecycle host', () => {
  it('owns cleanup, persisted lookup, and lifecycle diagnostics', async () => {
    get.mockReturnValue({ id: 'session' });
    const { createDesktopClaudeSessionLifecycleHost } = await import('./session-lifecycle-host');
    const sessionManager = {
      releaseSdkClaim: vi.fn(),
      markRecentlyDeleted: vi.fn(),
    };
    const host = createDesktopClaudeSessionLifecycleHost(sessionManager);
    const input = { sessions: new Map(), internal: {} as never, key: 'key', sessionId: 'session', emit: vi.fn() };
    host.cleanupSession(input);
    expect(cleanupSession).toHaveBeenCalledWith(input, sessionManager);
    expect(host.hasPersistedSession('session')).toBe(true);
    host.warn('warning', new Error('failure'));
    host.info('information');
    expect(warn).toHaveBeenCalledWith('warning', expect.any(Error));
    expect(info).toHaveBeenCalledWith('information');
  });
});
