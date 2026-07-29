import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readGrokCachedAccessToken,
  readGrokUsageSnapshotInBackground,
} from '../usage-snapshot';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    ...mocks.logger,
    scope: () => mocks.logger,
  },
}));

describe('Grok usage snapshot', () => {
  beforeEach(() => {
    for (const method of Object.values(mocks.logger)) method.mockReset();
  });

  it('reads billing usage with the cached token without exposing it in the result', async () => {
    const fetchFn = vi.fn(async (_input, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer secret-token',
      });
      return new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 25,
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              end: '2026-07-29T00:00:00Z',
            },
          },
        }),
        { status: 200 },
      );
    });

    const snapshot = await readGrokUsageSnapshotInBackground({
      readAccessTokenFn: async () => 'secret-token',
      refreshAuthFn: vi.fn(async () => undefined),
      fetchFn,
      endpoint: 'https://example.test/v1/billing?format=credits',
    });

    expect(snapshot).toMatchObject({
      provider: 'grok-build',
      label: 'Grok Build',
      status: 'ok',
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-token');
  });

  it('refreshes Grok authentication once after an unauthorized response', async () => {
    const tokens = ['expired-token', 'fresh-token'];
    const refreshAuthFn = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 5,
              billingPeriodEnd: '2026-08-01T00:00:00Z',
            },
          }),
          { status: 200 },
        ),
      );

    const snapshot = await readGrokUsageSnapshotInBackground({
      readAccessTokenFn: async () => tokens.shift() ?? null,
      refreshAuthFn,
      fetchFn,
      endpoint: 'https://example.test/v1/billing?format=credits',
    });

    expect(snapshot.status).toBe('ok');
    expect(refreshAuthFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns a non-sensitive unavailable snapshot when Grok is not logged in', async () => {
    const snapshot = await readGrokUsageSnapshotInBackground({
      readAccessTokenFn: async () => null,
      refreshAuthFn: vi.fn(async () => undefined),
      fetchFn: vi.fn(),
    });

    expect(snapshot).toMatchObject({
      provider: 'grok-build',
      label: 'Grok Build',
      status: 'unavailable',
      message: expect.stringContaining('Grok Build 已登录'),
    });
    expect(mocks.logger.debug).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('returns a generic error snapshot without adapter-local raw logging', async () => {
    const snapshot = await readGrokUsageSnapshotInBackground({
      readAccessTokenFn: async () => 'private-token',
      refreshAuthFn: vi.fn(async () => undefined),
      fetchFn: vi.fn(async () => {
        throw new Error(
          'Bearer private-token /Users/private/repo https://example.test/?token=private',
        );
      }),
      endpoint: 'https://example.test/v1/billing?format=credits',
    });

    expect(snapshot).toMatchObject({
      provider: 'grok-build',
      label: 'Grok Build',
      status: 'error',
      message: '额度信息读取失败，请稍后重试',
    });
    expect(mocks.logger.debug).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain('private-token');
    expect(JSON.stringify(snapshot)).not.toContain('/Users/private/repo');
  });

  it('selects the latest cached Grok token from auth.json', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-grok-auth-'));
    const authPath = path.join(root, 'auth.json');
    try {
      await fs.writeFile(
        authPath,
        JSON.stringify({
          old: { key: 'old-token', expires_at: '2026-07-01T00:00:00Z' },
          current: { key: 'current-token', expires_at: '2026-08-01T00:00:00Z' },
        }),
      );
      await expect(readGrokCachedAccessToken(authPath)).resolves.toBe(
        'current-token',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
