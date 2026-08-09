import { describe, expect, it, vi } from 'vitest';

import { cleanupFailedGrokStartupRegistration } from './startup-registration-cleanup';

describe('cleanupFailedGrokStartupRegistration', () => {
  it('deletes a failed strict-startup registration without closing it twice', async () => {
    const sessions = {
      delete: vi.fn(async () => undefined),
      markClosed: vi.fn(),
    };
    const reportFailure = vi.fn();

    await cleanupFailedGrokStartupRegistration(sessions, reportFailure, 'session-a');

    expect(sessions.delete).toHaveBeenCalledWith('session-a');
    expect(sessions.markClosed).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('reports a guarded delete and conservatively marks the row closed', async () => {
    const failure = new Error('delete guarded');
    const sessions = {
      delete: vi.fn(async () => Promise.reject(failure)),
      markClosed: vi.fn(),
    };
    const reportFailure = vi.fn();

    await cleanupFailedGrokStartupRegistration(sessions, reportFailure, 'session-a');

    expect(reportFailure).toHaveBeenCalledWith('session-a', failure);
    expect(sessions.markClosed).toHaveBeenCalledWith('session-a');
  });
});
