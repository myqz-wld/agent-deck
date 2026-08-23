import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const observations: unknown[] = [];
    const resultPromise = readBoundedConfigText('/private/config.json', {
      resolutionSource: 'claude-settings',
      readFile: (_path, signal) => {
        observedSignal = signal;
        return new Promise<string>(() => undefined);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onObservation: (observation) => observations.push(observation),
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_CONFIG_READ_TIMEOUT_MS);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      failureCategory: 'timeout',
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(diagnostics).toEqual([expect.objectContaining({
      resolutionSource: 'claude-settings',
      failureCategory: 'timeout',
      backend: 'custom-reader',
      stage: 'custom-reader',
      bytes: null,
    })]);
    expect(observations).toEqual([expect.objectContaining({
      resolutionSource: 'claude-settings',
      outcome: 'timeout',
      backend: 'custom-reader',
      stage: 'custom-reader',
      bytes: null,
    })]);
    expect(JSON.stringify({ diagnostics, observations }))
      .not.toContain('/private/config.json');
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
    const observations: unknown[] = [];
    const resultPromise = readBoundedConfigText('/secret/config.toml', {
      resolutionSource: 'grok-config',
      readFile,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onObservation: (observation) => observations.push(observation),
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_CONFIG_READ_TIMEOUT_MS);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      failureCategory: expected,
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      resolutionSource: 'grok-config',
      failureCategory: expected,
      backend: 'custom-reader',
      stage: expected === 'oversize' ? 'validating' : 'custom-reader',
    })]);
    expect(observations).toEqual([expect.objectContaining({
      resolutionSource: 'grok-config',
      outcome: expected,
      backend: 'custom-reader',
      stage: expected === 'oversize' ? 'validating' : 'custom-reader',
    })]);
    const serialized = JSON.stringify({ diagnostics, observations });
    expect(serialized).not.toContain('/secret/config.toml');
    expect(serialized).not.toContain('too-late');
    vi.useRealTimers();
  });

  it('reads a real host file through the bounded descriptor path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-config-reader-'));
    const path = join(root, 'config.toml');
    const observations: unknown[] = [];
    writeFileSync(path, 'model = "fast-model"\n', { mode: 0o600 });

    try {
      await expect(readBoundedConfigText(path, {
        resolutionSource: 'codex-config',
        onObservation: (observation) => observations.push(observation),
      })).resolves.toEqual({
        ok: true,
        text: 'model = "fast-model"\n',
      });
      expect(observations).toEqual([expect.objectContaining({
        resolutionSource: 'codex-config',
        outcome: 'success',
        backend: process.versions.electron ? 'electron-original-fs' : 'node-fs',
        stage: 'validating',
        bytes: 21,
      })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops the real descriptor reader at one byte beyond the configured limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-config-reader-'));
    const path = join(root, 'oversize.toml');
    const maxBytes = 32;
    const observations: unknown[] = [];
    writeFileSync(path, Buffer.alloc(maxBytes + 128, 0x78), { mode: 0o600 });

    try {
      await expect(readBoundedConfigText(path, {
        resolutionSource: 'grok-config',
        maxBytes,
        onObservation: (observation) => observations.push(observation),
      })).resolves.toEqual({
        ok: false,
        failureCategory: 'oversize',
      });
      expect(observations).toEqual([expect.objectContaining({
        outcome: 'oversize',
        stage: 'validating',
        bytes: maxBytes + 1,
      })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
