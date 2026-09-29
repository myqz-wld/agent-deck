import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./host-service', () => ({
  createProviderSessionSupervisorHost: () => ({
    start: async () => undefined, stop: async () => undefined,
    whenCloseRequested: () => new Promise(() => undefined),
    whenFailed: () => new Promise(() => undefined),
  }),
  runProviderSessionSupervisorService: async (service: { start(): Promise<void>; stop(): Promise<void> }) => {
    try { await service.start(); return { exitCode: 0 }; } finally { await service.stop(); }
  },
}));
import { runProviderSessionSupervisorEntrypoint } from './host-entrypoint';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ad-host-sync-')));
  roots.push(root);
  const privateRoot = join(root, 'shared');
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { mode: 0o700 });
  const config = join(root, 'host.json');
  const source = join(root, 'auth.json');
  const wrapper = join(root, 'agent-deck-worker');
  writeFileSync(source, '{}', { mode: 0o600 });
  writeFileSync(wrapper, '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\n', { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  const socket = join(privateRoot, 'supervisor/s.sock');
  writeFileSync(config, JSON.stringify({
    schemaVersion: 1, instanceId: 'fixture', workspaceRoot, privateRoot,
    brokerRoot: join(privateRoot, 'broker'), stateRoot: join(privateRoot, 'state'),
    transportRuntimeDirectory: join(privateRoot, 'supervisor'), transportSocketPath: socket,
    engine: 'docker-desktop', executable: '/usr/bin/false', desktopVm: 'colima',
    desktopSocketPath: join(root, 'docker.sock'), maxActive: 1,
    rootlessHome: null, rootlessRuntimeDirectory: null,
    images: { 'claude-code-v1': null, 'codex-cli-v1': null, 'grok-build-v1': `sha256:${'a'.repeat(64)}` },
  }), { mode: 0o600 });
  const worker = `worker-${'c'.repeat(24)}`;
  return { wrapper, source, worker,
    args: ['serve', '--instance', 'fixture', '--config', config, '--socket', socket] };
}

describe('supervisor credential synchronization opt-in', () => {
  it('binds the host source to the exact Worker before accepting service readiness', async () => {
    const f = fixture();
    await expect(runProviderSessionSupervisorEntrypoint([
      ...f.args, '--credential-source', f.source, '--worker-wrapper', f.wrapper,
      '--worker-config', f.worker,
    ])).resolves.toBe(0);
    expect(readFileSync(f.wrapper + '.args', 'utf8').trim().split('\n')).toEqual([
      'install-provider-credential', '--credential', f.source, '--worker', f.worker,
    ]);
  });

  it('leaves an unmanaged service credential lifecycle unchanged', async () => {
    const f = fixture();
    await expect(runProviderSessionSupervisorEntrypoint(f.args)).resolves.toBe(0);
    expect(existsSync(f.wrapper + '.args')).toBe(false);
  });

  it('rejects partial synchronization authority before calling a helper', async () => {
    const f = fixture();
    await expect(runProviderSessionSupervisorEntrypoint([
      ...f.args, '--credential-source', f.source,
    ])).rejects.toThrow();
    expect(existsSync(f.wrapper + '.args')).toBe(false);
  });
});
