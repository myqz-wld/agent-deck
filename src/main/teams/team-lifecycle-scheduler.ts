import { sessionRepo } from '@main/store/session-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';

const logger = log.scope('team-lifecycle-scheduler');
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_GRACE_MS = 30 * 60_000;
const DEFAULT_CATCH_UP_DELAY_MS = 1_000;
const PAGE_SIZE = 200;
const MAX_TEAMS_PER_BATCH = 1_000;
const SLOW_BATCH_MS = 50;

interface SchedulerOptions {
  intervalMs?: number;
  graceMs?: number;
  catchUpDelayMs?: number;
}

interface TeamPhaseLog {
  phase: 'candidate-scan' | 'archive' | 'tick';
  candidate: number;
  changed: number;
  skippedLive: number;
  duration: number;
  outcome: 'changed' | 'unchanged' | 'error';
}

function logPhase(result: TeamPhaseLog): void {
  if (result.outcome === 'error') {
    logger.warn('team lifecycle phase failed', result);
  } else if (result.changed > 0 || result.duration >= SLOW_BATCH_MS) {
    logger.info('team lifecycle phase completed', result);
  }
}

export class TeamLifecycleScheduler {
  private timer: NodeJS.Timeout | null = null;
  private catchUpTimer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private graceMs: number;
  private catchUpDelayMs: number;

  constructor(opts: SchedulerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.catchUpDelayMs = opts.catchUpDelayMs ?? DEFAULT_CATCH_UP_DELAY_MS;
  }

  start(): void {
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearCatchUp();
  }

  scan(): void {
    this.clearCatchUp();
    this.runBatch(0);
  }

  private runBatch(offset: number): void {
    const startedAt = Date.now();
    try {
      const result = this.runScan(offset);
      if (result.needsCatchUp) this.scheduleCatchUp(result.nextOffset);
    } catch {
      logPhase({
        phase: 'tick',
        candidate: 0,
        changed: 0,
        skippedLive: 0,
        duration: Date.now() - startedAt,
        outcome: 'error',
      });
    }
  }

  private runScan(startOffset: number): {
    needsCatchUp: boolean;
    nextOffset: number;
  } {
    const now = Date.now();
    const scanStartedAt = Date.now();
    const candidates: string[] = [];
    let candidate = 0;
    let skippedLive = 0;
    let scanFailed = false;
    let exhausted = false;
    let offset = startOffset;

    while (candidate < MAX_TEAMS_PER_BATCH) {
      let batch;
      try {
        const limit = Math.min(PAGE_SIZE, MAX_TEAMS_PER_BATCH - candidate);
        batch = agentDeckTeamRepo.list({
          activeOnly: true,
          limit,
          offset,
        });
        if (batch.length < limit) exhausted = true;
      } catch {
        scanFailed = true;
        break;
      }
      candidate += batch.length;
      for (const team of batch) {
        try {
          const members = agentDeckTeamRepo.listActiveMembers(team.id);
          let closeTime = team.createdAt;
          let allClosed = members.length > 0;
          for (const member of members) {
            closeTime = Math.max(closeTime, member.joinedAt);
            const session = sessionRepo.get(member.sessionId);
            if (!session || session.lifecycle !== 'closed') {
              allClosed = false;
              break;
            }
            closeTime = Math.max(
              closeTime,
              session.endedAt ?? session.lastEventAt,
            );
          }
          const eligible = members.length === 0
            ? now - team.createdAt >= this.graceMs
            : allClosed && now - closeTime >= this.graceMs;
          if (eligible) candidates.push(team.id);
          else skippedLive += 1;
        } catch {
          scanFailed = true;
          skippedLive += 1;
        }
      }
      if (exhausted) break;
      offset += batch.length;
    }

    logPhase({
      phase: 'candidate-scan',
      candidate,
      changed: 0,
      skippedLive,
      duration: Date.now() - scanStartedAt,
      outcome: scanFailed ? 'error' : 'unchanged',
    });

    const archiveStartedAt = Date.now();
    let changed = 0;
    let archiveFailed = false;
    for (const teamId of candidates) {
      try {
        const team = agentDeckTeamRepo.archive(teamId, { reason: 'scheduler' });
        if (!team) continue;
        changed += 1;
        eventBus.emit('agent-deck-team-updated', team);
      } catch {
        archiveFailed = true;
      }
    }
    logPhase({
      phase: 'archive',
      candidate: candidates.length,
      changed,
      skippedLive: 0,
      duration: Date.now() - archiveStartedAt,
      outcome: archiveFailed ? 'error' : changed > 0 ? 'changed' : 'unchanged',
    });

    return {
      needsCatchUp: !scanFailed && !exhausted,
      // Archived rows disappear from the active result set. Keep the surviving rows
      // from this batch behind the next offset so catch-up neither skips nor rescans them.
      nextOffset: Math.max(0, startOffset + candidate - changed),
    };
  }

  private scheduleCatchUp(offset: number): void {
    if (this.catchUpTimer) return;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      this.runBatch(offset);
    }, this.catchUpDelayMs);
  }

  private clearCatchUp(): void {
    if (!this.catchUpTimer) return;
    clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
  }
}
