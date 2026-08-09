import { describe, expect, it, vi } from 'vitest';

import { clearDetailForSourceView } from './source-navigation';

describe('source navigation detail ownership', () => {
  it.each(['pending', 'history'] as const)(
    'clears the Remote detail before opening %s',
    (view) => {
      const clearLocal = vi.fn();
      const clearRemote = vi.fn();
      clearDetailForSourceView(true, view, clearLocal, clearRemote);
      expect(clearRemote).toHaveBeenCalledOnce();
      expect(clearLocal).not.toHaveBeenCalled();
    },
  );

  it('does not clear Remote detail for the live workspace', () => {
    const clearRemote = vi.fn();
    clearDetailForSourceView(true, 'live', vi.fn(), clearRemote);
    expect(clearRemote).not.toHaveBeenCalled();
  });

  it.each(['pending', 'teams', 'issues', 'data'] as const)(
    'preserves the Local detail-priority rule for %s',
    (view) => {
      const clearLocal = vi.fn();
      clearDetailForSourceView(false, view, clearLocal, vi.fn());
      expect(clearLocal).toHaveBeenCalledOnce();
    },
  );
});
