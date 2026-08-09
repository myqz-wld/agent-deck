import type { SessionRecord } from '@shared/types';

import type { ServerCoreSpawnLimits } from './mcp-spawn-port';

const MAX_DEPTH = 3;
const MAX_FAN_OUT = 10;
const MAX_RATE = 20;
const RATE_WINDOW_MS = 60_000;

export class ServerCoreSpawnGuardError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly spawnLimits: ServerCoreSpawnLimits,
  ) {
    super(message);
    this.name = 'ServerCoreSpawnGuardError';
  }
}

export interface ServerCoreSpawnGuardSessions {
  listChildren(parentId: string, lifecycle: 'active'): SessionRecord[];
}

export interface ServerCoreSpawnGuardLease {
  readonly parentDepth: number;
  readonly release: () => void;
  snapshot(): ServerCoreSpawnLimits;
}

/** Per-Core recursion, fan-out, and sliding-window guard; values match desktop defaults. */
export class ServerCoreSpawnGuard {
  private readonly inFlight = new Map<string, number>();
  private readonly rate: number[] = [];

  constructor(
    private readonly sessions: ServerCoreSpawnGuardSessions,
    private readonly now: () => number = Date.now,
  ) {}

  reserve(caller: Pick<SessionRecord, 'id' | 'spawnDepth'>): ServerCoreSpawnGuardLease {
    const at = this.now();
    this.prune(at);
    const parentDepth = caller.spawnDepth ?? 0;
    const activeChildren = this.sessions.listChildren(caller.id, 'active').length;
    const inFlight = this.inFlight.get(caller.id) ?? 0;
    const limits = this.limits(parentDepth, activeChildren, inFlight, at);
    if (parentDepth >= MAX_DEPTH) {
      throw new ServerCoreSpawnGuardError(
        `spawn depth ${parentDepth} reached the Core maximum ${MAX_DEPTH}`,
        'Finish in the current session or close a branch before delegating deeper.',
        limits,
      );
    }
    if (activeChildren + inFlight >= MAX_FAN_OUT) {
      throw new ServerCoreSpawnGuardError(
        `spawn fan-out reached the Core maximum ${MAX_FAN_OUT}`,
        'Wait for or close an existing child before spawning another session.',
        limits,
      );
    }
    if (this.rate.length >= MAX_RATE) {
      const retryAfterMs = Math.max(0, RATE_WINDOW_MS - (at - this.rate[0]!));
      throw new ServerCoreSpawnGuardError(
        `Core spawn rate reached ${MAX_RATE} per minute`,
        'Wait for the reported retry window before spawning another session.',
        {
          ...limits,
          rate: { ...limits.rate, retryAfterMs },
        },
      );
    }
    this.rate.push(at);
    this.inFlight.set(caller.id, inFlight + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const current = this.inFlight.get(caller.id) ?? 0;
      if (current <= 1) this.inFlight.delete(caller.id);
      else this.inFlight.set(caller.id, current - 1);
    };
    return {
      parentDepth,
      release,
      snapshot: () => {
        const now = this.now();
        this.prune(now);
        return this.limits(
          parentDepth,
          this.sessions.listChildren(caller.id, 'active').length,
          this.inFlight.get(caller.id) ?? 0,
          now,
        );
      },
    };
  }

  private limits(
    parentDepth: number,
    activeChildren: number,
    inFlight: number,
    _now: number,
  ): ServerCoreSpawnLimits {
    return {
      depth: { current: parentDepth, next: parentDepth + 1, max: MAX_DEPTH },
      fanOut: {
        current: activeChildren + inFlight,
        activeChildren,
        inFlight,
        max: MAX_FAN_OUT,
      },
      rate: {
        current: this.rate.length,
        max: MAX_RATE,
        windowMs: RATE_WINDOW_MS,
        retryAfterMs: 0,
      },
    };
  }

  private prune(now: number): void {
    while (this.rate.length > 0 && now - this.rate[0]! >= RATE_WINDOW_MS) {
      this.rate.shift();
    }
  }
}
