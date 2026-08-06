import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  reportSessionRepositoryWarning,
  setSessionRepositoryDiagnostics,
} from './diagnostics-core';

afterEach(() => setSessionRepositoryDiagnostics(null));

describe('session repository diagnostics', () => {
  it('delegates bounded repository observations to the owning host', () => {
    const warn = vi.fn();
    setSessionRepositoryDiagnostics({ warn });

    reportSessionRepositoryWarning('invalid row', { field: 'model' }, new Error('raw'));

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'invalid row',
      { field: 'model' },
      expect.any(Error),
    );
  });

  it('contains observer failures and supports the headless no-op owner', () => {
    setSessionRepositoryDiagnostics({
      warn: () => {
        throw new Error('observer failed');
      },
    });
    expect(() => reportSessionRepositoryWarning('ignored')).not.toThrow();

    setSessionRepositoryDiagnostics(null);
    expect(() => reportSessionRepositoryWarning('headless')).not.toThrow();
  });
});
