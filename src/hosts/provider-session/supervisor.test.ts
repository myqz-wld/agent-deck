import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

import type { ProviderSessionLaunchSpec } from '@contracts/index';

import { ProviderSessionContainerSupervisor } from './supervisor';
import type {
  ProviderSessionHostMountBinding,
  ProviderSessionHostMountPort,
  ProviderSessionImageCatalog,
  ProviderSessionOciCommand,
  ProviderSessionOciInspection,
  ProviderSessionOciPort,
  ProviderSessionOciReadiness,
} from './types';

const IMAGE = `registry.invalid/agent-deck/provider@sha256:${'b'.repeat(64)}`;
const IMAGES: ProviderSessionImageCatalog = Object.freeze({
  'claude-code-v1': null,
  'codex-cli-v1': null,
  'grok-build-v1': IMAGE,
});

function spec(overrides: Partial<ProviderSessionLaunchSpec> = {}): ProviderSessionLaunchSpec {
  return {
    schemaVersion: 1,
    adapterId: 'grok-build',
    brokerEndpointId: 'broker-a',
    effectiveAccess: 'selected-directory-read-write',
    launchId: 'launch-a',
    processId: 'process-a',
    providerId: 'xai',
    resourceClass: 'interactive-v1',
    runtimeId: 'grok-build-v1',
    sessionId: 'session-a',
    upstreamId: 'grok-chat',
    workingDirectory: 'repo',
    ...overrides,
  };
}

class FakeMounts implements ProviderSessionHostMountPort {
  readonly capture = vi.fn(async (): Promise<ProviderSessionHostMountBinding> => ({
    bindingId: 'binding-a',
    browserBrokerSocketPath: null,
    brokerSocketPath: '/run/provider-broker/broker-a.sock',
    selectedDirectory: '/srv/workspace/repo',
    stateDirectory: '/srv/provider-state/session-a',
    workspaceRoot: '/srv/workspace',
  }));
  readonly revalidate = vi.fn(async () => undefined);
  readonly release = vi.fn(async () => undefined);
}

function argument(command: ProviderSessionOciCommand, flag: string): string {
  const index = command.args.indexOf(flag);
  if (index < 0) throw new Error(`missing ${flag}`);
  return command.args[index + 1]!;
}

class FakeOci implements ProviderSessionOciPort {
  readiness: ProviderSessionOciReadiness = { available: true, boundary: 'rootless-user' };
  private readonly inspections = new Map<string, ProviderSessionOciInspection>();
  readonly actions: string[] = [];
  activeStops = 0;
  createdCount = 0;
  delayedCreateInspections = 0;
  failAfterCreate = false;
  pendingCreatedInspection: ProviderSessionOciInspection | null = null;
  tamperCreatedIdentity = false;
  startGate: Promise<void> | null = null;
  stopGate: Promise<void> | null = null;
  maxConcurrentStops = 0;

  get inspection(): ProviderSessionOciInspection | null {
    return this.inspections.values().next().value ?? null;
  }

  set inspection(value: ProviderSessionOciInspection | null) {
    this.inspections.clear();
    if (value) this.inspections.set(value.name, value);
  }

  async probe(): Promise<ProviderSessionOciReadiness> {
    return this.readiness;
  }

  async run(command: ProviderSessionOciCommand): Promise<void> {
    this.actions.push(command.action);
    if (command.action === 'create') {
      this.createdCount += 1;
      const labels: Record<string, string> = {};
      command.args.forEach((value, index) => {
        if (value !== '--label') return;
        const pair = command.args[index + 1]!;
        const separator = pair.indexOf('=');
        labels[pair.slice(0, separator)] = pair.slice(separator + 1);
      });
      const marker = command.args.lastIndexOf('--');
      const created = {
        image: command.args[marker + 1]!,
        labels: this.tamperCreatedIdentity ? { ...labels, 'io.agent-deck.identity': 'replaced' } : labels,
        name: argument(command, '--name'),
        running: false,
        runtimeHandle: String.fromCharCode(96 + this.createdCount).repeat(64),
      };
      if (this.delayedCreateInspections > 0) this.pendingCreatedInspection = created;
      else this.inspections.set(created.name, created);
      if (this.failAfterCreate) throw new Error('ambiguous create result');
      return;
    }
    const name = command.args.at(-1)!;
    const inspection = this.inspections.get(name);
    if (!inspection) throw new Error('container missing');
    if (command.action === 'start') {
      await this.startGate;
      this.inspections.set(name, { ...inspection, running: true });
    }
    if (command.action === 'stop') {
      this.activeStops += 1;
      this.maxConcurrentStops = Math.max(this.maxConcurrentStops, this.activeStops);
      await this.stopGate;
      this.inspections.set(name, { ...inspection, running: false });
      this.activeStops -= 1;
    }
    if (command.action === 'remove') this.inspections.delete(name);
  }

  async inspect(command: ProviderSessionOciCommand): Promise<ProviderSessionOciInspection | null> {
    expect(command.action).toBe('inspect');
    const name = command.args.at(-1)!;
    if (!this.inspections.has(name) && this.pendingCreatedInspection?.name === name) {
      if (this.delayedCreateInspections > 0) this.delayedCreateInspections -= 1;
      else {
        this.inspections.set(name, this.pendingCreatedInspection);
        this.pendingCreatedInspection = null;
      }
    }
    return this.inspections.get(name) ?? null;
  }

  async attach(command: ProviderSessionOciCommand) {
    expect(command.action).toBe('attach');
    this.actions.push('attach');
    const stream = new PassThrough();
    let exit!: (value: { code: number; signal: null }) => void;
    return {
      stream,
      exited: new Promise<{ code: number; signal: null }>((resolve) => { exit = resolve; }),
      close: async () => {
        this.actions.push('detach');
        stream.destroy();
        exit({ code: 0, signal: null });
      },
    };
  }
}

function harness(overrides: {
  readonly maxActive?: number;
  readonly readiness?: ProviderSessionOciReadiness;
} = {}) {
  const mounts = new FakeMounts();
  const oci = new FakeOci();
  if (overrides.readiness) oci.readiness = overrides.readiness;
  const supervisor = new ProviderSessionContainerSupervisor({
    coreProcessId: 'core-process-a',
    engine: 'rootless-podman',
    executable: '/usr/bin/podman',
    images: IMAGES,
    instanceId: 'instance-a',
    maxActive: overrides.maxActive,
    mounts,
    oci,
    createReconcileDelay: () => Promise.resolve(),
    runtimeUser: { gid: 501, uid: 501 },
  });
  return { mounts, oci, supervisor };
}

describe('ProviderSessionContainerSupervisor', () => {
  it('attests a bounded adapter set, launches, revalidates, and tears down exact identity', async () => {
    const { mounts, oci, supervisor } = harness();
    await expect(supervisor.capabilities()).resolves.toMatchObject({
      adapterIds: ['grok-build'], available: true, disabledReason: null,
    });
    const launched = await supervisor.launch(spec());
    expect(launched).toMatchObject({
      processId: 'process-a', runtimeHandle: 'a'.repeat(64), sessionId: 'session-a',
    });
    expect(mounts.revalidate).toHaveBeenCalledTimes(2);
    expect(oci.actions).toEqual(['create', 'start']);

    await expect(supervisor.stop({
      schemaVersion: 1,
      processId: launched.processId,
      runtimeHandle: launched.runtimeHandle,
      sessionId: launched.sessionId,
    })).resolves.toMatchObject({ stopped: true });
    expect(oci.actions).toEqual(['create', 'start', 'stop', 'remove']);
    expect(mounts.release).toHaveBeenCalledTimes(1);
    expect(oci.inspection).toBeNull();
  });

  it('attaches one exact control stream and retires it before destructive teardown', async () => {
    const { mounts, oci, supervisor } = harness();
    const launched = await supervisor.launch(spec());
    const channel = await supervisor.attach({
      schemaVersion: 1,
      processId: launched.processId,
      runtimeHandle: launched.runtimeHandle,
      sessionId: launched.sessionId,
    });
    expect(channel.stream).toBeInstanceOf(PassThrough);
    expect(mounts.revalidate).toHaveBeenCalledTimes(4);
    await expect(supervisor.attach({
      schemaVersion: 1,
      processId: launched.processId,
      runtimeHandle: launched.runtimeHandle,
      sessionId: launched.sessionId,
    })).rejects.toMatchObject({ code: 'conflict' });

    await supervisor.stop({
      schemaVersion: 1,
      processId: launched.processId,
      runtimeHandle: launched.runtimeHandle,
      sessionId: launched.sessionId,
    });
    expect(oci.actions).toEqual(['create', 'start', 'attach', 'detach', 'stop', 'remove']);
    await expect(channel.exited).resolves.toEqual({ code: 0, signal: null });
  });

  it('fails closed before mount capture when the OCI boundary is unavailable or wrong', async () => {
    for (const readiness of [
      { available: false, boundary: null },
      { available: true, boundary: 'desktop-vm' as const },
    ]) {
      const { mounts, supervisor } = harness({ readiness });
      await expect(supervisor.capabilities()).resolves.toMatchObject({
        adapterIds: [], available: false,
      });
      await expect(supervisor.launch(spec())).rejects.toMatchObject({ code: 'unavailable' });
      expect(mounts.capture).not.toHaveBeenCalled();
    }
  });

  it('bounds active sessions and rejects reused session/process identity', async () => {
    const { supervisor } = harness({ maxActive: 1 });
    await supervisor.launch(spec());
    await expect(supervisor.launch(spec({
      launchId: 'launch-b', processId: 'process-b', sessionId: 'session-b',
    }))).rejects.toMatchObject({ code: 'limit' });
    await expect(supervisor.launch(spec({ launchId: 'launch-b' })))
      .rejects.toMatchObject({ code: 'limit' });
    await supervisor.close();
  });

  it('cleans an exact container after an ambiguous create failure', async () => {
    const { mounts, oci, supervisor } = harness();
    oci.failAfterCreate = true;
    await expect(supervisor.launch(spec())).rejects.toMatchObject({ code: 'unavailable' });
    expect(oci.actions).toEqual(['create', 'remove']);
    expect(oci.inspection).toBeNull();
    expect(mounts.release).toHaveBeenCalledTimes(1);
  });

  it('reconciles a delayed exact create before releasing mount authority', async () => {
    const { mounts, oci, supervisor } = harness();
    oci.failAfterCreate = true;
    oci.delayedCreateInspections = 2;
    await expect(supervisor.launch(spec())).rejects.toMatchObject({ code: 'unavailable' });
    expect(oci.actions).toEqual(['create', 'remove']);
    expect(oci.inspection).toBeNull();
    expect(mounts.release).toHaveBeenCalledTimes(1);
  });

  it('retains unresolved create mounts and poisons later capability', async () => {
    const { mounts, oci, supervisor } = harness();
    oci.failAfterCreate = true;
    oci.delayedCreateInspections = 20;
    await expect(supervisor.launch(spec())).rejects.toMatchObject({ code: 'identity-changed' });
    expect(mounts.release).not.toHaveBeenCalled();
    await expect(supervisor.capabilities()).resolves.toMatchObject({ available: false });
    await expect(supervisor.close()).rejects.toThrow('Provider supervisor close failed');
    expect(mounts.release).not.toHaveBeenCalled();
  });

  it('never removes or releases a replaced container and poisons future capability', async () => {
    const { mounts, oci, supervisor } = harness();
    oci.tamperCreatedIdentity = true;
    await expect(supervisor.launch(spec())).rejects.toMatchObject({ code: 'identity-changed' });
    expect(oci.actions).toEqual(['create']);
    expect(mounts.release).not.toHaveBeenCalled();
    await expect(supervisor.capabilities()).resolves.toMatchObject({
      adapterIds: [], available: false,
    });
    await expect(supervisor.launch(spec({
      launchId: 'launch-b', processId: 'process-b', sessionId: 'session-b',
    }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects destructive teardown after runtime identity replacement', async () => {
    const { mounts, oci, supervisor } = harness();
    const launched = await supervisor.launch(spec());
    oci.inspection = { ...oci.inspection!, image: `replaced@sha256:${'c'.repeat(64)}` };
    await expect(supervisor.stop({
      schemaVersion: 1,
      processId: launched.processId,
      runtimeHandle: launched.runtimeHandle,
      sessionId: launched.sessionId,
    })).rejects.toMatchObject({ code: 'identity-changed' });
    expect(oci.actions).toEqual(['create', 'start']);
    expect(mounts.release).not.toHaveBeenCalled();
  });

  it('closes all exact active containers and then rejects new launches', async () => {
    const { mounts, oci, supervisor } = harness();
    await supervisor.launch(spec());
    await supervisor.close();
    expect(oci.actions).toEqual(['create', 'start', 'stop', 'remove']);
    expect(mounts.release).toHaveBeenCalledTimes(1);
    await expect(supervisor.launch(spec({
      launchId: 'launch-b', processId: 'process-b', sessionId: 'session-b',
    }))).rejects.toMatchObject({ code: 'closed' });
  });

  it('tears down the admitted container set concurrently within the fixed cardinality bound', async () => {
    const { oci, supervisor } = harness({ maxActive: 2 });
    await supervisor.launch(spec());
    await supervisor.launch(spec({
      launchId: 'launch-b', processId: 'process-b', sessionId: 'session-b',
    }));
    let releaseStops!: () => void;
    oci.stopGate = new Promise<void>((resolve) => { releaseStops = resolve; });
    const closing = supervisor.close();
    for (let attempt = 0; oci.activeStops < 2 && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(oci.maxConcurrentStops).toBe(2);
    releaseStops();
    await expect(closing).resolves.toBeUndefined();
  });

  it('waits for an in-flight launch fence and removes the exact container before close returns', async () => {
    const { mounts, oci, supervisor } = harness();
    let releaseStart!: () => void;
    oci.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const launch = supervisor.launch(spec());
    for (let index = 0; index < 20 && !oci.actions.includes('start'); index += 1) {
      await Promise.resolve();
    }
    expect(oci.actions).toContain('start');
    const close = supervisor.close();
    releaseStart();
    await expect(launch).rejects.toMatchObject({ code: 'closed' });
    await expect(close).resolves.toBeUndefined();
    expect(oci.actions).toEqual(['create', 'start', 'stop', 'remove']);
    expect(oci.inspection).toBeNull();
    expect(mounts.release).toHaveBeenCalledTimes(1);
  });
});
