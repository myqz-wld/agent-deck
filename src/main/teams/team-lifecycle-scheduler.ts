import { sessionRepo } from '@main/store/session-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';

const logger = log.scope('team-lifecycle-scheduler');
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_GRACE_MS = 30 * 60_000;
const PAGE_SIZE = 200;
const SLOW_BATCH_MS = 50;

interface SchedulerOptions {
  intervalMs?: number;
  graceMs?: number;
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
  private intervalMs: number;
  private graceMs: number;

  constructor(opts: SchedulerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
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
  }

  scan(): void {
    const startedAt = Date.now();
    try {
      this.runScan();
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

  private runScan(): void {
    const now = Date.now();
    const scanStartedAt = Date.now();
    const candidates: string[] = [];
    let candidate = 0;
    let skippedLive = 0;
    let scanFailed = false;
    let offset = 0;

    while (true) {
      let batch;
      try {
        batch = agentDeckTeamRepo.list({
          activeOnly: true,
          limit: PAGE_SIZE,
          offset,
        });
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
      if (batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
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
  }
}

let activeScheduler: TeamLifecycleScheduler | null = null;

export function setTeamLifecycleScheduler(scheduler: TeamLifecycleScheduler | null): void {
  activeScheduler = scheduler;
}

export function getTeamLifecycleScheduler(): TeamLifecycleScheduler | null {
  return activeScheduler;
}
