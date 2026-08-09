import { AtomicPrivateStateFile } from '@hosts/linux-runtime/atomic-state-file';

interface GenerationEnvelope {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly workerId: string;
  readonly generation: number;
}

export class LocalWorkerGenerationStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(
    private readonly file: AtomicPrivateStateFile,
    readonly instanceId: string,
    readonly workerId: string,
  ) {}

  async load(): Promise<number | null> {
    const bytes = await this.file.read();
    if (!bytes) return null;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error('Worker generation state is invalid');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Worker generation state is invalid');
    }
    const envelope = value as Partial<GenerationEnvelope>;
    if (
      Object.keys(envelope).sort().join(',') !==
        'generation,instanceId,schemaVersion,workerId' ||
      envelope.schemaVersion !== 1 ||
      envelope.instanceId !== this.instanceId ||
      envelope.workerId !== this.workerId ||
      !Number.isSafeInteger(envelope.generation) ||
      (envelope.generation as number) < 1
    ) {
      throw new Error('Worker generation state does not match this Worker');
    }
    return envelope.generation as number;
  }

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  record(generation: number): Promise<void> {
    if (!this.started || !Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('Worker generation cannot be recorded');
    }
    const bytes = new TextEncoder().encode(`${JSON.stringify({
      schemaVersion: 1,
      instanceId: this.instanceId,
      workerId: this.workerId,
      generation,
    })}\n`);
    const write = this.writeQueue.then(() => this.file.write(bytes));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.writeQueue;
  }
}
