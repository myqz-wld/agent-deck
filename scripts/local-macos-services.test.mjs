import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAppLaunchAgents, pauseAppLaunchAgents } from './local-macos-services.mjs';

const app = '/Applications/Agent Deck.app';
const root = '/fixture/LaunchAgents';
const worker = 'com.agentdeck.worker.fixture';
const provider = 'com.agentdeck.provider-supervisor.fixture';

function harness() {
  const definitions = new Map([
    [worker, { Label: worker, ProgramArguments: [
      `${app}/Contents/MacOS/agent-deck-worker-sandbox`, '--',
      `${app}/Contents/Resources/bin/agent-deck-worker`, 'serve', '--config', '/fixture/worker.json',
    ], KeepAlive: true }],
    [provider, { Label: provider, ProgramArguments: [
      `${app}/Contents/Resources/bin/agent-deck-provider-supervisor`,
      'serve', '--instance', 'fixture', '--config', '/fixture/provider.json',
    ], KeepAlive: true }],
  ]);
  const loaded = new Map([...definitions].map(([label, definition], index) => [label, {
    definition: structuredClone(definition), pid: 101 + index, state: 'running',
  }]));
  const fingerprints = new Map([...definitions.keys()].map((label) => [label, 'unchanged']));
  const host = {
    uid: 501, root,
    files: () => [...definitions.keys()].map((label) => `${label}.plist`),
    read: vi.fn((path) => {
      const label = path.slice(root.length + 1, -6);
      return { definition: definitions.get(label), fingerprint: fingerprints.get(label) };
    }),
    wait: vi.fn(async () => {}),
    waitForExit: vi.fn(async () => {}),
  };
  const execute = (args) => {
    const label = args[0] === 'bootstrap'
      ? args[2].slice(root.length + 1, -6) : args[1].split('/').at(-1);
    if (args[0] === 'print') {
      const job = loaded.get(label);
      return job ? { code: 0, stderr: '', stdout: [
        `path = ${root}/${label}.plist`,
        `program = ${job.definition.ProgramArguments[0]}`,
        `state = ${job.state}`, `pid = ${job.pid}`, 'arguments = {',
        ...job.definition.ProgramArguments, '}', '',
      ].join('\n') } : { code: 113, stdout: '', stderr: `Could not find service "${label}"` };
    }
    if (args[0] === 'bootout') loaded.delete(label);
    else if (args[0] === 'bootstrap') loaded.set(label, {
      definition: structuredClone(definitions.get(label)), pid: 201, state: 'running',
    });
    else throw new Error('Unexpected launchctl command');
    return { code: 0, stdout: '', stderr: '' };
  };
  host.launchctl = vi.fn(execute);
  return { host, definitions, loaded, fingerprints, execute,
    mutations: () => host.launchctl.mock.calls.map(([args]) => args)
      .filter((args) => args[0] !== 'print') };
}

describe.skipIf(process.platform !== 'darwin')('macOS installer managed service lifecycle', () => {
  it('rejects shared-writable, wrong-owner, and symlinked definitions before inspecting live jobs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-deck-install-services-'));
    const path = join(directory, `${worker}.plist`);
    const launchctl = vi.fn();
    try {
      writeFileSync(path, '{}', { mode: 0o600 });
      chmodSync(path, 0o666);
      const options = { root: directory, uid: process.getuid(), launchctl };
      expect(() => discoverAppLaunchAgents(app, options)).toThrow('不可信');
      chmodSync(path, 0o600);
      expect(() => discoverAppLaunchAgents(app, { ...options, uid: process.getuid() + 1 })).toThrow('不可信');
      unlinkSync(path);
      const target = join(directory, 'fixture.json');
      writeFileSync(target, '{}');
      symlinkSync(target, path);
      expect(() => discoverAppLaunchAgents(app, options)).toThrow('不可信');
      expect(launchctl).not.toHaveBeenCalled();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('discovers only loaded jobs whose definitions and live commands match the exact bundle', () => {
    const h = harness();
    const other = 'com.agentdeck.worker.other';
    h.definitions.set(other, { Label: other,
      ProgramArguments: ['/Applications/Other.app/Contents/MacOS/agent-deck-worker-sandbox'] });
    h.loaded.delete(provider);
    expect(discoverAppLaunchAgents(app, h.host).map((job) => job.label)).toEqual([worker]);
    expect(h.mutations()).toEqual([]);
  });

  it('unloads KeepAlive consumers before providers and restores them in dependency order', async () => {
    const h = harness();
    const restore = await pauseAppLaunchAgents(app, h.host);
    expect(h.loaded.size).toBe(0);
    expect(h.mutations()).toEqual([
      ['bootout', `gui/501/${worker}`], ['bootout', `gui/501/${provider}`],
    ]);
    await restore();
    expect(h.mutations().slice(2)).toEqual([
      ['bootstrap', 'gui/501', `${root}/${provider}.plist`],
      ['bootstrap', 'gui/501', `${root}/${worker}.plist`],
    ]);
    expect(h.loaded.size).toBe(2);
    await restore();
    expect(h.mutations()).toHaveLength(4);
  });

  it('never starts a service that was unloaded before installation', async () => {
    const h = harness(); h.loaded.delete(provider);
    const restore = await pauseAppLaunchAgents(app, h.host);
    await restore();
    expect(h.loaded.has(provider)).toBe(false);
    expect(h.mutations()).toHaveLength(2);
  });

  it('rejects live command and definition label mismatches before stopping anything', async () => {
    for (const replacement of [
      ['/Applications/Other.app/service'],
      [...harness().definitions.get(worker).ProgramArguments, '--different-config'],
    ]) {
      const h = harness(); h.loaded.get(worker).definition.ProgramArguments = replacement;
      await expect(pauseAppLaunchAgents(app, h.host)).rejects.toThrow('身份');
      expect(h.mutations()).toEqual([]);
    }
    const h = harness(); h.definitions.get(worker).Label = 'unrelated';
    await expect(pauseAppLaunchAgents(app, h.host)).rejects.toThrow('定义');
    expect(h.mutations()).toEqual([]);
  });

  it('does not treat launchctl inspection failures as stopped services', async () => {
    const h = harness(); h.host.launchctl.mockReturnValue({ code: 1, stdout: '', stderr: 'denied' });
    await expect(pauseAppLaunchAgents(app, h.host)).rejects.toThrow('无法核实');
    expect(h.mutations()).toEqual([]);
  });

  it('restores services already paused when a later bootout fails', async () => {
    const h = harness();
    h.host.launchctl.mockImplementation((args) => args[0] === 'bootout' && args[1].endsWith(provider)
      ? { code: 5, stdout: '', stderr: 'failed' } : h.execute(args));
    await expect(pauseAppLaunchAgents(app, h.host)).rejects.toThrow('受控暂停');
    expect([...h.loaded.keys()].sort()).toEqual([provider, worker].sort());
    expect(h.mutations().at(-1)).toEqual(['bootstrap', 'gui/501', `${root}/${worker}.plist`]);
  });

  it('rejects definition changes before unload and before restore', async () => {
    const h = harness();
    let workerReads = 0;
    const read = h.host.read.getMockImplementation();
    h.host.read.mockImplementation((path) => {
      const result = read(path);
      return path.endsWith(`${worker}.plist`) && ++workerReads > 1
        ? { ...result, fingerprint: 'changed' } : result;
    });
    await expect(pauseAppLaunchAgents(app, h.host)).rejects.toThrow('发生变化');
    expect(h.mutations()).toEqual([]);

    const next = harness(); const restore = await pauseAppLaunchAgents(app, next.host);
    next.fingerprints.set(provider, 'changed');
    await expect(restore()).rejects.toThrow('恢复失败');
    expect(next.loaded.has(provider)).toBe(false);
    expect(next.loaded.has(worker)).toBe(true);
  });

  it('does not report a registered but non-running service as restored', async () => {
    const h = harness(); const restore = await pauseAppLaunchAgents(app, h.host);
    h.host.launchctl.mockImplementation((args) => {
      const result = h.execute(args);
      if (args[0] === 'bootstrap') h.loaded.get(args[2].slice(root.length + 1, -6)).state = 'waiting';
      return result;
    });
    await expect(restore()).rejects.toThrow('未在期限内恢复运行');
  });
});
