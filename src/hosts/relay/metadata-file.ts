import { AtomicPrivateStateFile } from '@hosts/linux-runtime/atomic-state-file';

import {
  RELAY_METADATA_TABLES,
  RelayMetadataStore,
  type CredentialMetadata,
} from './metadata';

function assertBoundInstance(metadata: RelayMetadataStore, instanceId: string): void {
  for (const table of RELAY_METADATA_TABLES) {
    for (const row of metadata.rows(table)) {
      if (row.instanceId !== instanceId) {
        throw new Error('persisted Relay metadata belongs to a foreign instance');
      }
    }
  }
}

export class RelayMetadataFileService {
  private pendingSnapshot: Uint8Array | null = null;
  private drainPromise: Promise<void> | null = null;
  private started = false;
  private failureValue: Error | null = null;

  private constructor(
    readonly metadata: RelayMetadataStore,
    private readonly file: AtomicPrivateStateFile,
  ) {
    metadata.setMutationObserver(() => this.markDirty());
    this.markDirty();
  }

  static async open(input: {
    readonly stateFile: string;
    readonly instanceId: string;
    readonly credentials: readonly CredentialMetadata[];
  }): Promise<RelayMetadataFileService> {
    const file = new AtomicPrivateStateFile(input.stateFile);
    const bytes = await file.read();
    const metadata = bytes
      ? RelayMetadataStore.fromSnapshot(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      : new RelayMetadataStore();
    assertBoundInstance(metadata, input.instanceId);
    if (metadata.getById('instances', input.instanceId) === null) {
      metadata.put('instances', {
        id: input.instanceId,
        instanceId: input.instanceId,
        topology: 'relay',
        createdAt: Date.now(),
      });
    }
    if (input.credentials.some((entry) => entry.instanceId !== input.instanceId)) {
      throw new Error('configured Relay credential belongs to a foreign instance');
    }
    const configured = new Set(input.credentials.map((entry) => entry.credentialId));
    if (configured.size !== input.credentials.length) {
      throw new Error('configured Relay credentials contain duplicate ids');
    }
    for (const existing of metadata.rows('credentials')) {
      if (!configured.has(existing.credentialId)) {
        throw new Error('persisted Relay credential is absent from authoritative config');
      }
    }
    for (const entry of input.credentials) metadata.put('credentials', entry);
    const authoritative = RelayMetadataStore.fromSnapshot(metadata.exportSnapshot());
    assertBoundInstance(authoritative, input.instanceId);
    return new RelayMetadataFileService(authoritative, file);
  }

  get failure(): Error | null {
    return this.failureValue;
  }

  async start(): Promise<void> {
    this.started = true;
    this.scheduleDrain();
    await this.drainPromise;
    if (this.failureValue) {
      this.started = false;
      this.metadata.setMutationObserver(null);
      throw this.failureValue;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.scheduleDrain(true);
    await this.drainPromise;
    if (this.failureValue) throw this.failureValue;
    this.metadata.setMutationObserver(null);
  }

  private markDirty(): void {
    if (this.failureValue) throw this.failureValue;
    this.pendingSnapshot = new TextEncoder().encode(`${this.metadata.exportSnapshot()}\n`);
    if (this.started) this.scheduleDrain();
  }

  private scheduleDrain(force = false): void {
    if ((!this.started && !force) || this.drainPromise || !this.pendingSnapshot) return;
    const drain = async (): Promise<void> => {
      while (this.pendingSnapshot) {
        const snapshot = this.pendingSnapshot;
        this.pendingSnapshot = null;
        await this.file.write(snapshot);
      }
    };
    const operation = drain()
      .catch((error) => {
        this.failureValue = error instanceof Error ? error : new Error('Relay metadata write failed');
      })
      .finally(() => {
        if (this.drainPromise === operation) this.drainPromise = null;
        if (this.started && this.pendingSnapshot && !this.failureValue) this.scheduleDrain();
      });
    this.drainPromise = operation;
  }
}
