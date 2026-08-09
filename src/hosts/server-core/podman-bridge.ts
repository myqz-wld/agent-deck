import type { Readable, Writable } from 'node:stream';

import {
  requireLinuxInstanceId,
  requireStableToken,
} from '@hosts/linux-runtime/validation';
import type { BridgeClientSurface } from '@protocol/index';

export interface PodmanBridgeStreamOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly signal?: AbortSignal;
}

export interface ServerCorePodmanHostPort {
  capture(args: readonly string[]): Promise<string>;
  stream(args: readonly string[], options: PodmanBridgeStreamOptions): Promise<void>;
}

export interface ServerCorePodmanBridgeOptions extends PodmanBridgeStreamOptions {
  readonly instanceId: string;
  readonly credentialId: string;
  readonly surface: BridgeClientSurface;
  readonly originalCommand: string | undefined;
}

const REQUIRED_LABELS = Object.freeze({
  'io.agent-deck.managed-by': 'agent-deck-instance-manager',
  'io.agent-deck.topology': 'full',
});

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value as Record<string, unknown>;
}

function parseRootlessInfo(stdout: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Podman rootless evidence is invalid');
  }
  const host = record(record(parsed, 'Podman info').host, 'Podman host');
  if (record(host.security, 'Podman security').rootless !== true) {
    throw new Error('Podman rootless evidence is invalid');
  }
}

function parseContainerIdentity(
  stdout: string,
  instanceId: string,
  expectedName: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Server Core container evidence is invalid');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('Server Core container evidence is invalid');
  }
  const container = record(parsed[0], 'Server Core container');
  const state = record(container.State, 'Server Core container state');
  const config = record(container.Config, 'Server Core container config');
  const labels = record(config.Labels, 'Server Core container labels');
  if (
    container.Name !== expectedName ||
    typeof container.Id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(container.Id) ||
    state.Running !== true ||
    state.Status !== 'running' ||
    labels['io.agent-deck.instance'] !== instanceId ||
    Object.entries(REQUIRED_LABELS).some(([key, value]) => labels[key] !== value)
  ) {
    throw new Error('Server Core container identity is not exact and running');
  }
  return container.Id;
}

/** Host forced-command bridge: verify one exact rootless container, then relay only stdio. */
export async function runServerCorePodmanBridge(
  host: ServerCorePodmanHostPort,
  options: ServerCorePodmanBridgeOptions,
): Promise<void> {
  if (options.originalCommand !== 'agent-deck-bridge') {
    throw new Error('SSH original command does not match the provisioned forced command');
  }
  const instanceId = requireLinuxInstanceId(options.instanceId, 'instance');
  const credentialId = requireStableToken(options.credentialId, 'credential');
  const surface = requireClientSurface(options.surface);
  const containerName = `agent-deck-full-${instanceId}`;
  parseRootlessInfo(await host.capture(['info', '--format=json']));
  const containerId = parseContainerIdentity(
    await host.capture([
      'container',
      'inspect',
      '--format=json',
      '--',
      containerName,
    ]),
    instanceId,
    containerName,
  );
  await host.stream([
    'exec',
    '-i',
    '--detach-keys=',
    '--',
    containerId,
    '/opt/agent-deck/bin/agent-deckd',
    'bridge-internal',
    '--instance',
    instanceId,
    '--credential',
    credentialId,
    '--surface',
    surface,
    '--socket',
    `/run/agent-deck/${instanceId}/agent-deckd.sock`,
  ], {
    input: options.input,
    output: options.output,
    signal: options.signal,
  });
}

function requireClientSurface(value: string): BridgeClientSurface {
  if (value !== 'desktop-full' && value !== 'feishu-session-console') {
    throw new Error('Server Core client surface is invalid');
  }
  return value;
}
