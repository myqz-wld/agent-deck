import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION } from '@contracts/index';

import { assertProviderSessionOciInspection, buildProviderSessionOciPlan } from './oci-command';
import { NodeProviderSessionOci } from './node-oci';
import type {
  ProviderSessionAttachmentProcessPort,
  ProviderSessionAttachmentProcessRequest,
} from './node-oci-attachment';
import {
  NodeProviderSessionProcess,
  type ProviderSessionProcessPort,
  type ProviderSessionProcessRequest,
  type ProviderSessionProcessResult,
} from './node-oci-process';

const roots: string[] = [];
const socketServers: Server[] = [];

afterEach(async () => {
  for (const server of socketServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeProcess implements ProviderSessionProcessPort {
  readonly calls: ProviderSessionProcessRequest[] = [];
  readonly results: ProviderSessionProcessResult[] = [];

  run(request: ProviderSessionProcessRequest): Promise<ProviderSessionProcessResult> {
    this.calls.push(request);
    const result = this.results.shift();
    if (!result) throw new Error('missing fake process result');
    return Promise.resolve(result);
  }
}

class FakeAttachmentProcess implements ProviderSessionAttachmentProcessPort {
  readonly calls: ProviderSessionAttachmentProcessRequest[] = [];

  async open(request: ProviderSessionAttachmentProcessRequest) {
    this.calls.push(request);
    const stream = new PassThrough();
    return {
      stream,
      exited: new Promise<never>(() => undefined),
      close: async () => { stream.destroy(); },
    };
  }
}

function result(overrides: Partial<ProviderSessionProcessResult> = {}): ProviderSessionProcessResult {
  return {
    exitCode: 0,
    outputTruncated: false,
    stderr: '',
    stdout: '',
    timedOut: false,
    ...overrides,
  };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-oci-')));
  roots.push(root);
  const executable = join(root, 'oci');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(executable, 0o700);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const images = {
    'claude-code-v1': null,
    'codex-cli-v1': null,
    'grok-build-v1': `registry.invalid/grok@sha256:${'a'.repeat(64)}`,
  } as const;
  const plan = buildProviderSessionOciPlan({
    coreProcessId: 'core-a',
    engine: 'rootless-podman',
    executable,
    images,
    instanceId: 'instance-a',
    mount: {
      bindingId: 'binding-a',
      browserBrokerSocketPath: null,
      brokerSocketPath: join(root, 'broker.sock'),
      selectedDirectory: join(root, 'workspace', 'repo'),
      stateDirectory: join(root, 'state'),
      workspaceRoot: join(root, 'workspace'),
    },
    runtimeUser: { gid: uid, uid },
    spec: {
      schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
      adapterId: 'grok-build',
      brokerEndpointId: 'endpoint-a',
      effectiveAccess: 'selected-directory-read-write',
      launchId: 'launch-a',
      processId: 'process-a',
      providerId: 'xai',
      projectTrusted: false,
      resourceClass: 'interactive-v1',
      runtimeId: 'grok-build-v1',
      sessionId: 'session-a',
      upstreamId: 'grok-chat',
      workingDirectory: 'repo',
    },
  });
  return { executable, images, plan, root, uid };
}

function inspection(plan: ReturnType<typeof buildProviderSessionOciPlan>, running = true): string {
  return JSON.stringify([{
    Config: { Image: plan.expectedImage, Labels: plan.expectedLabels },
    Id: 'b'.repeat(64),
    Name: plan.containerName,
    State: { Running: running },
  }]);
}

async function privateSocket(root: string): Promise<string> {
  const path = join(root, 'engine.sock');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  socketServers.push(server);
  return path;
}

describe('NodeProviderSessionOci', () => {
  it('proves rootless Podman and runs only fixed host-private command plans', async () => {
    const { executable, plan, root, uid } = fixture();
    const process = new FakeProcess();
    const attachmentProcess = new FakeAttachmentProcess();
    process.results.push(result({ stdout: JSON.stringify({
      host: { security: { rootless: true } },
    }) }));
    const oci = new NodeProviderSessionOci({
      attachmentProcess,
      currentUid: () => uid,
      engine: 'rootless-podman',
      executable,
      platform: 'linux',
      process,
      rootlessHome: root,
      rootlessRuntimeDirectory: `/run/user/${uid}`,
    });
    await expect(oci.probe()).resolves.toEqual({ available: true, boundary: 'rootless-user' });

    process.results.push(result({ stdout: `${'b'.repeat(64)}\n` }));
    await expect(oci.run(plan.commands.create)).resolves.toBeUndefined();
    process.results.push(result({ exitCode: 0 }), result({ stdout: inspection(plan) }));
    await expect(oci.inspect(plan.commands.inspect)).resolves.toMatchObject({
      image: plan.expectedImage,
      name: plan.containerName,
      running: true,
      runtimeHandle: 'b'.repeat(64),
    });

    expect(process.calls[0]!.environment).toMatchObject({
      HOME: root,
      XDG_RUNTIME_DIR: `/run/user/${uid}`,
    });
    expect(JSON.stringify(process.calls)).not.toMatch(/authorization|apiKey|credential/i);
    const attachment = await oci.attach(plan.commands.attach);
    expect(attachmentProcess.calls).toEqual([expect.objectContaining({
      args: plan.commands.attach.args,
      executable,
      environment: expect.objectContaining({ HOME: root, XDG_RUNTIME_DIR: `/run/user/${uid}` }),
    })]);
    await attachment.close();
    await expect(oci.run({
      ...plan.commands.start,
      environment: { ...plan.commands.start.environment, XAI_API_KEY: 'secret' },
    })).rejects.toThrow('fixed plan');
    await expect(oci.attach({
      ...plan.commands.attach,
      args: [...plan.commands.attach.args, '--privileged'],
    })).rejects.toThrow('fixed plan');
  });

  it('returns absence only from an exact existence result and rejects inspection substitution', async () => {
    const { executable, plan, root, uid } = fixture();
    const process = new FakeProcess();
    const oci = new NodeProviderSessionOci({
      currentUid: () => uid,
      engine: 'rootless-podman',
      executable,
      platform: 'linux',
      process,
      rootlessHome: root,
      rootlessRuntimeDirectory: `/run/user/${uid}`,
    });
    process.results.push(result({ exitCode: 1 }));
    await expect(oci.inspect(plan.commands.inspect)).resolves.toBeNull();
    process.results.push(result({ exitCode: 125 }));
    await expect(oci.inspect(plan.commands.inspect)).rejects.toThrow('existence');
    process.results.push(result({ exitCode: 0 }), result({
      stdout: inspection({ ...plan, expectedImage: `other@sha256:${'c'.repeat(64)}` }),
    }));
    const changed = await oci.inspect(plan.commands.inspect);
    expect(() => assertProviderSessionOciInspection(plan, changed!, { running: true }))
      .toThrow('identity changed');
  });

  it('reconciles only exact instance-labelled stale containers before service readiness', async () => {
    const { executable, plan, root, uid } = fixture();
    const process = new FakeProcess();
    const oci = new NodeProviderSessionOci({
      currentUid: () => uid,
      engine: 'rootless-podman',
      executable,
      platform: 'linux',
      process,
      rootlessHome: root,
      rootlessRuntimeDirectory: `/run/user/${uid}`,
    });
    process.results.push(
      result({ stdout: `${plan.containerName}\n` }),
      result({ stdout: inspection(plan) }),
      result(),
      result(),
    );
    await expect(oci.reconcileManaged('instance-a')).resolves.toBeUndefined();
    expect(process.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ['container', 'ls', '--all'],
      ['container', 'inspect', '--format=json'],
      ['container', 'stop', '--time'],
      ['container', 'rm', '--force'],
    ]);

    const replaced = new FakeProcess();
    const guarded = new NodeProviderSessionOci({
      currentUid: () => uid,
      engine: 'rootless-podman',
      executable,
      platform: 'linux',
      process: replaced,
      rootlessHome: root,
      rootlessRuntimeDirectory: `/run/user/${uid}`,
    });
    replaced.results.push(
      result({ stdout: `${plan.containerName}\n` }),
      result({ stdout: inspection({
        ...plan,
        expectedLabels: { ...plan.expectedLabels, 'io.agent-deck.instance': 'instance-b' },
      }) }),
    );
    await expect(guarded.reconcileManaged('instance-a')).rejects.toThrow('identity');
    expect(replaced.calls).toHaveLength(2);
  });

  it('reconciles exact instance-owned leftovers across pinned image upgrades', async () => {
    const { executable, plan, root, uid } = fixture();
    const process = new FakeProcess();
    const stalePlan = {
      ...plan,
      expectedImage: `registry.invalid/grok@sha256:${'c'.repeat(64)}`,
    };
    const oci = new NodeProviderSessionOci({
      currentUid: () => uid,
      engine: 'rootless-podman',
      executable,
      platform: 'linux',
      process,
      rootlessHome: root,
      rootlessRuntimeDirectory: `/run/user/${uid}`,
    });
    process.results.push(
      result({ stdout: `${plan.containerName}\n` }),
      result({ stdout: inspection(stalePlan) }),
      result(),
      result(),
    );

    await expect(oci.reconcileManaged('instance-a')).resolves.toBeUndefined();
    expect(stalePlan.expectedImage).not.toBe(plan.expectedImage);
    expect(process.calls.map((call) => call.args[1])).toEqual(['ls', 'inspect', 'stop', 'rm']);
  });

  it('rejects an otherwise exact stale container with a mutable image reference', async () => {
    const { executable, plan, root, uid } = fixture();
    const process = new FakeProcess();
    const oci = new NodeProviderSessionOci({
      currentUid: () => uid,
      engine: 'rootless-podman',
      executable,
      platform: 'linux',
      process,
      rootlessHome: root,
      rootlessRuntimeDirectory: `/run/user/${uid}`,
    });
    process.results.push(
      result({ stdout: `${plan.containerName}\n` }),
      result({ stdout: inspection({ ...plan, expectedImage: 'registry.invalid/grok:latest' }) }),
    );

    await expect(oci.reconcileManaged('instance-a')).rejects.toThrow('identity');
    expect(process.calls).toHaveLength(2);
  });

  it('proves one private Docker Desktop socket without putting it in a command DTO', async () => {
    const { executable, plan, root, uid } = fixture();
    const process = new FakeProcess();
    const engineSocket = await privateSocket(root);
    process.results.push(result({ stdout: JSON.stringify({
      Name: 'docker-desktop',
      OSType: 'linux',
      OperatingSystem: 'Docker Desktop 4.44',
    }) }));
    const oci = new NodeProviderSessionOci({
      currentUid: () => uid,
      desktopSocketPath: engineSocket,
      desktopVm: 'docker-desktop',
      engine: 'docker-desktop',
      executable,
      platform: 'darwin',
      process,
    });
    await expect(oci.probe()).resolves.toEqual({ available: true, boundary: 'desktop-vm' });
    process.results.push(result({ stdout: '' }));
    await expect(oci.inspect(plan.commands.inspect)).resolves.toBeNull();
    expect(process.calls[0]!.environment.DOCKER_HOST).toBe(`unix://${engineSocket}`);
    expect(JSON.stringify(plan.commands)).not.toContain(engineSocket);
  });
});

describe('NodeProviderSessionProcess', () => {
  it('executes one shell-free bounded child with a cleared explicit environment', async () => {
    const runner = new NodeProviderSessionProcess();
    const completed = await runner.run({
      args: ['ok'],
      environment: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      executable: '/usr/bin/printf',
      maxOutputBytes: 128,
      timeoutMs: 2_000,
    });
    expect(completed).toMatchObject({ exitCode: 0, stderr: '', stdout: 'ok', timedOut: false });

    const bounded = await runner.run({
      args: ['overflow'],
      environment: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      executable: '/usr/bin/printf',
      maxOutputBytes: 4,
      timeoutMs: 2_000,
    });
    expect(bounded.outputTruncated).toBe(true);
    expect(bounded.stdout).toBe('over');

    const timedOut = await runner.run({
      args: ['-f', '/dev/null'],
      environment: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      executable: '/usr/bin/tail',
      maxOutputBytes: 128,
      timeoutMs: 10,
    });
    expect(timedOut).toMatchObject({ exitCode: 124, timedOut: true });
  });
});
