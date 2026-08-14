import type { ElectronHostState } from '@hosts/electron';

const MAX_TRACKED_PROFILES = 256;
const MAX_SUPPRESSED_REPEATS = 9_999;
export const REMOTE_TRANSPORT_SUMMARY_INTERVAL_MS = 5 * 60_000;
const EXPECTED_STOP_CODES = new Set(['app-shutdown', 'profile-removed', 'transport-stopped']);

export interface RemoteHostTransportDiagnosticLogger {
  warn(message: string, details: Record<string, unknown>): void;
  info(message: string, details: Record<string, unknown>): void;
}

interface TransportFailureEpisode {
  status: ElectronHostState['status'];
  code: string;
  reason: string;
  authoritativeCoreId: string | null;
  workerGeneration: number | null;
  startedAtMs: number;
  lastEmissionAtMs: number;
  suppressedRepeats: number;
  suppressedRepeatsCapped: boolean;
}

export class RemoteHostTransportDiagnostics {
  private readonly episodes = new Map<string, TransportFailureEpisode>();

  constructor(
    private readonly logger: RemoteHostTransportDiagnosticLogger,
    private readonly now: () => number = Date.now,
  ) {}

  observe(state: ElectronHostState): void {
    try {
      this.observeSafely(state, this.currentTime());
    } catch {
      // Diagnostics must not affect transport state, scope invalidation, or renderer updates.
    }
  }

  private observeSafely(state: ElectronHostState, nowMs: number): void {
    const previous = this.episodes.get(state.profileId);
    const expectedStop = (
      state.status === 'offline' &&
      state.error !== null &&
      EXPECTED_STOP_CODES.has(state.error.code)
    );
    if (!state.error || expectedStop) {
      if (state.status === 'connected' && previous) {
        this.episodes.delete(state.profileId);
        this.logger.info('Remote transport state recovered', {
          ...this.baseDetails(state),
          previousStatus: previous.status,
          previousCode: previous.code,
          degradedDurationMs: Math.max(0, nowMs - previous.startedAtMs),
          suppressedRepeats: previous.suppressedRepeats,
          suppressedRepeatsCapped: previous.suppressedRepeatsCapped,
        });
      } else if (state.status === 'offline') {
        this.episodes.delete(state.profileId);
      }
      return;
    }

    if (previous && this.sameFailure(previous, state)) {
      this.incrementSuppressed(previous);
      this.touch(state.profileId, previous);
      if (nowMs - previous.lastEmissionAtMs < REMOTE_TRANSPORT_SUMMARY_INTERVAL_MS) return;
      this.logger.warn('Remote transport state remains degraded', {
        ...this.baseDetails(state),
        reason: state.error.message,
        transition: 'periodic-summary',
        degradedDurationMs: Math.max(0, nowMs - previous.startedAtMs),
        suppressedRepeats: previous.suppressedRepeats,
        suppressedRepeatsCapped: previous.suppressedRepeatsCapped,
      });
      previous.lastEmissionAtMs = nowMs;
      previous.suppressedRepeats = 0;
      previous.suppressedRepeatsCapped = false;
      return;
    }

    const next: TransportFailureEpisode = {
      status: state.status,
      code: state.error.code,
      reason: state.error.message,
      authoritativeCoreId: state.authoritativeCoreId,
      workerGeneration: state.workerGeneration,
      startedAtMs: previous?.startedAtMs ?? nowMs,
      lastEmissionAtMs: nowMs,
      suppressedRepeats: 0,
      suppressedRepeatsCapped: false,
    };
    this.remember(state.profileId, next);
    this.logger.warn('Remote transport state degraded', {
      ...this.baseDetails(state),
      reason: state.error.message,
      transition: previous ? 'failure-changed' : 'initial',
      previousStatus: previous?.status ?? null,
      previousCode: previous?.code ?? null,
      suppressedPreviousRepeats: previous?.suppressedRepeats ?? 0,
      suppressedPreviousRepeatsCapped: previous?.suppressedRepeatsCapped ?? false,
    });
  }

  private baseDetails(state: ElectronHostState): Record<string, unknown> {
    return {
      event: 'remote-transport-state',
      profileId: state.profileId,
      status: state.status,
      code: state.error?.code ?? null,
      authoritativeCoreId: state.authoritativeCoreId,
      workerGeneration: state.workerGeneration,
    };
  }

  private sameFailure(previous: TransportFailureEpisode, state: ElectronHostState): boolean {
    return (
      previous.status === state.status &&
      previous.code === state.error?.code &&
      previous.reason === state.error?.message &&
      previous.authoritativeCoreId === state.authoritativeCoreId &&
      previous.workerGeneration === state.workerGeneration
    );
  }

  private incrementSuppressed(episode: TransportFailureEpisode): void {
    if (episode.suppressedRepeats < MAX_SUPPRESSED_REPEATS) {
      episode.suppressedRepeats += 1;
    } else {
      episode.suppressedRepeatsCapped = true;
    }
  }

  private remember(profileId: string, episode: TransportFailureEpisode): void {
    if (!this.episodes.has(profileId) && this.episodes.size >= MAX_TRACKED_PROFILES) {
      const oldest = this.episodes.keys().next();
      if (!oldest.done) this.episodes.delete(oldest.value);
    }
    this.touch(profileId, episode);
  }

  private touch(profileId: string, episode: TransportFailureEpisode): void {
    this.episodes.delete(profileId);
    this.episodes.set(profileId, episode);
  }

  private currentTime(): number {
    const value = this.now();
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }
}
