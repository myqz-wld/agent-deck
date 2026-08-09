import type { FullResourceSpec, ManagedTopology } from './types';
import { decodeUtf8 } from './serialization';
import { fail, validateFullResources, validateImage, validateInstanceId } from './validation';

const FULL_TOKENS = [
  'IMAGE_DIGEST',
  'VERIFIED_EGRESS_NETWORK',
  'TMPFS_SIZE',
  'MEMORY_LIMIT',
  'PIDS_LIMIT',
  'CPU_LIMIT',
  'ROOTFS_SIZE',
  'LOG_SIZE',
] as const;

function replaceExactToken(source: string, token: string, value: string): string {
  const marker = `@@${token}@@`;
  const matches = source.split(marker).length - 1;
  if (matches !== 1) fail('tampered', `full Quadlet template must contain exactly one ${marker}`);
  return source.replace(marker, value);
}

function renderFull(source: string, instanceId: string, image: string, resources: FullResourceSpec): string {
  validateFullResources(resources);
  const cpu = resources.cpuCores.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const values: Record<(typeof FULL_TOKENS)[number], string> = {
    IMAGE_DIGEST: image,
    VERIFIED_EGRESS_NETWORK: `agent-deck-${instanceId}-egress`,
    TMPFS_SIZE: `${resources.tmpfsBytes}`,
    MEMORY_LIMIT: `${resources.memoryBytes}`,
    PIDS_LIMIT: `${resources.pids}`,
    CPU_LIMIT: cpu,
    ROOTFS_SIZE: `${resources.rootfsBytes}`,
    LOG_SIZE: `${resources.logBytes}`,
  };
  let rendered = source;
  for (const token of FULL_TOKENS) rendered = replaceExactToken(rendered, token, values[token]);
  if (rendered.includes('@@')) fail('tampered', 'full Quadlet retained an unknown placeholder');
  return rendered;
}

function renderRelay(source: string, image: string): string {
  const imageLines = source.match(/^Image=.*$/gm) ?? [];
  if (imageLines.length !== 1 || !imageLines[0].includes('__REPLACE_WITH_PINNED_DIGEST__')) {
    fail('tampered', 'relay Quadlet template must contain one digest placeholder image');
  }
  const rendered = source.replace(imageLines[0], `Image=${image}`);
  if (rendered.includes('__REPLACE_')) fail('tampered', 'relay Quadlet retained a placeholder');
  return rendered;
}

function rejectRuntimeExposure(rendered: string): void {
  const forbidden = [
    /(?:docker|podman|containerd)\.sock/i,
    /^(?:PublishPort|ExposeHostPort|AddDevice|AddCapability|EnvironmentHost)=/m,
    /^Network=(?:host|container:)/m,
    /^Volume=\/(?:home|root|Users|dev)?(?:\/|:|$)/m,
    /--privileged(?:\s|$)/,
  ];
  if (forbidden.some((pattern) => pattern.test(rendered))) {
    fail('tampered', 'rendered Quadlet exposes a forbidden host or container-engine capability');
  }
}

export function renderQuadlet(input: {
  readonly topology: ManagedTopology;
  readonly instanceId: string;
  readonly image: string;
  readonly template: Uint8Array;
  readonly fullResources?: FullResourceSpec;
}): string {
  validateInstanceId(input.instanceId);
  validateImage(input.image);
  const source = decodeUtf8(input.template, 'Quadlet template');
  if (!source.endsWith('\n')) fail('tampered', 'Quadlet template must end with a newline');
  const rendered =
    input.topology === 'full'
      ? renderFull(source, input.instanceId, input.image, validateFullResources(input.fullResources))
      : renderRelay(source, input.image);
  rejectRuntimeExposure(rendered);
  const expectedName = input.topology === 'full' ? 'agent-deck-full-%i' : 'agent-deck-relay-%i';
  if (!rendered.includes(`ContainerName=${expectedName}`)) {
    fail('tampered', 'rendered Quadlet lost its topology-specific instance container name');
  }
  if (!rendered.includes(`Image=${input.image}`)) fail('tampered', 'rendered image does not match the request');
  return rendered;
}
