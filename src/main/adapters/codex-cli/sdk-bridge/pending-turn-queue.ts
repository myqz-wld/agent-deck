import type { UploadedAttachmentRef } from '@shared/types';
import type { QueuedAgentMessage } from '@main/adapters/types';
import type { CodexInput } from './input-pack';

export interface CodexDeferredUserEvent {
  text: string;
  attachments?: UploadedAttachmentRef[];
  turnCorrelationId?: string;
}

export interface CodexPendingTurn {
  readonly input: CodexInput;
  readonly deferredUserEvent: CodexDeferredUserEvent | null;
  readonly handOffMessage: QueuedAgentMessage | null;
}

type PendingTurnInput = Pick<CodexPendingTurn, 'input'> & Partial<CodexPendingTurn>;

/** One queue owns provider input, acceptance metadata and handoff snapshots at every mutation. */
export class CodexPendingTurnQueue implements Iterable<CodexPendingTurn> {
  private readonly entries: CodexPendingTurn[] = [];

  constructor(entries: readonly PendingTurnInput[] = []) {
    for (const entry of entries) this.append(entry);
  }

  get length(): number { return this.entries.length; }

  [Symbol.iterator](): IterableIterator<CodexPendingTurn> { return this.entries.values(); }

  at(index: number): CodexPendingTurn | undefined { return this.entries.at(index); }

  append(entry: PendingTurnInput): void { this.entries.push(this.normalize(entry)); }

  prepend(entry: PendingTurnInput): void { this.entries.unshift(this.normalize(entry)); }

  consume(): CodexPendingTurn | undefined { return this.entries.shift(); }

  remove(messageId: string): CodexPendingTurn | undefined {
    if (!messageId) return undefined;
    const index = this.entries.findIndex((entry) => entry.deferredUserEvent?.turnCorrelationId === messageId);
    return index < 0 ? undefined : this.entries.splice(index, 1)[0];
  }

  clear(): CodexPendingTurn[] { return this.entries.splice(0); }

  private normalize(entry: PendingTurnInput): CodexPendingTurn {
    return {
      input: entry.input,
      deferredUserEvent: entry.deferredUserEvent ?? null,
      handOffMessage: entry.handOffMessage ?? null,
    };
  }
}
