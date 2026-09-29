import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLocalWorkerGrokCredential } from '@hosts/local-worker/provider-credential';
import { ProviderCredentialSync, withProviderCredentialSync } from './credential-sync';

const roots: string[] = [];
const running: ProviderCredentialSync[] = [];
const native = (key: string, expires_at = '2999-01-01T00:00:00.000Z') => ({
  'https://auth.x.ai::fixture-account': {
    auth_mode: 'oidc', key, expires_at, refresh_token: 'host-only-refresh-token',
    profile: { email: 'operator@example.test' },
  },
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ad-credential-sync-')));
  roots.push(root);
  const options = {
    credentialFile: join(root, 'auth.json'), workerWrapper: join(root, 'agent-deck-worker'),
    workerConfigId: `worker-${'a'.repeat(24)}`, workspaceRoot: join(root, 'workspace'),
    sharedRuntimeRoot: join(root, 'shared'),
  };
  const targetRoot = join(root, 'worker');
  mkdirSync(targetRoot, { mode: 0o700 });
  writeFileSync(options.workerWrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(options.workerWrapper, 0o755);
  const rotate = (value: unknown) => {
    const stage = join(root, 'next-auth.json');
    writeFileSync(stage, JSON.stringify(value), { mode: 0o600 });
    chmodSync(stage, 0o600);
    renameSync(stage, options.credentialFile);
  };
  rotate(native('first-token'));
  const target = join(targetRoot, 'provider-inference', 'grok-auth.json');
  const run = vi.fn(async (_executable: string, _args: readonly string[], _signal: AbortSignal) => {
    await installLocalWorkerGrokCredential(targetRoot, options.credentialFile);
  });
  const warn = vi.fn();
  return { options, rotate, target, targetRoot, run, warn };
}

async function tick() {
  await vi.advanceTimersByTimeAsync(30_000);
  // Let real filesystem promises used by the existing atomic installer settle.
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
}

afterEach(async () => {
  for (const sync of running.splice(0)) await sync.stop();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('host-owned Provider credential synchronization', () => {
  it('projects on startup and after atomic native-login rotation without leaking host metadata', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const sync = new ProviderCredentialSync(f.options, f);
    running.push(sync);
    await sync.start();
    expect(f.run).toHaveBeenCalledWith(f.options.workerWrapper, [
      'install-provider-credential', '--credential', f.options.credentialFile,
      '--worker', f.options.workerConfigId,
    ], expect.any(AbortSignal));
    expect(readFileSync(f.target, 'utf8')).toContain('first-token');
    await tick();
    expect(f.run).toHaveBeenCalledTimes(1);

    f.rotate(native('second-token'));
    await tick();
    const projected = readFileSync(f.target, 'utf8');
    expect(projected).toContain('second-token');
    expect(projected).not.toMatch(/refresh_token|host-only|profile|operator@example/);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('preserves the good projection during invalid source updates and retries without raw diagnostics', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const sync = new ProviderCredentialSync(f.options, f);
    running.push(sync);
    await sync.start();
    const good = readFileSync(f.target, 'utf8');
    f.rotate(native('expired-token', '2000-01-01T00:00:00.000Z'));
    await tick();
    await tick();
    expect(readFileSync(f.target, 'utf8')).toBe(good);
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn.mock.calls).toEqual([[]]);
    f.rotate(native('recovered-token'));
    await tick();
    expect(readFileSync(f.target, 'utf8')).toContain('recovered-token');
  });

  it('does not run a helper against a public or symlinked source', async () => {
    vi.useFakeTimers();
    const f = fixture();
    chmodSync(f.options.credentialFile, 0o644);
    const sync = new ProviderCredentialSync(f.options, f);
    running.push(sync);
    await sync.start();
    expect(f.run).not.toHaveBeenCalled();
    const source = f.options.credentialFile + '.original';
    renameSync(f.options.credentialFile, source);
    symlinkSync(source, f.options.credentialFile);
    await tick();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('serializes slow projections and cancels its own helper before shutdown completes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let signal: AbortSignal | undefined;
    const run = vi.fn(async (_command: string, _args: readonly string[], active: AbortSignal) => {
      signal = active;
      await new Promise<void>((resolve) => active.addEventListener('abort', () => resolve(), { once: true }));
    });
    const sync = new ProviderCredentialSync(f.options, { run, warn: f.warn });
    running.push(sync);
    const starting = sync.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledTimes(1);
    const stopping = sync.stop();
    await Promise.all([starting, stopping]);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it('rejects source authority inside the Workspace or shared Provider runtime', () => {
    const f = fixture();
    for (const root of [f.options.workspaceRoot, f.options.sharedRuntimeRoot]) {
      expect(() => new ProviderCredentialSync({ ...f.options, credentialFile: join(root, 'auth.json') }))
        .toThrow(/Worker-visible/);
    }
  });

  it('ties synchronization lifetime to the supervisor including failed startup cleanup', async () => {
    const calls: string[] = [];
    const service = withProviderCredentialSync({
      start: async () => { calls.push('listen'); throw new Error('fixture bind failed'); },
      stop: async () => { calls.push('stop-listener'); },
      whenCloseRequested: () => new Promise(() => undefined),
      whenFailed: () => new Promise(() => undefined),
    }, {
      start: async () => { calls.push('sync'); },
      stop: async () => { calls.push('stop-sync'); },
    });
    await expect(service.start()).rejects.toThrow('fixture bind failed');
    await service.stop();
    expect(calls).toEqual(['sync', 'listen', 'stop-sync', 'stop-listener']);
  });
});
