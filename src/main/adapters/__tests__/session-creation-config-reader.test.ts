import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_CONFIG_MAX_BYTES,
  DEFAULT_SESSION_CONFIG_READ_TIMEOUT_MS,
  readBoundedConfigText,
} from '../session-creation-config-reader';

describe('readBoundedConfigText', () => {
  it('returns a bounded timeout when the async read never settles', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const diagnostics: unknown[] = [];
    const resultPromise = readBoundedConfigText('/private/config.json', {
      resolutionSource: 'claude-settings',
      readFile: (_path, signal) => {
        observedSignal = signal;
        return new Promise<string>(() => undefined);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_CONFIG_READ_TIMEOUT_MS);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      failureCategory: 'timeout',
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(diagnostics).toEqual([{
      resolutionSource: 'claude-settings',
      failureCategory: 'timeout',
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain('/private/config.json');
    vi.useRealTimers();
  });

  it.each([
    {
      label: 'slow',
      readFile: (_path: string, signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve('{"model":"too-late"}'), 60_000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        }),
      expected: 'timeout',
    },
    {
      label: 'unreadable',
      readFile: async () => {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
      expected: 'unreadable',
    },
    {
      label: 'oversize',
      readFile: async () => 'x'.repeat(DEFAULT_SESSION_CONFIG_MAX_BYTES + 1),
      expected: 'oversize',
    },
  ])('classifies $label reads without exposing content', async ({ readFile, expected }) => {
    vi.useFakeTimers();
    const diagnostics: unknown[] = [];
    const resultPromise = readBoundedConfigText('/secret/config.toml', {
      resolutionSource: 'grok-config',
      readFile,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_CONFIG_READ_TIMEOUT_MS);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      failureCategory: expected,
    });
    expect(diagnostics).toEqual([{
      resolutionSource: 'grok-config',
      failureCategory: expected,
    }]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('/secret/config.toml');
    expect(serialized).not.toContain('too-late');
    vi.useRealTimers();
  });
});
