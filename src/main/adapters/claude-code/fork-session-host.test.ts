import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  getSessionMessages: vi.fn(),
  forkSession: vi.fn(),
  deleteSession: vi.fn(),
}));
const loadSdk = vi.hoisted(() => vi.fn(async () => sdk));
const sessionRepo = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn() }));
const cleanupObserver = vi.hoisted(() => ({ recordIssue: vi.fn() }));

vi.mock('./sdk-loader', () => ({ loadSdk }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo }));
vi.mock('./fork-session-cleanup-host', () => ({
  desktopClaudeForkCleanupObserver: cleanupObserver,
}));

describe('desktop Claude native fork host', () => {
  it('owns SDK loading, config discovery, the child store, and cleanup diagnostics', async () => {
    const { desktopClaudeFamilyForkHost: host } = await import('./fork-session-host');

    await expect(host.loadSdk()).resolves.toBe(sdk);
    expect(loadSdk).toHaveBeenCalledOnce();
    expect(host.readConfigRoot()).toMatch(/\.claude$/);
    expect(host.childSessionStore).toBe(sessionRepo);
    expect(host.cleanupObserver).toBe(cleanupObserver);
  });
});
