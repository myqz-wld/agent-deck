import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  reportFileChangeReadWarning,
  setFileChangeReadDiagnostics,
} from './file-change-read-diagnostics-core';

afterEach(() => {
  setFileChangeReadDiagnostics(null);
});

describe('file-change read diagnostics', () => {
  it('forwards the exact warning shape to the installed host', () => {
    const warn = vi.fn();
    setFileChangeReadDiagnostics({ warn });

    reportFileChangeReadWarning('message', { operation: 'decode' });

    expect(warn).toHaveBeenCalledWith('message', { operation: 'decode' });
  });

  it('contains observer failures and supports the headless no-op host', () => {
    setFileChangeReadDiagnostics({
      warn: () => {
        throw new Error('observer failed');
      },
    });

    expect(() => reportFileChangeReadWarning('message')).not.toThrow();

    setFileChangeReadDiagnostics(null);
    expect(() => reportFileChangeReadWarning('headless')).not.toThrow();
  });
});
