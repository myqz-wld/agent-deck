import { describe, expect, it, vi } from 'vitest';

vi.mock('../run-context', () => ({ getProcessRunId: () => 'run-secret' }));

import { runScopedCorrelationId } from '../runtime-correlation';

describe('runScopedCorrelationId', () => {
  it('is stable within one run without exposing the correlated value', () => {
    const raw = 'session /Users/private token=secret';
    const first = runScopedCorrelationId('checkpoint', raw);
    const second = runScopedCorrelationId('checkpoint', raw);

    expect(first).toBe(second);
    expect(first).toMatch(/^checkpoint-[a-f0-9]{12}$/);
    expect(first).not.toContain('session');
    expect(first).not.toContain('private');
    expect(first).not.toContain('secret');
  });
});
