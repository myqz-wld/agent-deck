import type { SshTransportTiming } from './types';

type Timer = ReturnType<typeof setTimeout>;

export interface HeartbeatTimeoutDiagnostic {
  elapsedMs: number;
  timeoutMs: number;
  timerLagMs: number;
  lastReceiveAgeMs: number;
  writeCompleted: boolean;
  writeDelayMs?: number;
}

export class ProtocolHeartbeat {
  private pingTimer: Timer | null = null;
  private pongTimer: Timer | null = null;
  private pendingNonce: string | null = null;
  private generation = 0;
  private lastReceiveAt = 0;

  constructor(
    private readonly timing: SshTransportTiming,
    private readonly createNonce: () => string,
    private readonly sendPing: (nonce: string, onWritten: () => void) => void,
    private readonly onTimeout: (details: HeartbeatTimeoutDiagnostic) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stop();
    this.lastReceiveAt = this.now();
    if (this.timing.pingIntervalMs === 0) return;
    this.pingTimer = setTimeout(() => this.ping(), this.timing.pingIntervalMs);
  }

  acceptPong(nonce: string): void {
    if (nonce !== this.pendingNonce) return;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
    this.pendingNonce = null;
    this.pingTimer = setTimeout(() => this.ping(), this.timing.pingIntervalMs);
  }

  observeReceive(): void { this.lastReceiveAt = this.now(); }

  stop(): void {
    this.generation += 1;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
    this.pendingNonce = null;
  }

  private ping(): void {
    const nonce = this.createNonce();
    this.pendingNonce = nonce;
    const generation = this.generation;
    const queuedAt = this.now();
    let writtenAt: number | null = null;
    let deadline = queuedAt + this.timing.pongTimeoutMs;
    const timeout = (): void => {
      if (generation !== this.generation || this.pendingNonce !== nonce) return;
      const now = this.now();
      this.onTimeout({
        elapsedMs: Math.max(0, now - queuedAt), timeoutMs: this.timing.pongTimeoutMs,
        timerLagMs: Math.max(0, now - deadline),
        lastReceiveAgeMs: Math.max(0, now - this.lastReceiveAt),
        writeCompleted: writtenAt !== null,
        ...(writtenAt === null ? {} : { writeDelayMs: Math.max(0, writtenAt - queuedAt) }),
      });
    };
    try {
      this.sendPing(nonce, () => { writtenAt = this.now(); });
    } catch {
      timeout();
      return;
    }
    // A synchronous transport/test peer may already have replied or retired this generation.
    if (generation !== this.generation || this.pendingNonce !== nonce) return;
    deadline = this.now() + this.timing.pongTimeoutMs;
    this.pongTimer = setTimeout(timeout, this.timing.pongTimeoutMs);
  }
}
