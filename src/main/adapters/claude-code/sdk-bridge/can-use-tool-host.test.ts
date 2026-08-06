import { beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.hoisted(() => vi.fn());

vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ info }) },
}));

describe('desktop Claude can-use-tool host', () => {
  beforeEach(() => {
    info.mockReset();
  });

  it('owns request IDs, the wall clock, and sandbox diagnostics', async () => {
    const { desktopClaudeCanUseToolHost: host } = await import('./can-use-tool-host');

    expect(host.createRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(host.now()).toEqual(expect.any(Number));

    host.observeSandboxIntercept('example.test');

    expect(info).toHaveBeenCalledWith(
      '[sandbox-canusetool] SandboxNetworkAccess intercept host=example.test → auto-deny + fallback hint',
    );
  });
});
