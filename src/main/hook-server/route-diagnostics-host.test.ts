import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
  runId: vi.fn(() => 'desktop-run'),
}));

vi.mock('@main/utils/logger', () => ({
  default: { scope: () => mocks.logger },
}));
vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: mocks.runId,
}));

describe('desktop hook route diagnostics host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adapts the desktop logger and run correlation into the Core', async () => {
    const { hookRouteDiagnostics } = await import('./route-diagnostics-host');

    hookRouteDiagnostics.reportFailure({
      adapter: 'grok-build',
      route: '/hook/grok/stop',
      event: 'Stop',
      origin: 'cli',
      sessionId: 'grok-session-host-test',
      phase: 'emit',
      error: new Error('private detail'),
    });

    expect(mocks.logger.error).toHaveBeenCalledWith(
      '[hook-route] processing failed',
      expect.objectContaining({
        adapter: 'grok-build',
        event: 'Stop',
        runId: 'desktop-run',
      }),
    );
  });
});
