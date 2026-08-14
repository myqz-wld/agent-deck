import { describe, expect, it, vi } from 'vitest';

import type { ElectronHostState } from '@hosts/electron';
import {
  REMOTE_TRANSPORT_SUMMARY_INTERVAL_MS,
  RemoteHostTransportDiagnostics,
} from './transport-diagnostics';

function state(
  status: ElectronHostState['status'],
  error: ElectronHostState['error'],
): ElectronHostState {
  return {
    profileId: 'remote-a',
    clientId: 'client-a',
    topology: 'relay',
    status,
    instanceId: 'relay-a',
    authoritativeCoreId: 'worker-a',
    workerGeneration: 1,
    capabilities: [],
    eventRevision: 0,
    error,
  };
}

describe('remote host transport diagnostics', () => {
  it('summarizes duplicate failures and reports one recovery', () => {
    let now = 100;
    const logger = { warn: vi.fn(), info: vi.fn() };
    const diagnostics = new RemoteHostTransportDiagnostics(logger, () => now);
    const failed = state('reconnecting', {
      code: 'connection_failed',
      message: 'SSH bridge exited',
    });

    diagnostics.observe(failed);
    diagnostics.observe(failed);
    diagnostics.observe(state('reconnecting', null));
    diagnostics.observe(failed);
    expect(logger.warn).toHaveBeenCalledOnce();

    now += REMOTE_TRANSPORT_SUMMARY_INTERVAL_MS;
    diagnostics.observe(failed);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(
      'Remote transport state remains degraded',
      expect.objectContaining({ suppressedRepeats: 3, transition: 'periodic-summary' }),
    );

    now += 25;
    diagnostics.observe(state('connected', null));
    diagnostics.observe(state('connected', null));
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      'Remote transport state recovered',
      expect.objectContaining({
        previousCode: 'connection_failed',
        degradedDurationMs: REMOTE_TRANSPORT_SUMMARY_INTERVAL_MS + 25,
      }),
    );

    diagnostics.observe(failed);
    expect(logger.warn).toHaveBeenCalledTimes(3);

    diagnostics.observe(state('offline', {
      code: 'app-shutdown',
      message: 'Desktop transport is stopped',
    }));
    expect(logger.warn).toHaveBeenCalledTimes(3);
    diagnostics.observe(failed);
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });

  it('logs a changed failure while carrying the episode summary forward', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const diagnostics = new RemoteHostTransportDiagnostics(logger, () => 50);
    diagnostics.observe(state('reconnecting', {
      code: 'connection_failed',
      message: 'SSH protocol pong timed out',
    }));
    diagnostics.observe(state('reconnecting', {
      code: 'connection_failed',
      message: 'SSH protocol pong timed out',
    }));
    diagnostics.observe(state('reconnecting', {
      code: 'connection_failed',
      message: 'SSH bridge exited',
    }));

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(
      'Remote transport state degraded',
      expect.objectContaining({
        transition: 'failure-changed',
        previousCode: 'connection_failed',
        suppressedPreviousRepeats: 1,
      }),
    );
  });
});
