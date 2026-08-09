import { describe, expect, it, vi } from 'vitest';
import { StorageMaintenanceDiagnostics } from './scheduler-diagnostics';

describe('storage maintenance scheduler diagnostics adapter', () => {
  it('preserves semantic lifecycle diagnostics behind the host logger port', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const diagnostics = new StorageMaintenanceDiagnostics(50, () => 1_000, logger);
    const error = new Error('restore failed');

    diagnostics.workerReady();
    diagnostics.ignoredStaleResponse('slice-result', 7);
    diagnostics.ignoredMismatchedResponse('closed', 'checkpoint-result');
    diagnostics.failedToRestoreMainCheckpoint(error);
    diagnostics.workerUnhealthy('bad worker');
    diagnostics.workerStopped('exit 7', false);
    diagnostics.workerStopped('ignored', true);
    diagnostics.workerUnavailable('spawn failed');
    diagnostics.workerTimedOut();

    expect(logger.info).toHaveBeenCalledWith(
      '[storage-maintenance] worker ready; WAL checkpoints isolated from Electron main',
    );
    expect(logger.warn.mock.calls.map(([message]) => message)).toEqual([
      '[storage-maintenance] ignored stale worker response (type=slice-result, requestId=7)',
      '[storage-maintenance] ignored mismatched worker response ' +
        '(expected=closed, actual=checkpoint-result)',
      '[storage-maintenance] failed to restore main WAL autocheckpoint',
      '[storage-maintenance] worker unhealthy; main checkpoint safety restored, ' +
        'waiting for worker close: bad worker',
      '[storage-maintenance] worker stopped after failure: exit 7',
      'terminal-disabled storage maintenance worker stopped during shutdown',
      '[storage-maintenance] worker unavailable; restoring main checkpoint safety: spawn failed',
      'storage maintenance worker timed out; maintenance disabled until restart',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      '[storage-maintenance] failed to restore main WAL autocheckpoint',
      error,
    );
  });
});
