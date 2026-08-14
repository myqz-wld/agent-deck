import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import { requirePositiveInteger } from '@hosts/linux-runtime/validation';

import { parseRelayCredentialAuthority } from './credential-authority';
import type { CredentialMetadata, RelayMetadataStore } from './metadata';

export interface RelayCredentialAuthorityServiceOptions {
  readonly instanceId: string;
  readonly authorityFile: string;
  readonly metadata: RelayMetadataStore;
  readonly pollIntervalMs?: number;
  readonly readConfig?: () => Promise<unknown>;
  readonly now?: () => number;
}

/** Keeps Relay's in-memory connection policy synchronized with its Server-owned authority file. */
export class RelayCredentialAuthorityService {
  private readonly pollIntervalMs: number;
  private readonly readConfig: () => Promise<unknown>;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private operation: Promise<void> | null = null;
  private started = false;
  private healthyValue = true;

  constructor(private readonly options: RelayCredentialAuthorityServiceOptions) {
    this.pollIntervalMs = requirePositiveInteger(
      options.pollIntervalMs ?? 500,
      'Relay credential poll interval',
      60_000,
    );
    this.readConfig = options.readConfig ?? (() => readPrivateJsonFile(options.authorityFile));
    this.now = options.now ?? Date.now;
  }

  get healthy(): boolean {
    return this.healthyValue;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Relay credential authority is already started');
    await this.refresh();
    this.started = true;
    this.timer = setInterval(() => this.scheduleRefresh(), this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.operation?.catch(() => undefined);
  }

  async refresh(): Promise<void> {
    const current = parseRelayCredentialAuthority(await this.readConfig(), this.options.instanceId);
    const configured = new Set(current.credentials.map((entry) => entry.credentialId));
    if (this.options.metadata.rows('credentials').some(
      (entry) => !configured.has(entry.credentialId),
    )) {
      throw new Error('Relay credential authority cannot delete credential history');
    }
    for (const entry of current.credentials) this.options.metadata.put('credentials', entry);
    this.healthyValue = true;
  }

  private scheduleRefresh(): void {
    if (!this.started || this.operation) return;
    const operation = this.refresh().catch(() => {
      this.healthyValue = false;
      this.revokeAll();
    }).finally(() => {
      if (this.operation === operation) this.operation = null;
    });
    this.operation = operation;
  }

  private revokeAll(): void {
    const revokedAt = this.now();
    for (const entry of this.options.metadata.rows('credentials')) {
      if (entry.status !== 'active') continue;
      const revoked: CredentialMetadata = {
        ...entry,
        status: 'revoked',
        revokedAt: Math.max(revokedAt, entry.createdAt),
      };
      this.options.metadata.put('credentials', revoked);
    }
  }
}
