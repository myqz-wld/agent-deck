import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encodeWorkerWireMessage,
  type WorkerAttachRequest,
  type WorkerAttached,
} from '@protocol/relay';
import {
  emptyRoutePayload,
  encodeRelayRouteFrame,
  type RelayRouteFrame,
} from '@protocol/relay';
import { WorkerAttachmentConnectError, WorkerAttachmentRetirementError } from './attachment';
import type { LocalWorkerSshConfig } from './config';
import { OpenSshWorkerConnector, type OpenSshSpawn } from './openssh-connector';

const CONFIG: LocalWorkerSshConfig = {
  sshBinary: '/usr/bin/ssh',
  host: 'relay.example.com',
  port: 22,
  user: 'agent-deck-relay',
  identityFile: '/var/lib/agent-deck-worker/id_ed25519',
  knownHostsFile: '/var/lib/agent-deck-worker/known_hosts',
  instanceId: 'instance-a',
  workerId: 'worker-a',
  credentialId: 'credential-a',
  connectTimeoutSeconds: 10,
};

const REQUEST: WorkerAttachRequest = {
  type: 'attach',
  instanceId: 'instance-a',
  workerId: 'worker-a',
  credentialId: 'credential-a',
  mode: 'register',
  generation: null,
  expectedGeneration: null,
};

const ATTACHED: WorkerAttached = {
  type: 'attached',
  instanceId: 'instance-a',
  workerId: 'worker-a',
  generation: 1,
  heartbeatTimeoutMs: 30,
  initialCreditBytes: 256 * 1024,
  maxCreditBytes: 1024 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
};

type ExitBehavior = 'sigterm' | 'sigkill' | 'never';

interface FakeChild extends ChildProcessWithoutNullStreams {
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(exitBehavior: ExitBehavior = 'sigterm'): FakeChild {
  const child = new EventEmitter() as FakeChild;
  let exited = false;
  const emitExit = (signal: NodeJS.Signals): void => {
    if (exited) return;
    exited = true;
    child.emit('exit', null, signal);
  };
  Object.assign(child, {
    pid: 1234,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: NodeJS.Signals) => {
      if (exitBehavior === 'sigterm' && signal === 'SIGTERM') {
        queueMicrotask(() => emitExit(signal));
      }
      if (exitBehavior === 'sigkill' && signal === 'SIGKILL') {
        queueMicrotask(() => emitExit(signal));
      }
      return true;
    }),
  });
  return child;
}

function connectorFor(child: FakeChild, overrides = {}): OpenSshWorkerConnector {
  const spawnProcess = vi.fn(() => child) as unknown as OpenSshSpawn;
  return new OpenSshWorkerConnector(
    {
      handshakeTimeoutMs: 20,
      terminateGraceMs: 5,
      killGraceMs: 5,
      ...overrides,
    },
    spawnProcess,
  );
}

async function attachedSession(
  child: FakeChild,
  connector = connectorFor(child),
): Promise<Awaited<ReturnType<OpenSshWorkerConnector['connect']>>> {
  const pending = connector.connect(CONFIG, REQUEST);
  (child.stdout as PassThrough).write(encodeWorkerWireMessage(ATTACHED));
  return pending;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenSSH Worker connector boundary', () => {
  it('injects spawn and always disables shell command interpretation', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as OpenSshSpawn;
    const connector = new OpenSshWorkerConnector(
      { handshakeTimeoutMs: 20, terminateGraceMs: 5, killGraceMs: 5 },
      spawnProcess,
    );
    const pending = connector.connect(CONFIG, REQUEST);

    expect(spawnProcess).toHaveBeenCalledWith(
      CONFIG.sshBinary,
      expect.arrayContaining(['-F', '/dev/null', 'IdentityAgent=none', '--']),
      expect.objectContaining({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    queueMicrotask(() => child.emit('error', new Error('spawn failed')));
    await expect(pending).rejects.toThrow('spawn failed');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('retires the spawned child when transport listener setup throws', async () => {
    const child = fakeChild();
    vi.spyOn(child.stdin, 'on').mockImplementationOnce(() => {
      throw new Error('listener setup failed');
    });

    await expect(connectorFor(child).connect(CONFIG, REQUEST)).rejects.toThrow(
      'listener setup failed',
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps the session backpressured when the initial attach write returns false', async () => {
    const child = fakeChild();
    vi.spyOn(child.stdin, 'write').mockReturnValueOnce(false);
    const session = await attachedSession(child);
    const frame: RelayRouteFrame = {
      instanceId: 'instance-a',
      generation: 1,
      streamId: 'stream-a',
      direction: 'worker-to-client',
      sequence: 0,
      kind: 'open',
      payload: emptyRoutePayload(),
      creditBytes: null,
      resetCode: null,
      connectionScope: null,
      accessSurface: null,
      accessGrant: null,
    };
    expect(() => session.send(frame)).toThrow('backpressured');
    child.stdin.emit('drain');
    expect(() => session.send(frame)).not.toThrow();
    await session.close();
  });

  it('memoizes retirement and escalates from ignored SIGTERM to SIGKILL', async () => {
    vi.useFakeTimers();
    const child = fakeChild('sigkill');
    const session = await attachedSession(child);
    const first = session.close();
    const second = session.close();
    expect(second).toBe(first);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5);
    await expect(first).resolves.toBeUndefined();
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('surfaces terminal cleanup when SIGKILL also fails to retire the child', async () => {
    vi.useFakeTimers();
    const child = fakeChild('never');
    const session = await attachedSession(child);
    const retirement = session.close();
    const assertion = expect(retirement).rejects.toThrow('did not exit');
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('aggregates retirement failure into a connected transport-loss notification', async () => {
    vi.useFakeTimers();
    const child = fakeChild('never');
    const session = await attachedSession(child);
    const onClose = vi.fn();
    session.setHandlers({ onFrame: vi.fn(), onClose });

    child.stdin.emit('error', new Error('transport lost'));
    await vi.advanceTimersByTimeAsync(10);

    expect(onClose).toHaveBeenCalledWith(expect.any(WorkerAttachmentRetirementError));
    await expect(session.close()).rejects.toThrow('did not exit');
  });

  it('retires the child before rejecting a handshake timeout', async () => {
    vi.useFakeTimers();
    const child = fakeChild('sigkill');
    const pending = connectorFor(child, { handshakeTimeoutMs: 5 }).connect(CONFIG, REQUEST);
    const assertion = expect(pending).rejects.toThrow('handshake timed out');
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('retires the child before surfacing Relay rejection', async () => {
    const child = fakeChild();
    const pending = connectorFor(child).connect(CONFIG, REQUEST);
    (child.stdout as PassThrough).write(
      encodeWorkerWireMessage({
        type: 'rejected',
        code: 'generation_conflict',
        message: 'stale generation',
        retryable: false,
        currentGeneration: 2,
      }),
    );
    await expect(pending).rejects.toBeInstanceOf(WorkerAttachmentConnectError);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('retires the child when stdin fails during handshake', async () => {
    const child = fakeChild();
    const pending = connectorFor(child).connect(CONFIG, REQUEST);
    child.stdin.emit('error', new Error('stdin failed'));
    await expect(pending).rejects.toThrow('stdin failed');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects a negotiated route frame limit larger than the transport', async () => {
    const child = fakeChild();
    const connector = connectorFor(child, { maxWireBytes: 4096 });
    const pending = connector.connect(CONFIG, REQUEST);
    (child.stdout as PassThrough).write(
      encodeWorkerWireMessage({ ...ATTACHED, maxFrameBytes: 4096 }),
    );
    await expect(pending).rejects.toThrow('exceeds maxWireBytes');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails a coalesced post-attach route above the newly negotiated body limit', async () => {
    const child = fakeChild();
    const route: RelayRouteFrame = {
      instanceId: 'instance-a',
      generation: 1,
      streamId: 'coalesced-limit',
      direction: 'client-to-worker',
      sequence: 0,
      kind: 'data',
      payload: new Uint8Array(32),
      creditBytes: null,
      resetCode: null,
      connectionScope: null,
      accessSurface: null,
      accessGrant: null,
    };
    const exactBodyBytes = encodeRelayRouteFrame(route).byteLength - 4;
    const attached = encodeWorkerWireMessage({ ...ATTACHED, maxFrameBytes: exactBodyBytes - 1 });
    const routed = encodeWorkerWireMessage({ type: 'route', frame: route });
    const coalesced = new Uint8Array(attached.byteLength + routed.byteLength);
    coalesced.set(attached);
    coalesced.set(routed, attached.byteLength);

    const pending = connectorFor(child).connect(CONFIG, REQUEST);
    (child.stdout as PassThrough).write(coalesced);
    const session = await pending;
    const onClose = vi.fn();
    session.setHandlers({ onFrame: vi.fn(), onClose });

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onClose.mock.calls[0][0]).toEqual(
      expect.objectContaining({ code: 'frame_oversized' }),
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it.each([
    [{ handshakeTimeoutMs: 0 }, 'handshakeTimeoutMs'],
    [{ handshakeTimeoutMs: 600_001 }, 'handshakeTimeoutMs'],
    [{ terminateGraceMs: 0 }, 'terminateGraceMs'],
    [{ killGraceMs: 600_001 }, 'killGraceMs'],
    [{ maxWireBytes: Number.NaN }, 'maxWireBytes'],
    [{ maxWireBytes: 1023 }, 'maxWireBytes'],
    [{ maxWireBytes: 64 * 1024 * 1024 + 1 }, 'maxWireBytes'],
    [{ maxPendingFrames: -1 }, 'maxPendingFrames'],
    [{ maxPendingFrames: 4097 }, 'maxPendingFrames'],
  ])('rejects unsafe connector option %j', (options, field) => {
    expect(() => new OpenSshWorkerConnector(options)).toThrow(field);
  });
});
