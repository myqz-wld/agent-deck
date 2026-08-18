import type {
  ProviderSessionAdapterId,
  ProviderSessionLaunchSpec,
  ProviderSessionRuntimeId,
} from '@contracts/index';
import type { Duplex } from 'node:stream';

export type ProviderSessionOciEngine = 'docker-desktop' | 'rootless-podman';
export type ProviderSessionOciBoundary = 'desktop-vm' | 'rootless-user';
export type ProviderSessionInferenceTransport = 'stdio-multiplex-v1' | 'unix-http-v1';

/** Host-private mount identity. No value from this object may cross the supervisor port. */
export interface ProviderSessionHostMountBinding {
  readonly bindingId: string;
  readonly browserBrokerSocketPath: string | null;
  readonly brokerSocketPath: string | null;
  readonly selectedDirectory: string;
  readonly stateDirectory: string;
  readonly workspaceRoot: string;
}

export interface ProviderSessionHostMountPort {
  capture(spec: ProviderSessionLaunchSpec): Promise<ProviderSessionHostMountBinding>;
  revalidate(binding: ProviderSessionHostMountBinding): Promise<void>;
  release(binding: ProviderSessionHostMountBinding): Promise<void>;
}

export interface ProviderSessionOciReadiness {
  readonly available: boolean;
  readonly boundary: ProviderSessionOciBoundary | null;
}

export type ProviderSessionOciCommandAction =
  | 'attach'
  | 'create'
  | 'inspect'
  | 'remove'
  | 'start'
  | 'stop';

export interface ProviderSessionOciCommand {
  readonly action: ProviderSessionOciCommandAction;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

export interface ProviderSessionOciInspection {
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly running: boolean;
  readonly runtimeHandle: string;
}

export interface ProviderSessionOciAttachmentExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Host-private stdio attachment to the exact inspected container init process. */
export interface ProviderSessionOciAttachment {
  readonly exited: Promise<ProviderSessionOciAttachmentExit>;
  readonly stream: Duplex;
  close(): Promise<void>;
}

export interface ProviderSessionOciPort {
  probe(): Promise<ProviderSessionOciReadiness>;
  run(command: ProviderSessionOciCommand): Promise<void>;
  inspect(command: ProviderSessionOciCommand): Promise<ProviderSessionOciInspection | null>;
  attach(command: ProviderSessionOciCommand): Promise<ProviderSessionOciAttachment>;
}

export type ProviderSessionImageCatalog = Readonly<Record<ProviderSessionRuntimeId, string | null>>;

export interface ProviderSessionOciPlan {
  readonly commands: Readonly<Record<ProviderSessionOciCommandAction, ProviderSessionOciCommand>>;
  readonly containerName: string;
  readonly expectedImage: string;
  readonly expectedLabels: Readonly<Record<string, string>>;
}

export interface ProviderSessionOciPlanInput {
  readonly brokerContainerPath?: string;
  readonly coreProcessId: string;
  readonly engine: ProviderSessionOciEngine;
  readonly executable: string;
  readonly images: ProviderSessionImageCatalog;
  readonly instanceId: string;
  readonly mount: ProviderSessionHostMountBinding;
  readonly runtimeUser: {
    readonly gid: number;
    readonly uid: number;
  };
  readonly spec: ProviderSessionLaunchSpec;
}

export const PROVIDER_SESSION_MAX_ACTIVE_CONTAINERS = 32;
export const PROVIDER_SESSION_CONTAINER_TIMEOUT_MS = 30_000;
export const PROVIDER_SESSION_CONTAINER_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Accepts an immutable repository digest or the engine's immutable local content-addressed id. */
export function isPinnedProviderSessionImage(value: string | null): value is string {
  return typeof value === 'string' && (
    /^[^\s\0]+@sha256:[a-f0-9]{64}$/.test(value) ||
    /^sha256:[a-f0-9]{64}$/.test(value)
  );
}

export function availableProviderSessionAdapters(
  images: ProviderSessionImageCatalog,
): ProviderSessionAdapterId[] {
  const adapters: ProviderSessionAdapterId[] = [];
  if (isPinnedProviderSessionImage(images['claude-code-v1'])) adapters.push('claude-code');
  if (isPinnedProviderSessionImage(images['codex-cli-v1'])) adapters.push('codex-cli');
  if (isPinnedProviderSessionImage(images['grok-build-v1'])) adapters.push('grok-build');
  return adapters;
}
