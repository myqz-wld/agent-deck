import { execFileSync } from 'node:child_process';
import type { SessionRecord } from '@shared/types';

interface ExternalProcessTrackerDeps {
  getSession: (sessionId: string) => SessionRecord | null;
  closeSession: (sessionId: string) => void;
  isProcessAlive?: (pid: number) => boolean;
  resolveTrackedPid?: (candidatePid: number) => number | null;
  setIntervalFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (timer: NodeJS.Timeout) => void;
}

interface ProcessInfo {
  ppid: number;
  comm: string;
  args: string;
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
  private readonly resolveTrackedPid: (candidatePid: number) => number | null;
  private readonly setIntervalFn: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (timer: NodeJS.Timeout) => void;

  constructor(private readonly deps: ExternalProcessTrackerDeps) {
    this.isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
    this.resolveTrackedPid = deps.resolveTrackedPid ?? resolveCodexAncestorPid;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  register(sessionId: string, pid: number | null): void {
    if (pid === null) return;
    const trackedPid = this.resolveTrackedPid(pid);
    if (trackedPid === null) return;
    this.tracked.set(sessionId, trackedPid);
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

export function resolveCodexAncestorPid(
  candidatePid: number,
  inspectProcess: (pid: number) => ProcessInfo | null = readProcessInfo,
): number | null {
  let pid = candidatePid;
  for (let depth = 0; depth < 8; depth += 1) {
    const info = inspectProcess(pid);
    if (!info) return null;
    if (isCodexProcess(info)) return pid;
    if (!Number.isSafeInteger(info.ppid) || info.ppid <= 1 || info.ppid === pid) return null;
    pid = info.ppid;
  }
  return null;
}

function isCodexProcess(info: ProcessInfo): boolean {
  const haystack = `${info.comm} ${info.args}`.toLowerCase();
  if (haystack.includes('/hook/codex') || haystack.includes('agent-deck-hook')) return false;
  return /(^|[/\s])codex($|[\s/.-])/.test(haystack);
}

function readProcessInfo(pid: number): ProcessInfo | null {
  try {
    const ppid = Number(
      execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim(),
    );
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    if (!Number.isSafeInteger(ppid)) return null;
    return { ppid, comm, args };
  } catch {
    return null;
  }
}
