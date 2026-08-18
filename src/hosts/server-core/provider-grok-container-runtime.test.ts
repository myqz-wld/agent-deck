import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderInferenceBrokerRequest,
  ProviderInferenceBrokerResponse,
  ProviderSessionAttachSpec,
  ProviderSessionLaunchSpec,
  ProviderSessionStopSpec,
} from '@contracts/index';
import type {
  ProviderSessionControlChannel,
  ProviderSessionSupervisorControlPort,
} from '@hosts/provider-session/supervisor-port';

import type { ServerCoreProviderInferenceBinding } from './provider-inference-broker-port';
import type { ServerCoreProviderInferenceUnixHttpPort } from './provider-inference-unix-http';
import { ServerCoreProviderGrokContainerRuntime } from './provider-grok-container-runtime';

class FakeChannel implements ProviderSessionControlChannel {
  readonly stream = new PassThrough();
  readonly exited: Promise<{ code: number; signal: null }>;
  private finishExit!: (value: { code: number; signal: null }) => void;
  private closed = false;

  constructor(private readonly calls: string[]) {
    this.exited = new Promise((resolve) => { this.finishExit = resolve; });
  }

  exit(): void {
    this.finishExit({ code: 0, signal: null });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.calls.push('attachment.close');
    this.stream.destroy();
    this.exit();
  }
}

class FakeSupervisor implements ProviderSessionSupervisorControlPort {
  readonly channel: FakeChannel;
  readonly launchSpecs: ProviderSessionLaunchSpec[] = [];
  readonly attachSpecs: ProviderSessionAttachSpec[] = [];
  readonly stopSpecs: ProviderSessionStopSpec[] = [];
  available = true;
  failAttach = false;
  failCloseCount = 0;
  failStopCount = 0;
  launchGate: Promise<void> | null = null;

  constructor(private readonly calls: string[]) {
    this.channel = new FakeChannel(calls);
  }

  async capabilities() {
    this.calls.push('supervisor.capabilities');
    return {
      schemaVersion: 1 as const,
      adapterIds: this.available ? ['grok-build' as const] : [],
      available: this.available,
      disabledReason: this.available ? null : 'runtime unavailable',
      generation: 7,
    };
  }

  async launch(spec: ProviderSessionLaunchSpec) {
    this.calls.push('supervisor.launch');
    this.launchSpecs.push(spec);
    await this.launchGate;
    return {
      schemaVersion: 1 as const,
      launchId: spec.launchId,
      processId: spec.processId,
      runtimeHandle: 'a'.repeat(64),
      sessionId: spec.sessionId,
    };
  }

  async attach(spec: ProviderSessionAttachSpec) {
    this.calls.push('supervisor.attach');
    this.attachSpecs.push(spec);
    if (this.failAttach) throw new Error('attach failed');
    return this.channel;
  }

  async stop(spec: ProviderSessionStopSpec) {
    this.calls.push('supervisor.stop');
    this.stopSpecs.push(spec);
    if (this.failStopCount > 0) {
      this.failStopCount -= 1;
      throw new Error('stop failed');
    }
    return { ...spec, stopped: true as const };
  }

  async close() {
    this.calls.push('supervisor.close');
    if (this.failCloseCount > 0) {
      this.failCloseCount -= 1;
      throw new Error('supervisor close failed');
    }
  }
}

class FakeInference implements ServerCoreProviderInferenceUnixHttpPort {
  readonly bindings: ServerCoreProviderInferenceBinding[] = [];
  availableValue = true;
  throwAvailable = false;

  constructor(private readonly calls: string[]) {}

  async available(binding: ServerCoreProviderInferenceBinding): Promise<boolean> {
    this.calls.push('broker.available');
    this.bindings.push(binding);
    if (this.throwAvailable) throw new Error('availability probe failed');
    return this.availableValue;
  }

  async open(binding: ServerCoreProviderInferenceBinding) {
    this.calls.push('broker.open');
    this.bindings.push(binding);
    return { endpointId: 'endpoint-a' };
  }

  async invoke(
    _endpointId: string,
    request: ProviderInferenceBrokerRequest,
  ): Promise<ProviderInferenceBrokerResponse> {
    return {
      schemaVersion: 1,
      body: '{}',
      contentType: 'application/json',
      requestId: request.requestId,
      statusCode: 200,
    };
  }

  async release(endpointId: string) {
    this.calls.push(`broker.release:${endpointId}`);
  }

  async releaseSession(_sessionId: string) {}

  async close() {
    this.calls.push('broker.close');
  }
}

function harness() {
  const calls: string[] = [];
  const supervisor = new FakeSupervisor(calls);
  const inference = new FakeInference(calls);
  const cleanupFailure = vi.fn();
  const runtime = new ServerCoreProviderGrokContainerRuntime({
    inference,
    instanceId: 'instance-a',
    nextLaunchId: () => 'launch-a',
    nextProcessId: () => 'process-a',
    onCleanupFailure: cleanupFailure,
    supervisor,
  });
  return { calls, cleanupFailure, inference, runtime, supervisor };
}

const OPEN_INPUT = Object.freeze({
  effectiveAccess: 'workspace-read-write' as const,
  sessionId: 'session-a',
  workingDirectory: 'repo',
});
const BROWSER_CONTEXT = Object.freeze({
  protocolVersion: 1 as const,
  adapterId: 'grok-build' as const,
  lease: 'abcdefghijklmnopqrstuvwxyz012345',
  runtimeGeneration: 1,
  sourceIdentity: 'runtime-source-a',
});

describe('Server Core Provider Grok container runtime', () => {
  it('requires both an attested Grok supervisor and the trusted inference broker', async () => {
    const { inference, runtime, supervisor } = harness();
    await expect(runtime.readiness()).resolves.toEqual({
      available: true,
      disabledReason: null,
      supervisorGeneration: 7,
    });
    inference.availableValue = false;
    await expect(runtime.readiness()).resolves.toMatchObject({
      available: false,
      disabledReason: 'provider-inference-broker-unavailable',
    });
    inference.throwAvailable = true;
    await expect(runtime.readiness()).resolves.toMatchObject({
      available: false,
      disabledReason: 'provider-inference-broker-unavailable',
    });
    inference.throwAvailable = false;
    supervisor.available = false;
    await expect(runtime.readiness()).resolves.toMatchObject({
      available: false,
      disabledReason: 'provider-session-supervisor-unavailable',
    });
    await runtime.close();
  });

  it('opens broker before launch, exposes only ACP stdio, and retires in safe order', async () => {
    const { calls, inference, runtime, supervisor } = harness();
    const session = await runtime.open(OPEN_INPUT);
    expect(session).toMatchObject({ processId: 'process-a', sessionId: 'session-a' });
    expect(calls).toEqual([
      'supervisor.capabilities',
      'broker.available',
      'broker.open',
      'supervisor.launch',
      'supervisor.attach',
    ]);
    expect(supervisor.launchSpecs[0]).toEqual({
      schemaVersion: 1,
      adapterId: 'grok-build',
      brokerEndpointId: 'endpoint-a',
      effectiveAccess: 'workspace-read-write',
      launchId: 'launch-a',
      processId: 'process-a',
      providerId: 'xai',
      resourceClass: 'interactive-v1',
      runtimeId: 'grok-build-v1',
      sessionId: 'session-a',
      upstreamId: 'grok-xai',
      workingDirectory: 'repo',
    });
    expect(inference.bindings[1]).toMatchObject({
      instanceId: 'instance-a',
      paths: ['/v1/chat/completions', '/v1/responses'],
      processId: 'process-a',
      sessionId: 'session-a',
    });
    expect(JSON.stringify(supervisor.launchSpecs[0])).not.toMatch(
      /auth|credential|engine|hostPath|image|mount|socket/i,
    );

    await session.close();
    expect(calls.slice(-3)).toEqual([
      'attachment.close',
      'supervisor.stop',
      'broker.release:endpoint-a',
    ]);
    await runtime.close();
    expect(calls.slice(-2).sort()).toEqual(['broker.close', 'supervisor.close']);
  });

  it('rolls back the exact container and broker endpoint when attach fails', async () => {
    const { calls, runtime, supervisor } = harness();
    supervisor.failAttach = true;
    await expect(runtime.open(OPEN_INPUT)).rejects.toThrow('attach failed');
    expect(calls.slice(-3)).toEqual([
      'supervisor.attach',
      'supervisor.stop',
      'broker.release:endpoint-a',
    ]);
    expect(supervisor.stopSpecs[0]).toMatchObject({
      processId: 'process-a',
      runtimeHandle: 'a'.repeat(64),
      sessionId: 'session-a',
    });
    await runtime.close();
  });

  it('passes only the browser-scoped capability into the exact provider launch', async () => {
    const { runtime, supervisor } = harness();
    const session = await runtime.open({ ...OPEN_INPUT, browserContext: BROWSER_CONTEXT });

    expect(supervisor.launchSpecs[0]?.browserContext).toEqual(BROWSER_CONTEXT);
    expect(JSON.stringify(supervisor.launchSpecs[0]?.browserContext)).not.toContain('session-a');
    await session.close();
    await runtime.close();
  });

  it('fences launch-versus-close and releases all resources before dependency shutdown', async () => {
    const { calls, runtime, supervisor } = harness();
    let releaseLaunch!: () => void;
    supervisor.launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const opening = runtime.open(OPEN_INPUT);
    for (let attempt = 0; !calls.includes('supervisor.launch') && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const closing = runtime.close();
    releaseLaunch();
    await expect(opening).rejects.toThrow('closed');
    await expect(closing).resolves.toBeUndefined();
    expect(calls.indexOf('supervisor.stop')).toBeLessThan(calls.indexOf('supervisor.close'));
    expect(calls.indexOf('broker.release:endpoint-a')).toBeLessThan(calls.indexOf('broker.close'));
  });

  it('retries a failed exact stop without reopening the released credential endpoint', async () => {
    const { calls, runtime, supervisor } = harness();
    const session = await runtime.open(OPEN_INPUT);
    supervisor.failStopCount = 1;
    await expect(session.close()).rejects.toThrow('Provider Grok container cleanup failed');
    await expect(session.close()).resolves.toBeUndefined();
    expect(calls.filter((call) => call === 'supervisor.stop')).toHaveLength(2);
    expect(calls.filter((call) => call === 'broker.release:endpoint-a')).toHaveLength(1);
    await runtime.close();
  });

  it('retries dependency cleanup after a rejected aggregate close', async () => {
    const { calls, runtime, supervisor } = harness();
    supervisor.failCloseCount = 1;
    await expect(runtime.close()).rejects.toThrow('runtime shutdown failed');
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(calls.filter((call) => call === 'supervisor.close')).toHaveLength(2);
  });
});
