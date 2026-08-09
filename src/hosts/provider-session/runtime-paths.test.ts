import { describe, expect, it } from 'vitest';

import { providerSessionRuntimePaths } from './runtime-paths';

describe('Provider session runtime paths', () => {
  it('keeps the Linux namespace beneath the provisioned runtime parent', () => {
    const paths = providerSessionRuntimePaths({
      instanceId: 'instance-a',
      platform: 'linux',
      runtimeParent: '/run/agent-deck',
      uid: 1001,
    });
    expect(paths).toMatchObject({
      privateRoot: '/run/agent-deck/.provider-69856ec0faae6daf',
      supervisorSocketPath:
        '/run/agent-deck/.provider-69856ec0faae6daf/supervisor/s.sock',
    });
  });

  it('emits a long Full host path when its descriptor-bound suffix is portable', () => {
    const runtimeParent = '/var/lib/agent-deck/.local/share/containers/storage/volumes/' +
      'agent-deck-instance-a-socket/_data';
    const paths = providerSessionRuntimePaths({
      instanceId: 'instance-a', platform: 'linux', runtimeParent, uid: 1001,
    });
    expect(paths.privateRoot).toBe(`${runtimeParent}/.provider-69856ec0faae6daf`);
    expect(Buffer.byteLength(paths.supervisorSocketPath)).toBeGreaterThan(103);
  });

  it('uses an identity-bound short macOS Relay namespace', () => {
    const paths = providerSessionRuntimePaths({
      instanceId: 'instance-a',
      platform: 'darwin',
      runtimeParent: '/Users/agent/Library/Containers/com.agentdeck.worker-sandbox/Data/' +
        'Library/Application Support/Agent Deck/workers/worker-config-a/core-runtime',
      uid: 501,
      workerConfigId: 'worker-config-a',
    });
    expect(paths).toMatchObject({
      privateRoot: '/private/tmp/adp-501-e5390e564047df54',
      supervisorSocketPath: '/private/tmp/adp-501-e5390e564047df54/supervisor/s.sock',
    });
    expect(Buffer.byteLength(paths.supervisorSocketPath)).toBeLessThanOrEqual(103);
  });

  it('uses a sandbox-mountable short Linux Relay namespace', () => {
    const paths = providerSessionRuntimePaths({
      instanceId: 'instance-a',
      platform: 'linux',
      runtimeParent: '/var/lib/agent-deck/workers/worker-config-a/core-runtime/agent-deck',
      uid: 1001,
      workerConfigId: 'worker-config-a',
    });
    expect(paths.privateRoot).toBe('/run/user/1001/adp-e5390e564047df54');
    expect(Buffer.byteLength(paths.supervisorSocketPath)).toBeLessThanOrEqual(103);
  });

  it('rejects invalid identity, uid, and runtime roots', () => {
    const base = {
      instanceId: 'instance-a',
      platform: 'linux' as const,
      runtimeParent: '/run/agent-deck',
      uid: 1001,
    };
    expect(() => providerSessionRuntimePaths({ ...base, uid: 0 })).toThrow();
    expect(() => providerSessionRuntimePaths({ ...base, instanceId: '../bad' })).toThrow();
    expect(() => providerSessionRuntimePaths({ ...base, runtimeParent: 'relative' })).toThrow();
  });
});
