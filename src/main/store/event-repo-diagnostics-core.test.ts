import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  reportEventRepositoryWarning,
  setEventRepositoryDiagnostics,
} from './event-repo-diagnostics-core';

afterEach(() => {
  setEventRepositoryDiagnostics(null);
});

describe('event repository diagnostics', () => {
  it('forwards the exact warning shape to the installed host', () => {
    const warn = vi.fn();
    const error = new Error('raw');
    setEventRepositoryDiagnostics({ warn });

    reportEventRepositoryWarning('message', { operation: 'parse' }, error);

    expect(warn).toHaveBeenCalledWith(
      'message',
      { operation: 'parse' },
      error,
    );
  });

  it('contains observer failures', () => {
    setEventRepositoryDiagnostics({
      warn: () => {
        throw new Error('observer failed');
      },
    });

    expect(() => reportEventRepositoryWarning('message')).not.toThrow();
  });
});
