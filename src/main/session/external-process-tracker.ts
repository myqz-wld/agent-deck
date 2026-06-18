import type { SessionRecord } from '@shared/types';

interface ExternalProcessTrackerDeps {
  getSession: (sessionId: string) => SessionRecord | null;
  closeSession: (sessionId: string) => void;
  isProcessAlive?: (pid: number) => boolean;
  setIntervalFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (timer: NodeJS.Timeout) => void;
}

const DEFAULT_SCAN_MS = 5_000;

export function extractExternalProcessPid(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const pid = (payload as { externalProcessPid?: unknown }).externalProcessPid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return null;
  return pid;
}

export class ExternalProcessTracker {
  private readonly tracked = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly setIntervalFn: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (timer: NodeJS.Timeout) => void;

  constructor(private readonly deps: ExternalProcessTrackerDeps) {
    this.isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  register(sessionId: string, pid: number | null): void {
    if (pid === null) return;
    this.tracked.set(sessionId, pid);
    this.ensureTimer();
  }

  scanNow(): void {
    for (const [sessionId, pid] of this.tracked) {
      if (this.isProcessAlive(pid)) continue;
      this.tracked.delete(sessionId);
      const rec = this.deps.getSession(sessionId);
      if (rec && rec.source === 'cli' && rec.lifecycle !== 'closed') {
        this.deps.closeSession(sessionId);
      }
    }
    if (this.tracked.size === 0) this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => this.scanNow(), DEFAULT_SCAN_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
