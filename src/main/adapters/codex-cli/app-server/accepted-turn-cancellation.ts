import type { CodexAppServerClient } from './client';

export const ACCEPTED_TURN_TERMINATION_TIMEOUT_MS = 1_000;

type CancellationClient = Pick<
  CodexAppServerClient,
  'sendTurnInterrupt' | 'recycleGeneration'
>;

/** Owns exactly one provider interrupt and a bounded terminal-or-recycle wait. */
export class AcceptedTurnCancellation {
  private terminal = false;
  private cancellationPromise: Promise<void> | null = null;
  private finishCancellation: (() => void) | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private recycled = false;

  constructor(
    private readonly client: CancellationClient,
    readonly generation: number,
    readonly threadId: string,
    readonly turnId: string,
    private readonly timeoutMs = ACCEPTED_TURN_TERMINATION_TIMEOUT_MS,
  ) {}

  get isTerminal(): boolean {
    return this.terminal;
  }

  get isCancellationRequested(): boolean {
    return this.cancellationPromise !== null;
  }

  markTerminal(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.finish();
  }

  cancel(error: Error): Promise<void> {
    if (this.terminal) return Promise.resolve();
    if (this.cancellationPromise) return this.cancellationPromise;

    let resolveCancellation!: () => void;
    this.cancellationPromise = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    this.finishCancellation = resolveCancellation;
    this.beginCancellation(error);
    return this.cancellationPromise;
  }

  /** AbortSignal callers can leave their cwd synchronously, so fence before abort() returns. */
  cancelAndRecycle(error: Error): Promise<void> {
    const cancellation = this.cancel(error);
    if (!this.terminal) {
      this.recycle(error);
      this.finish();
    }
    return cancellation;
  }

  private beginCancellation(error: Error): void {
    let interruptSent = false;
    try {
      interruptSent = this.client.sendTurnInterrupt(
        this.generation,
        this.threadId,
        this.turnId,
      );
    } catch {
      interruptSent = false;
    }
    if (this.terminal) {
      this.finish();
      return;
    }
    if (!interruptSent) {
      this.recycle(error);
      this.finish();
      return;
    }

    this.timeout = setTimeout(() => {
      this.timeout = null;
      if (!this.terminal) this.recycle(error);
      this.finish();
    }, this.timeoutMs);
    this.timeout.unref();
  }

  private recycle(error: Error): void {
    if (this.recycled) return;
    this.recycled = true;
    try {
      this.client.recycleGeneration(
        this.generation,
        error,
        'accepted turn cancellation',
      );
    } catch {
      // The generation is already fenced or dead; cancellation must still settle locally.
    }
  }

  private finish(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    const finish = this.finishCancellation;
    this.finishCancellation = null;
    finish?.();
  }
}

/** Bridges caller abort across the turn/start response-versus-notification acceptance race. */
export class AcceptedTurnCancellationOwner {
  readonly acceptanceAbort: Promise<never>;
  private rejectAcceptance: ((error: Error) => void) | null = null;
  private accepted: AcceptedTurnCancellation | null = null;
  private observedAbort: Error | null = null;

  constructor(
    private readonly client: CancellationClient,
    private readonly generation: number,
    private readonly threadId: string,
    private readonly onAcceptedAbort: (error: Error) => void,
  ) {
    this.acceptanceAbort = new Promise<never>((_resolve, reject) => {
      this.rejectAcceptance = reject;
    });
  }

  get cancellation(): AcceptedTurnCancellation | null {
    return this.accepted;
  }

  get abortError(): Error | null {
    return this.observedAbort;
  }

  isCancelling(turnId: string): boolean {
    return this.accepted?.turnId === turnId && this.accepted.isCancellationRequested;
  }

  accept(turnId: string): AcceptedTurnCancellation {
    if (this.accepted) {
      if (this.accepted.turnId === turnId) return this.accepted;
      const error = new Error(
        `Codex app-server accepted conflicting turn ids ${this.accepted.turnId} and ${turnId}`,
      );
      void this.accepted.cancelAndRecycle(error);
      throw error;
    }
    this.accepted = new AcceptedTurnCancellation(
      this.client,
      this.generation,
      this.threadId,
      turnId,
    );
    if (this.observedAbort) {
      this.onAcceptedAbort(this.observedAbort);
      void this.accepted.cancelAndRecycle(this.observedAbort);
    }
    return this.accepted;
  }

  abort(): void {
    if (this.observedAbort) return;
    this.observedAbort = new Error('Codex turn interrupted');
    if (this.accepted) {
      this.onAcceptedAbort(this.observedAbort);
      void this.accepted.cancelAndRecycle(this.observedAbort);
    } else {
      try {
        this.client.recycleGeneration(
          this.generation,
          this.observedAbort,
          'turn/start cancellation before acceptance',
        );
      } catch {
        // The abort promise below still releases the pre-acceptance waiter.
      }
    }
    this.rejectAcceptance?.(this.observedAbort);
    this.rejectAcceptance = null;
  }
}
