import type { SshTransportTiming } from './types';

type Timer = ReturnType<typeof setTimeout>;

export class ProtocolHeartbeat {
  private pingTimer: Timer | null = null;
  private pongTimer: Timer | null = null;
  private pendingNonce: string | null = null;

  constructor(
    private readonly timing: SshTransportTiming,
    private readonly createNonce: () => string,
    private readonly sendPing: (nonce: string) => void,
    private readonly onTimeout: () => void,
  ) {}

  start(): void {
    this.stop();
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

  stop(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
    this.pendingNonce = null;
  }

  private ping(): void {
    const nonce = this.createNonce();
    this.pendingNonce = nonce;
    try {
      this.sendPing(nonce);
    } catch {
      this.onTimeout();
      return;
    }
    this.pongTimer = setTimeout(this.onTimeout, this.timing.pongTimeoutMs);
  }
}
