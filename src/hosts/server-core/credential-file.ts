import {
  type DaemonClientAccessSurface,
  type DaemonCredentialIdentity,
  type DaemonCredentialLifecyclePort,
  type DaemonCredentialRevocationSubscription,
} from '@hosts/daemon';
import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import {
  assertExactKeys,
  requireAbsolutePath,
  requireLinuxInstanceId,
  requireObject,
  requirePositiveInteger,
  requireStableToken,
} from '@hosts/linux-runtime/validation';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';

const MAX_CREDENTIALS = 256;
const MAX_CREDENTIAL_FILE_BYTES = 128 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 60_000;

export interface ServerCoreCredentialRecord {
  readonly credentialId: string;
  readonly surface: DaemonClientAccessSurface;
  readonly status: 'active' | 'revoked';
}

export interface ServerCoreCredentialDocument {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly credentials: readonly ServerCoreCredentialRecord[];
}

export interface ServerCoreCredentialFileOptions {
  readonly instanceId: string;
  readonly processId: string;
  readonly path: string;
  readonly diagnostics: ServerCoreRuntimeDiagnostics;
  readonly pollIntervalMs?: number;
  readonly readDocument?: () => Promise<unknown>;
}

function surface(value: unknown): DaemonClientAccessSurface {
  if (value !== 'desktop-full' && value !== 'feishu-session-console') {
    throw new Error('credential surface is invalid');
  }
  return value;
}

function status(value: unknown): 'active' | 'revoked' {
  if (value !== 'active' && value !== 'revoked') {
    throw new Error('credential status is invalid');
  }
  return value;
}

function record(value: unknown): ServerCoreCredentialRecord {
  const object = requireObject(value, 'credential record');
  assertExactKeys(object, ['credentialId', 'status', 'surface'], 'credential record');
  return Object.freeze({
    credentialId: requireStableToken(object.credentialId, 'credentialId'),
    surface: surface(object.surface),
    status: status(object.status),
  });
}

export function parseServerCoreCredentialDocument(
  value: unknown,
  expectedInstanceId: string,
): ServerCoreCredentialDocument {
  const object = requireObject(value, 'credential document');
  assertExactKeys(
    object,
    ['credentials', 'instanceId', 'schemaVersion'],
    'credential document',
  );
  if (object.schemaVersion !== 1) throw new Error('credential schemaVersion must be 1');
  const instanceId = requireLinuxInstanceId(object.instanceId);
  if (instanceId !== expectedInstanceId) throw new Error('credential instance does not match');
  if (!Array.isArray(object.credentials) || object.credentials.length > MAX_CREDENTIALS) {
    throw new Error('credentials must be a bounded array');
  }
  const credentials = object.credentials.map(record);
  const identities = credentials.map((entry) => key(entry.credentialId, entry.surface));
  if (new Set(identities).size !== identities.length) {
    throw new Error('credential identities must be unique');
  }
  return Object.freeze({
    schemaVersion: 1,
    instanceId,
    credentials: Object.freeze(credentials),
  });
}

function key(credentialId: string, accessSurface: DaemonClientAccessSurface): string {
  return JSON.stringify([credentialId, accessSurface]);
}

function activeCredentials(document: ServerCoreCredentialDocument): ReadonlySet<string> {
  return new Set(document.credentials
    .filter((entry) => entry.status === 'active')
    .map((entry) => key(entry.credentialId, entry.surface)));
}

/** Private-file-backed pull and push lifecycle for direct Server Core credentials. */
export class ServerCoreCredentialFile implements DaemonCredentialLifecyclePort {
  readonly path: string;
  private readonly pollIntervalMs: number;
  private readonly readDocument: () => Promise<unknown>;

  constructor(private readonly options: ServerCoreCredentialFileOptions) {
    requireLinuxInstanceId(options.instanceId);
    requireStableToken(options.processId, 'processId');
    this.path = requireAbsolutePath(options.path, 'credentialFile');
    this.pollIntervalMs = requirePositiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      'credential poll interval',
      MAX_POLL_INTERVAL_MS,
    );
    this.readDocument = options.readDocument ?? (() => readPrivateJsonFile(this.path, {
      maxBytes: MAX_CREDENTIAL_FILE_BYTES,
    }));
  }

  async isActive(input: {
    readonly identity: DaemonCredentialIdentity;
    readonly signal: AbortSignal;
  }): Promise<boolean> {
    if (input.signal.aborted || !this.matchesProcess(input.identity)) return false;
    const active = await this.readActive();
    return !input.signal.aborted && active.has(key(
      input.identity.accessCredentialId,
      input.identity.accessSurface,
    ));
  }

  async subscribeRevocations(
    onRevoked: (identity: DaemonCredentialIdentity) => void,
  ): Promise<DaemonCredentialRevocationSubscription> {
    let previous = await this.readActive();
    let closed = false;
    let operation: Promise<void> | null = null;
    const poll = (): void => {
      if (closed || operation) return;
      operation = this.readActive().then(
        (current) => {
          if (closed) return;
          this.publishRemoved(previous, current, onRevoked);
          previous = current;
        },
        () => {
          if (closed) return;
          this.warn('credential file became unavailable');
          const empty = new Set<string>();
          this.publishRemoved(previous, empty, onRevoked);
          previous = empty;
        },
      ).finally(() => { operation = null; });
    };
    const timer = setInterval(poll, this.pollIntervalMs);
    timer.unref();
    return Object.freeze({
      close: async () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        await operation?.catch(() => undefined);
      },
    });
  }

  private async readActive(): Promise<ReadonlySet<string>> {
    return activeCredentials(parseServerCoreCredentialDocument(
      await this.readDocument(),
      this.options.instanceId,
    ));
  }

  private matchesProcess(identity: DaemonCredentialIdentity): boolean {
    return identity.instanceId === this.options.instanceId &&
      identity.processId === this.options.processId;
  }

  private publishRemoved(
    previous: ReadonlySet<string>,
    current: ReadonlySet<string>,
    onRevoked: (identity: DaemonCredentialIdentity) => void,
  ): void {
    for (const encoded of previous) {
      if (current.has(encoded)) continue;
      const [credentialId, accessSurface] = JSON.parse(encoded) as [
        string,
        DaemonClientAccessSurface,
      ];
      try {
        onRevoked(Object.freeze({
          instanceId: this.options.instanceId,
          processId: this.options.processId,
          accessCredentialId: credentialId,
          accessSurface,
        }));
      } catch {
        // One consumer callback cannot prevent the remaining exact revocations.
      }
    }
  }

  private warn(message: string): void {
    try { this.options.diagnostics.warn(message); } catch {}
  }
}
