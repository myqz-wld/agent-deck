import type { SessionRecord } from '@shared/types';

import type { ServerCoreSpawnLimits } from './mcp-spawn-port';

const DEFAULT_LIMITS = Object.freeze({ maxDepth: 3, maxFanOut: 10, maxRate: 20 });
const RATE_WINDOW_MS = 60_000;

export interface ServerCoreSpawnGuardLimits {
  readonly maxDepth: number;
  readonly maxFanOut: number;
  readonly maxRate: number;
}

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
    private readonly configuredLimits: ServerCoreSpawnGuardLimits = DEFAULT_LIMITS,
  ) {}

  reserve(caller: Pick<SessionRecord, 'id' | 'spawnDepth'>): ServerCoreSpawnGuardLease {
    const at = this.now();
    this.prune(at);
    const parentDepth = caller.spawnDepth ?? 0;
    const activeChildren = this.sessions.listChildren(caller.id, 'active').length;
    const inFlight = this.inFlight.get(caller.id) ?? 0;
    const limits = this.limits(parentDepth, activeChildren, inFlight, at);
    if (parentDepth >= this.configuredLimits.maxDepth) {
      throw new ServerCoreSpawnGuardError(
        `spawn depth ${parentDepth} reached the Core maximum ${this.configuredLimits.maxDepth}`,
        'Finish in the current session or close a branch before delegating deeper.',
        limits,
      );
    }
    if (activeChildren + inFlight >= this.configuredLimits.maxFanOut) {
      throw new ServerCoreSpawnGuardError(
        `spawn fan-out reached the Core maximum ${this.configuredLimits.maxFanOut}`,
        'Wait for or close an existing child before spawning another session.',
        limits,
      );
    }
    if (this.rate.length >= this.configuredLimits.maxRate) {
      const retryAfterMs = Math.max(0, RATE_WINDOW_MS - (at - this.rate[0]!));
      throw new ServerCoreSpawnGuardError(
        `Core spawn rate reached ${this.configuredLimits.maxRate} per minute`,
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
      depth: {
        current: parentDepth,
        next: parentDepth + 1,
        max: this.configuredLimits.maxDepth,
      },
      fanOut: {
        current: activeChildren + inFlight,
        activeChildren,
        inFlight,
        max: this.configuredLimits.maxFanOut,
      },
      rate: {
        current: this.rate.length,
        max: this.configuredLimits.maxRate,
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
