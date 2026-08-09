import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  parseProviderSessionLaunchSpec,
  type ProviderSessionAdapterId,
  type ProviderSessionLaunchSpec,
} from '@contracts/index';

import {
  PROVIDER_SESSION_CONTAINER_MAX_OUTPUT_BYTES,
  PROVIDER_SESSION_CONTAINER_TIMEOUT_MS,
  isPinnedProviderSessionImage,
  type ProviderSessionHostMountBinding,
  type ProviderSessionOciEngine,
  type ProviderSessionOciCommand,
  type ProviderSessionOciCommandAction,
  type ProviderSessionOciInspection,
  type ProviderSessionOciPlan,
  type ProviderSessionOciPlanInput,
} from './types';

export const PROVIDER_SESSION_CONTAINER_WORKSPACE = '/workspace';
export const PROVIDER_SESSION_CONTAINER_STATE = '/state';
export const PROVIDER_SESSION_CONTAINER_BROKER_SOCKET = '/run/agent-deck/inference.sock';
export const PROVIDER_SESSION_CONTAINER_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
export const PROVIDER_SESSION_CONTAINER_TMPFS_BYTES = 512 * 1024 * 1024;
export const PROVIDER_SESSION_CONTAINER_PIDS = 256;
export const PROVIDER_SESSION_CONTAINER_CPUS = 2;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const RUNTIME_ENTRYPOINT: Readonly<Record<ProviderSessionAdapterId, readonly string[]>> =
  Object.freeze({
    'claude-code': Object.freeze([
      '/opt/agent-deck/bin/provider-session', '--adapter', 'claude-code',
    ]),
    'codex-cli': Object.freeze([
      '/opt/agent-deck/bin/provider-session', '--adapter', 'codex-cli',
    ]),
    'grok-build': Object.freeze([
      '/opt/agent-deck/bin/provider-session', '--adapter', 'grok-build',
    ]),
  });

function normalizedAbsolutePath(value: string, field: string): string {
  if (
    !isAbsolute(value) || resolve(value) !== value || value === '/' || CONTROL.test(value) ||
    Buffer.byteLength(value) > 4_096 || value.includes(',')
  ) throw new Error(`${field} must be one OCI-safe normalized absolute path`);
  return value;
}

function token(value: string, field: string): string {
  if (!TOKEN.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function hostUserId(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fff_ffff) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function within(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (
    relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
  );
}

function disjoint(left: string, right: string, field: string): void {
  if (within(left, right) || within(right, left)) {
    throw new Error(`${field} host paths must be disjoint`);
  }
}

function expectedSelectedDirectory(
  workspaceRoot: string,
  workingDirectory: string,
): string {
  return workingDirectory === '.'
    ? workspaceRoot
    : resolve(workspaceRoot, ...workingDirectory.split('/'));
}

function validateMount(
  mount: ProviderSessionHostMountBinding,
  spec: ProviderSessionLaunchSpec,
  engine: ProviderSessionOciEngine,
): ProviderSessionHostMountBinding {
  token(mount.bindingId, 'provider mount binding');
  const workspaceRoot = normalizedAbsolutePath(mount.workspaceRoot, 'provider Workspace');
  const selectedDirectory = normalizedAbsolutePath(
    mount.selectedDirectory,
    'provider selected directory',
  );
  const stateDirectory = normalizedAbsolutePath(mount.stateDirectory, 'provider state directory');
  const brokerSocketPath = mount.brokerSocketPath === null
    ? null
    : normalizedAbsolutePath(mount.brokerSocketPath, 'provider broker socket');
  if (
    !within(workspaceRoot, selectedDirectory) ||
    selectedDirectory !== expectedSelectedDirectory(workspaceRoot, spec.workingDirectory)
  ) throw new Error('provider selected directory does not match the Workspace reference');
  disjoint(workspaceRoot, stateDirectory, 'Workspace and provider state');
  if ((engine === 'rootless-podman') !== (brokerSocketPath !== null)) {
    throw new Error('provider broker transport does not match the OCI boundary');
  }
  if (brokerSocketPath && (
    within(workspaceRoot, brokerSocketPath) || within(stateDirectory, brokerSocketPath)
  )) {
    throw new Error('provider broker socket overlaps a model-visible root');
  }
  return Object.freeze({
    bindingId: mount.bindingId,
    brokerSocketPath,
    selectedDirectory,
    stateDirectory,
    workspaceRoot,
  });
}

function mount(source: string, target: string, readOnly: boolean): string {
  return `type=bind,source=${source},target=${target}${readOnly ? ',readonly' : ''}`;
}

function workspaceArgs(
  spec: ProviderSessionLaunchSpec,
  binding: ProviderSessionHostMountBinding,
): { readonly args: string[]; readonly workdir: string } {
  if (spec.effectiveAccess === 'provider-strict') {
    return {
      args: ['--mount', mount(binding.selectedDirectory, PROVIDER_SESSION_CONTAINER_WORKSPACE, true)],
      workdir: PROVIDER_SESSION_CONTAINER_WORKSPACE,
    };
  }
  const rootReadOnly = spec.effectiveAccess === 'workspace-read-only' || (
    spec.effectiveAccess === 'selected-directory-read-write' &&
    binding.selectedDirectory !== binding.workspaceRoot
  );
  const args = [
    '--mount', mount(binding.workspaceRoot, PROVIDER_SESSION_CONTAINER_WORKSPACE, rootReadOnly),
  ];
  if (
    spec.effectiveAccess === 'selected-directory-read-write' &&
    binding.selectedDirectory !== binding.workspaceRoot
  ) {
    args.push('--mount', mount(
      binding.selectedDirectory,
      `${PROVIDER_SESSION_CONTAINER_WORKSPACE}/${spec.workingDirectory}`,
      false,
    ));
  }
  return {
    args,
    workdir: spec.workingDirectory === '.'
      ? PROVIDER_SESSION_CONTAINER_WORKSPACE
      : `${PROVIDER_SESSION_CONTAINER_WORKSPACE}/${spec.workingDirectory}`,
  };
}

function command(
  action: ProviderSessionOciCommandAction,
  executable: string,
  args: readonly string[],
): ProviderSessionOciCommand {
  return Object.freeze({
    action,
    args: Object.freeze([...args]),
    environment: Object.freeze({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }),
    executable,
    maxOutputBytes: PROVIDER_SESSION_CONTAINER_MAX_OUTPUT_BYTES,
    timeoutMs: PROVIDER_SESSION_CONTAINER_TIMEOUT_MS,
  });
}

function identityHash(input: ProviderSessionOciPlanInput): string {
  return createHash('sha256').update([
    input.instanceId,
    input.coreProcessId,
    input.spec.launchId,
    input.spec.processId,
    input.spec.sessionId,
  ].join('\0')).digest('hex');
}

export function buildProviderSessionOciPlan(
  input: ProviderSessionOciPlanInput,
): ProviderSessionOciPlan {
  const spec = parseProviderSessionLaunchSpec(input.spec);
  token(input.instanceId, 'provider supervisor instance');
  token(input.coreProcessId, 'provider supervisor process');
  const executable = normalizedAbsolutePath(input.executable, 'OCI executable');
  const binding = validateMount(input.mount, spec, input.engine);
  const image = input.images[spec.runtimeId];
  if (!isPinnedProviderSessionImage(image)) {
    throw new Error('provider runtime image must be pinned by SHA-256 digest');
  }
  if (input.engine === 'docker-desktop' && input.brokerContainerPath !== undefined) {
    throw new Error('provider broker socket path is unavailable for the Desktop boundary');
  }
  const brokerContainerPath = input.engine === 'rootless-podman'
    ? normalizedAbsolutePath(
      input.brokerContainerPath ?? PROVIDER_SESSION_CONTAINER_BROKER_SOCKET,
      'provider broker container path',
    )
    : null;
  const runtimeUid = hostUserId(input.runtimeUser.uid, 'provider runtime uid');
  const runtimeGid = hostUserId(input.runtimeUser.gid, 'provider runtime gid');
  const identity = identityHash(input);
  const containerName = `agent-deck-provider-${identity.slice(0, 24)}`;
  const expectedLabels = Object.freeze({
    'io.agent-deck.adapter': spec.adapterId,
    'io.agent-deck.identity': identity,
    'io.agent-deck.instance': input.instanceId,
    'io.agent-deck.managed-by': 'agent-deck-provider-supervisor',
    'io.agent-deck.runtime': spec.runtimeId,
  });
  const workspace = workspaceArgs(spec, binding);
  const createArgs: string[] = ['container', 'create', '--name', containerName];
  for (const [key, value] of Object.entries(expectedLabels).sort(([left], [right]) =>
    left.localeCompare(right))) createArgs.push('--label', `${key}=${value}`);
  createArgs.push(
    '--pull=never',
    '--interactive',
    '--read-only',
    '--network=none',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    ...(input.engine === 'rootless-podman'
      ? ['--userns=keep-id:uid=65532,gid=65532', '--user=65532:65532']
      : [`--user=${runtimeUid}:${runtimeGid}`]),
    `--pids-limit=${PROVIDER_SESSION_CONTAINER_PIDS}`,
    `--memory=${PROVIDER_SESSION_CONTAINER_MEMORY_BYTES}`,
    `--cpus=${PROVIDER_SESSION_CONTAINER_CPUS}`,
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${PROVIDER_SESSION_CONTAINER_TMPFS_BYTES}`,
    '--mount', mount(binding.stateDirectory, PROVIDER_SESSION_CONTAINER_STATE, false),
    ...(binding.brokerSocketPath && brokerContainerPath
      ? ['--mount', mount(binding.brokerSocketPath, brokerContainerPath, true)]
      : []),
    ...workspace.args,
    '--workdir', workspace.workdir,
    '--env', 'HOME=/state/home',
    '--env', 'XDG_CACHE_HOME=/state/cache',
    '--env', 'XDG_CONFIG_HOME=/state/config',
    '--env', 'XDG_STATE_HOME=/state/state',
    '--env', 'TMPDIR=/tmp',
    '--env', `AGENT_DECK_INFERENCE_TRANSPORT=${input.engine === 'docker-desktop'
      ? 'stdio-multiplex-v1'
      : 'unix-http-v1'}`,
    ...(brokerContainerPath
      ? ['--env', `AGENT_DECK_INFERENCE_SOCKET=${brokerContainerPath}`]
      : []),
    '--env', 'AGENT_DECK_PROVIDER_SESSION=1',
    '--', image,
    ...RUNTIME_ENTRYPOINT[spec.adapterId],
    '--access',
    spec.effectiveAccess,
  );
  return Object.freeze({
    commands: Object.freeze({
      attach: command('attach', executable, [
        'container', 'attach', '--detach-keys=ctrl-]', '--sig-proxy=false', '--', containerName,
      ]),
      create: command('create', executable, createArgs),
      inspect: command('inspect', executable, [
        'container', 'inspect', '--format=json', '--', containerName,
      ]),
      remove: command('remove', executable, [
        'container', 'rm', '--force', '--volumes', '--', containerName,
      ]),
      start: command('start', executable, ['container', 'start', '--', containerName]),
      stop: command('stop', executable, [
        'container', 'stop', '--time', '10', '--', containerName,
      ]),
    }),
    containerName,
    expectedImage: image,
    expectedLabels,
  });
}

export function assertProviderSessionOciInspection(
  plan: ProviderSessionOciPlan,
  inspection: ProviderSessionOciInspection,
  expected: { readonly running: boolean; readonly runtimeHandle?: string },
): void {
  const actualLabelKeys = Object.keys(inspection.labels).sort();
  const expectedLabelKeys = Object.keys(plan.expectedLabels).sort();
  if (
    inspection.name !== plan.containerName || inspection.image !== plan.expectedImage ||
    !TOKEN.test(inspection.runtimeHandle) || inspection.running !== expected.running ||
    (expected.runtimeHandle !== undefined && inspection.runtimeHandle !== expected.runtimeHandle) ||
    expectedLabelKeys.some((key) => inspection.labels[key] !== plan.expectedLabels[key]) ||
    !expectedLabelKeys.every((key) => actualLabelKeys.includes(key))
  ) throw new Error('provider container identity changed');
}
