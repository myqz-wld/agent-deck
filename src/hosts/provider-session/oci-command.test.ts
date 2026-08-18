import { describe, expect, it } from 'vitest';

import type { ProviderSessionLaunchSpec } from '@contracts/index';

import {
  PROVIDER_SESSION_CONTAINER_BROKER_SOCKET,
  PROVIDER_SESSION_CONTAINER_BROWSER_SOCKET,
  PROVIDER_SESSION_CONTAINER_CPUS,
  PROVIDER_SESSION_CONTAINER_MEMORY_BYTES,
  PROVIDER_SESSION_CONTAINER_PIDS,
  buildProviderSessionOciPlan,
} from './oci-command';
import type { ProviderSessionHostMountBinding, ProviderSessionImageCatalog } from './types';

const IMAGE = `registry.invalid/agent-deck/provider@sha256:${'a'.repeat(64)}`;
const IMAGES: ProviderSessionImageCatalog = Object.freeze({
  'claude-code-v1': IMAGE,
  'codex-cli-v1': IMAGE,
  'grok-build-v1': IMAGE,
});

function spec(
  effectiveAccess: ProviderSessionLaunchSpec['effectiveAccess'] =
    'selected-directory-read-write',
): ProviderSessionLaunchSpec {
  return {
    schemaVersion: 1,
    adapterId: 'grok-build',
    brokerEndpointId: 'broker-a',
    effectiveAccess,
    launchId: 'launch-a',
    processId: 'process-a',
    providerId: 'xai',
    resourceClass: 'interactive-v1',
    runtimeId: 'grok-build-v1',
    sessionId: 'session-a',
    upstreamId: 'grok-chat',
    workingDirectory: 'repo',
  };
}

const BROWSER_CONTEXT = {
  protocolVersion: 1 as const,
  adapterId: 'grok-build' as const,
  lease: 'abcdefghijklmnopqrstuvwxyz012345',
  runtimeGeneration: 2,
  sourceIdentity: 'runtime-source-a',
};

function binding(overrides: Partial<ProviderSessionHostMountBinding> = {}) {
  return {
    bindingId: 'binding-a',
    browserBrokerSocketPath: null,
    brokerSocketPath: '/run/agent-deck-provider/broker-a.sock',
    selectedDirectory: '/srv/workspace/repo',
    stateDirectory: '/srv/agent-deck-provider/state-a',
    workspaceRoot: '/srv/workspace',
    ...overrides,
  };
}

function plan(
  effectiveAccess: ProviderSessionLaunchSpec['effectiveAccess'] =
    'selected-directory-read-write',
  mount = binding(),
) {
  return buildProviderSessionOciPlan({
    coreProcessId: 'core-process-a',
    engine: 'rootless-podman',
    executable: '/usr/bin/podman',
    images: IMAGES,
    instanceId: 'instance-a',
    mount,
    runtimeUser: { gid: 501, uid: 501 },
    spec: spec(effectiveAccess),
  });
}

function mounts(args: readonly string[]): string[] {
  const result: string[] = [];
  args.forEach((value, index) => {
    if (value === '--mount') result.push(args[index + 1]!);
  });
  return result;
}

describe('provider session OCI command builder', () => {
  it('builds one fixed broker-only, non-root, resource-bounded container', () => {
    const built = plan();
    const create = built.commands.create;
    expect(create.executable).toBe('/usr/bin/podman');
    expect(create.args).toEqual(expect.arrayContaining([
      '--pull=never',
      '--interactive',
      '--read-only',
      '--network=none',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--userns=keep-id:uid=65532,gid=65532',
      '--user=65532:65532',
      `--pids-limit=${PROVIDER_SESSION_CONTAINER_PIDS}`,
      `--memory=${PROVIDER_SESSION_CONTAINER_MEMORY_BYTES}`,
      `--cpus=${PROVIDER_SESSION_CONTAINER_CPUS}`,
      'AGENT_DECK_PROVIDER_SESSION=1',
      `AGENT_DECK_INFERENCE_SOCKET=${PROVIDER_SESSION_CONTAINER_BROKER_SOCKET}`,
      'AGENT_DECK_INFERENCE_TRANSPORT=unix-http-v1',
      IMAGE,
      '/opt/agent-deck/bin/provider-session',
      '--adapter',
      'grok-build',
      '--access',
      'selected-directory-read-write',
    ]));
    expect(mounts(create.args)).toEqual([
      'type=bind,source=/srv/agent-deck-provider/state-a,target=/state',
      `type=bind,source=/run/agent-deck-provider/broker-a.sock,target=${PROVIDER_SESSION_CONTAINER_BROKER_SOCKET},readonly`,
      'type=bind,source=/srv/workspace,target=/workspace,readonly',
      'type=bind,source=/srv/workspace/repo,target=/workspace/repo',
    ]);
    expect(create.environment).toEqual({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' });
    const encoded = JSON.stringify(create);
    expect(encoded).not.toMatch(/docker\.sock|podman\.sock|\.ssh|auth\.json|credential|API_KEY/);
    expect(encoded).not.toContain('/var/lib/agent-deck');
  });

  it('maps all effective access modes without widening the Workspace mount', () => {
    const readOnly = mounts(plan('workspace-read-only').commands.create.args);
    expect(readOnly).toContain('type=bind,source=/srv/workspace,target=/workspace,readonly');
    expect(readOnly).not.toContain('type=bind,source=/srv/workspace/repo,target=/workspace/repo');

    const workspaceWrite = mounts(plan('workspace-read-write').commands.create.args);
    expect(workspaceWrite).toContain('type=bind,source=/srv/workspace,target=/workspace');
    expect(workspaceWrite).not.toContain('type=bind,source=/srv/workspace,target=/workspace,readonly');

    const strict = plan('provider-strict');
    expect(mounts(strict.commands.create.args)).toContain(
      'type=bind,source=/srv/workspace/repo,target=/workspace,readonly',
    );
    expect(strict.commands.create.args).toContain('/workspace');
    expect(mounts(strict.commands.create.args)).not.toContain(
      'type=bind,source=/srv/workspace,target=/workspace,readonly',
    );

    const rootSelected = buildProviderSessionOciPlan({
      coreProcessId: 'core-process-a', engine: 'docker-desktop',
      executable: '/usr/local/bin/docker', images: IMAGES, instanceId: 'instance-a',
      mount: binding({ brokerSocketPath: null, selectedDirectory: '/srv/workspace' }),
      runtimeUser: { gid: 501, uid: 501 },
      spec: { ...spec('selected-directory-read-write'), workingDirectory: '.' },
    });
    expect(mounts(rootSelected.commands.create.args)).toContain(
      'type=bind,source=/srv/workspace,target=/workspace',
    );
    expect(mounts(rootSelected.commands.create.args)).not.toContain(
      'type=bind,source=/srv/workspace,target=/workspace,readonly',
    );
    expect(rootSelected.commands.create.args).toContain(
      'AGENT_DECK_INFERENCE_TRANSPORT=stdio-multiplex-v1',
    );
    expect(JSON.stringify(rootSelected.commands.create.args)).not.toContain(
      PROVIDER_SESSION_CONTAINER_BROKER_SOCKET,
    );
  });

  it('mounts only the private Browser socket for rootless and uses multiplex on Desktop VM', () => {
    const rootless = buildProviderSessionOciPlan({
      coreProcessId: 'core-process-a', engine: 'rootless-podman',
      executable: '/usr/bin/podman', images: IMAGES, instanceId: 'instance-a',
      mount: binding({ browserBrokerSocketPath: '/run/private/browser.sock' }),
      runtimeUser: { gid: 501, uid: 501 },
      spec: { ...spec(), browserContext: BROWSER_CONTEXT },
    });
    expect(mounts(rootless.commands.create.args)).toContain(
      `type=bind,source=/run/private/browser.sock,target=${PROVIDER_SESSION_CONTAINER_BROWSER_SOCKET},readonly`,
    );
    expect(rootless.commands.create.args).toContain('AGENT_DECK_BROWSER_TRANSPORT=unix-v1');
    const encoded = rootless.commands.create.args.find((value) =>
      value.startsWith('AGENT_DECK_BROWSER_CONTEXT_B64='))!.split('=')[1]!;
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual(BROWSER_CONTEXT);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).not.toContain('session-a');

    const desktop = buildProviderSessionOciPlan({
      coreProcessId: 'core-process-a', engine: 'docker-desktop',
      executable: '/usr/local/bin/docker', images: IMAGES, instanceId: 'instance-a',
      mount: binding({ brokerSocketPath: null }),
      runtimeUser: { gid: 501, uid: 501 },
      spec: { ...spec(), browserContext: BROWSER_CONTEXT },
    });
    expect(desktop.commands.create.args).toContain(
      'AGENT_DECK_BROWSER_TRANSPORT=stdio-multiplex-v1',
    );
    expect(JSON.stringify(mounts(desktop.commands.create.args)))
      .not.toContain(PROVIDER_SESSION_CONTAINER_BROWSER_SOCKET);
  });

  it('derives fixed identity-bound lifecycle commands', () => {
    const first = plan();
    const second = buildProviderSessionOciPlan({
      coreProcessId: 'core-process-a',
      engine: 'docker-desktop',
      executable: '/usr/local/bin/docker',
      images: IMAGES,
      instanceId: 'instance-a',
      mount: binding({ brokerSocketPath: null }),
      runtimeUser: { gid: 501, uid: 501 },
      spec: { ...spec(), processId: 'process-b' },
    });
    expect(first.containerName).toMatch(/^agent-deck-provider-[a-f0-9]{24}$/);
    expect(second.containerName).not.toBe(first.containerName);
    expect(second.commands.create.args).toContain('--user=501:501');
    expect(second.commands.create.args).not.toContain('--userns=keep-id:uid=65532,gid=65532');
    for (const action of ['attach', 'inspect', 'remove', 'start', 'stop'] as const) {
      expect(first.commands[action].args.at(-1)).toBe(first.containerName);
      expect(first.commands[action].args).toContain('--');
    }
    expect(first.commands.attach.args).toEqual([
      'container', 'attach', '--detach-keys=ctrl-]', '--sig-proxy=false', '--',
      first.containerName,
    ]);
  });

  it('rejects unpinned images and ambiguous or overlapping host paths', () => {
    expect(() => buildProviderSessionOciPlan({
      coreProcessId: 'core-process-a', engine: 'rootless-podman',
      executable: '/usr/bin/podman', images: { ...IMAGES, 'grok-build-v1': 'latest' },
      instanceId: 'instance-a', mount: binding(),
      runtimeUser: { gid: 501, uid: 501 }, spec: spec(),
    })).toThrow('pinned');
    expect(() => plan(undefined, binding({
      selectedDirectory: '/srv/workspace/other',
    }))).toThrow('does not match');
    expect(() => plan(undefined, binding({
      stateDirectory: '/srv/workspace/.agent-deck',
    }))).toThrow('disjoint');
    expect(() => plan(undefined, binding({
      brokerSocketPath: '/srv/workspace/broker.sock',
    }))).toThrow('overlaps');
    expect(() => plan(undefined, binding({
      workspaceRoot: '/srv/work,space',
      selectedDirectory: '/srv/work,space/repo',
    }))).toThrow('OCI-safe');
  });

  it('accepts an immutable local engine image id without requiring a mutable tag', () => {
    const localId = `sha256:${'d'.repeat(64)}`;
    const built = buildProviderSessionOciPlan({
      coreProcessId: 'core-process-a', engine: 'docker-desktop',
      executable: '/usr/local/bin/docker', images: { ...IMAGES, 'grok-build-v1': localId },
      instanceId: 'instance-a', mount: binding({ brokerSocketPath: null }),
      runtimeUser: { gid: 501, uid: 501 }, spec: spec(),
    });
    expect(built.expectedImage).toBe(localId);
    expect(built.commands.create.args).toContain(localId);
  });
});
