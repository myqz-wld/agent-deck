import type { AppSettings, SummaryRecord } from '@shared/types';
import { summaryRepo } from '@main/store/summary-repo';
import { eventRepo } from '@main/store/event-repo';
import { eventRevisionRepo } from '@main/store/event-revision-repo';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus, type TypedEventBus } from '@main/event-bus';
import type { AgentAdapter } from '@main/adapters/types';
import { localStatsFallback } from './event-formatter';
import { capturePeriodicSummaryEvidence } from './evidence-snapshot';
import { isSummaryProviderCapabilityError } from './provider-capability-error';

export interface SummarizerDiagnosticsPort {
  begin(): number | null;
  forgetSession(sessionId: string): void;
  observeProviderCapabilityFailure(providerKey: string, startedAtMs: number | null): void;
  observeSuccess(sessionId: string, startedAtMs: number | null): void;
  observeTransientFailure(sessionId: string, error: unknown, startedAtMs: number | null): void;
  observeUnexpectedFailure(sessionId: string, startedAtMs: number | null): void;
}

const NOOP_SUMMARIZER_DIAGNOSTICS: SummarizerDiagnosticsPort = {
  begin: () => null,
  forgetSession: () => undefined,
  observeProviderCapabilityFailure: () => undefined,
  observeSuccess: () => undefined,
  observeTransientFailure: () => undefined,
  observeUnexpectedFailure: () => undefined,
};

export type SummarizerSettingKey =
  | 'summaryAdapter'
  | 'summaryEnabled'
  | 'summaryEventCount'
  | 'summaryIntervalMs'
  | 'summaryMaxConcurrent'
  | 'summaryModel'
  | 'summaryRuntimeProvider'
  | 'summaryThinking';

export interface SummarizerDependencies {
  readonly settings: {
    get<K extends SummarizerSettingKey>(key: K): AppSettings[K];
  };
  readonly registry: { get(id: string): AgentAdapter | undefined };
  readonly bus?: Pick<TypedEventBus, 'emit' | 'off' | 'on'>;
  readonly now?: () => number;
  readonly diagnostics?: SummarizerDiagnosticsPort;
  /** Host notification after the summary row is durable. */
  readonly onSummaryAdded?: (summary: SummaryRecord) => void;
}

interface GeneratedSummary {
  content: string;
  sourceEventRevision: number;
  sourceRebuildAfterRevision: number;
  generationSource: SummaryRecord['generationSource'];
}

/**
 * Summarizer 调度：定时扫描所有活跃会话，为达到「时间阈值」或「事件数阈值」
 * 的会话生成一段「会话目前在做什么」的意义层面描述。
 *
 * 优先级：LLM 结构化短摘要 → 最近一条 assistant 文字 → 事件统计兜底。
 */
export class Summarizer {
  private timer: NodeJS.Timeout | null = null;
  private currentIntervalMs = 0;
  private acceptingWork = true;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly operations = new Set<Promise<unknown>>();
  /** Persisted revision cursor cache; null means the session has no summary yet. */
  private latestSummaryBySession = new Map<string, SummaryRecord | null>();
  private inFlight = new Set<string>();
  /** Raw provider failure details for the UI; only a true LLM success clears an entry. */
  private lastErrorBySession = new Map<string, { message: string; ts: number }>();
  /**
   * Permanent provider capability failures open a circuit for this Summarizer's lifetime.
   * Constructing a new Summarizer is the reset boundary.
   */
  private providerCapabilityFailures = new Map<
    string,
    { message: string; ts: number }
  >();
  private readonly diagnostics: SummarizerDiagnosticsPort;
  /** Unsubscribes the session-removal state cleanup. */
  private offSessionRemoved: (() => void) | null = null;
  /** Unsubscribes the session-rename state migration. */
  private offSessionRenamed: (() => void) | null = null;

  constructor(private readonly dependencies: SummarizerDependencies) {
    this.diagnostics = dependencies.diagnostics ?? NOOP_SUMMARIZER_DIAGNOSTICS;
  }

  private get settings(): SummarizerDependencies['settings'] {
    return this.dependencies.settings;
  }

  private get registry(): SummarizerDependencies['registry'] {
    return this.dependencies.registry;
  }

  private get bus(): NonNullable<SummarizerDependencies['bus']> {
    return this.dependencies.bus ?? eventBus;
  }

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  private publishSummary(summary: SummaryRecord): void {
    this.bus.emit('summary-added', summary);
    this.dependencies.onSummaryAdded?.(summary);
  }

  start(): void {
    if (this.timer || this.stopping) return;
    this.acceptingWork = true;
    this.scheduleTimer();
    // Session deletion drops every per-session cache and diagnostic owner.
    if (!this.offSessionRemoved) {
      const handler = (sid: string): void => {
        this.latestSummaryBySession.delete(sid);
        this.lastErrorBySession.delete(sid);
        this.diagnostics.forgetSession(sid);
      };
      this.bus.on('session-removed', handler);
      this.offSessionRemoved = () => this.bus.off('session-removed', handler);
    }
    // Rename transfers the persisted cursor and raw UI error to the new identity. Diagnostic
    // transition state resets at that identity boundary.
    if (!this.offSessionRenamed) {
      const renameHandler = (payload: { from: string; to: string }): void => {
        this.diagnostics.forgetSession(payload.from);
        if (this.latestSummaryBySession.has(payload.from)) {
          this.latestSummaryBySession.set(
            payload.to,
            this.latestSummaryBySession.get(payload.from) ?? null,
          );
          this.latestSummaryBySession.delete(payload.from);
        }
        const errInfo = this.lastErrorBySession.get(payload.from);
        if (errInfo !== undefined) {
          this.lastErrorBySession.set(payload.to, errInfo);
          this.lastErrorBySession.delete(payload.from);
        }
      };
      this.bus.on('session-renamed', renameHandler);
      this.offSessionRenamed = () => this.bus.off('session-renamed', renameHandler);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.acceptingWork = false;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.currentIntervalMs = 0;
    }
    if (this.offSessionRemoved) {
      this.offSessionRemoved();
      this.offSessionRemoved = null;
    }
    if (this.offSessionRenamed) {
      this.offSessionRenamed();
      this.offSessionRenamed = null;
    }
    this.stopPromise = this.drainOperations().finally(() => {
      this.inFlight.clear();
      this.stopping = false;
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  /** Apply an interval-setting change immediately while the scheduler is running. */
  setIntervalMs(ms: number): void {
    if (!this.timer) return;
    const next = Math.max(30_000, Math.floor(ms / 2));
    if (next === this.currentIntervalMs) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.scanAll(), next);
    this.currentIntervalMs = next;
  }

  private scheduleTimer(): void {
    const interval = this.settings.get('summaryIntervalMs');
    const period = Math.max(30_000, Math.floor(interval / 2));
    this.timer = setInterval(() => void this.scanAll(), period);
    this.currentIntervalMs = period;
  }

  async scanAll(): Promise<void> {
    if (!this.acceptingWork || this.stopping) return;
    if (this.settings.get('summaryEnabled') === false) return;
    const sessions = sessionRepo.listActiveAndDormant(50);
    const intervalMs = this.settings.get('summaryIntervalMs');
    const eventCount = this.settings.get('summaryEventCount');
    // Sessions are already ordered by recent activity; excess eligible work waits for the next
    // scan when the bounded provider concurrency is full.
    const maxConcurrent = Math.max(1, this.settings.get('summaryMaxConcurrent'));
    const now = this.now();
    for (const s of sessions) {
      if (this.inFlight.size >= maxConcurrent) break;
      if (this.inFlight.has(s.id)) continue;
      const previous = this.latestSummary(s.id);
      const revisionState = eventRevisionRepo.state(s.id);
      if (!revisionState) continue;
      const revisionCursorValid =
        previous !== null &&
        previous.sourceRebuildAfterRevision === revisionState.rebuildAfterRevision &&
        previous.sourceEventRevision >= revisionState.rebuildAfterRevision &&
        previous.sourceEventRevision <= revisionState.revision;
      const cursorRequiresRebuild = previous !== null && !revisionCursorValid;
      const lastTs = previous?.ts ?? s.startedAt;
      const eventsSince = previous === null
        ? revisionState.revision
        : revisionCursorValid
          ? revisionState.revision - previous.sourceEventRevision
          : 1;
      // A quiet session never repeats an identical summary.
      if (eventsSince === 0) continue;
      const shouldByTime = now - lastTs >= intervalMs;
      const shouldByCount = eventsSince >= eventCount;
      if (!shouldByTime && !shouldByCount && !cursorRequiresRebuild) continue;

      this.inFlight.add(s.id);
      // Follow renames so concurrency ownership and final cleanup use the same live identity.
      let currentSid = s.id;
      const renameInflightHandler = (payload: { from: string; to: string }): void => {
        if (payload.from === currentSid) {
          this.inFlight.delete(currentSid);
          this.inFlight.add(payload.to);
          currentSid = payload.to;
        }
      };
      this.bus.on('session-renamed', renameInflightHandler);
      const operation = this.summarize(s.id, previous)
        .then((generated) => {
          if (!generated) return;
          // Fence stale work before persistence; the renamed identity is evaluated on a later scan.
          if (!sessionRepo.get(s.id)) {
            this.diagnostics.forgetSession(s.id);
            return;
          }
          const rec = summaryRepo.insert({
            sessionId: s.id,
            content: generated.content,
            trigger: shouldByCount || cursorRequiresRebuild ? 'event-count' : 'time',
            ts: this.now(),
            sourceEventRevision: generated.sourceEventRevision,
            sourceRebuildAfterRevision: generated.sourceRebuildAfterRevision,
            generationSource: generated.generationSource,
          });
          this.publishSummary(rec);
          this.latestSummaryBySession.set(s.id, rec);
        })
        .catch((err) => {
          // Never recreate raw UI state for an identity removed during in-flight work.
          if (!sessionRepo.get(s.id)) return;
          // Unexpected failures still retain their raw detail for the UI.
          this.lastErrorBySession.set(s.id, {
            message: (err as Error)?.message ?? String(err),
            ts: this.now(),
          });
          this.diagnostics.observeUnexpectedFailure(s.id, null);
        })
        .finally(() => {
          // Release the final renamed key and its operation-scoped listener.
          this.inFlight.delete(currentSid);
          this.bus.off('session-renamed', renameInflightHandler);
        });
      this.track(operation);
    }
  }

  private latestSummary(sessionId: string): SummaryRecord | null {
    if (!this.latestSummaryBySession.has(sessionId)) {
      this.latestSummaryBySession.set(sessionId, summaryRepo.latestForSession(sessionId));
    }
    return this.latestSummaryBySession.get(sessionId) ?? null;
  }

  /** 拉取最近一次失败诊断（by sessionId），UI 设置面板用。空 Map 表示没有任何会话失败过。 */
  getLastErrors(): Record<string, { message: string; ts: number }> {
    const out: Record<string, { message: string; ts: number }> = {};
    for (const [sid, info] of this.lastErrorBySession.entries()) {
      out[sid] = info;
    }
    return out;
  }

  /** Manual summaries share the per-session in-flight guard with scheduled work. */
  summarizeNow(sessionId: string): Promise<SummaryRecord | null> {
    if (!this.acceptingWork || this.stopping || this.inFlight.has(sessionId)) {
      return Promise.resolve(null);
    }
    this.inFlight.add(sessionId);
    return this.track(this.summarizeNowOwned(sessionId));
  }

  private async summarizeNowOwned(sessionId: string): Promise<SummaryRecord | null> {
    try {
      const generated = await this.summarize(sessionId, this.latestSummary(sessionId));
      if (!generated) return null;
      try {
        const rec = summaryRepo.insert({
          sessionId,
          content: generated.content,
          trigger: 'manual',
          ts: this.now(),
          sourceEventRevision: generated.sourceEventRevision,
          sourceRebuildAfterRevision: generated.sourceRebuildAfterRevision,
          generationSource: generated.generationSource,
        });
        this.publishSummary(rec);
        this.latestSummaryBySession.set(sessionId, rec);
        return rec;
      } catch (error) {
        // Observe only while this remains the current identity, without shadowing the original
        // persistence error if the staleness check itself fails.
        let currentIdentity = true;
        try {
          currentIdentity = sessionRepo.get(sessionId) !== null;
        } catch {
          // The original error remains authoritative.
        }
        if (currentIdentity) {
          this.diagnostics.observeUnexpectedFailure(sessionId, null);
        } else {
          this.diagnostics.forgetSession(sessionId);
        }
        throw error;
      }
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    let tracked: Promise<T>;
    tracked = operation.finally(() => {
      this.operations.delete(tracked);
    });
    this.operations.add(tracked);
    return tracked;
  }

  private async drainOperations(): Promise<void> {
    while (this.operations.size > 0) {
      await Promise.allSettled([...this.operations]);
    }
  }

  private async summarize(
    sessionId: string,
    previous: SummaryRecord | null,
  ): Promise<GeneratedSummary | null> {
    if (this.settings.get('summaryEnabled') === false) return null;
    const session = sessionRepo.get(sessionId);
    if (!session) return null;
    const evidence = capturePeriodicSummaryEvidence(sessionId, previous);
    if (!evidence) return null;
    const events = evidence.events;
    if (events.length === 0 && !evidence.promptContext) return null;

    // Summary runtime selection is independent from the summarized session's runtime.
    const adapterId = this.settings.get('summaryAdapter');
    const runtimeProvider =
      this.settings.get('summaryRuntimeProvider').trim() || undefined;
    const runtimeKey = `${adapterId}:${runtimeProvider ?? ''}`;
    const blockedProvider = this.providerCapabilityFailures.get(runtimeKey);
    if (!blockedProvider) {
      const diagnosticStartedAt = this.diagnostics.begin();
      try {
        const adapter = this.registry.get(adapterId);
        let llm: string | null = null;
        if (adapter?.summariseEvents) {
          llm = await adapter.summariseEvents(
            session.cwd,
            events,
            evidence.promptContext,
            {
              provider: runtimeProvider,
              model: this.settings.get('summaryModel').trim() || undefined,
              thinking: this.settings.get('summaryThinking'),
            },
          );
        }
        if (llm) {
          // Only true LLM success clears a raw UI error; fallback success leaves it visible.
          this.lastErrorBySession.delete(sessionId);
          try {
            if (sessionRepo.get(sessionId)) {
              this.diagnostics.observeSuccess(sessionId, diagnosticStartedAt);
            }
          } catch {
            // A diagnostic staleness check cannot change a successful summary result.
          }
          return {
            content: llm,
            sourceEventRevision: evidence.sourceEventRevision,
            sourceRebuildAfterRevision: evidence.rebuildAfterRevision,
            generationSource: 'llm',
          };
        }
      } catch (err) {
        // Capability errors open the provider circuit. Transient raw UI errors remain
        // session-scoped and are discarded when their identity is stale.
        if (isSummaryProviderCapabilityError(err)) {
          if (!this.providerCapabilityFailures.has(runtimeKey)) {
            this.providerCapabilityFailures.set(runtimeKey, {
              message: err.message,
              ts: this.now(),
            });
          }
          this.diagnostics.observeProviderCapabilityFailure(
            runtimeKey,
            diagnosticStartedAt,
          );
        } else if (!sessionRepo.get(sessionId)) {
          this.diagnostics.forgetSession(sessionId);
        } else {
          this.lastErrorBySession.set(sessionId, {
            message: (err as Error)?.message ?? String(err),
            ts: this.now(),
          });
          this.diagnostics.observeTransientFailure(
            sessionId,
            err,
            diagnosticStartedAt,
          );
        }
      }
    }

    // Prefer a recent assistant message outside the bounded evidence window.
    const previousRevisionValid =
      previous !== null &&
      previous.sourceRebuildAfterRevision === evidence.rebuildAfterRevision &&
      previous.sourceEventRevision >= evidence.rebuildAfterRevision &&
      previous.sourceEventRevision <= evidence.sourceEventRevision;
    const lastMsg = previousRevisionValid
        ? eventRepo.findLatestAssistantMessageAfterRevision(
            sessionId,
            previous.sourceEventRevision,
            evidence.sourceEventRevision,
          )
        : eventRepo.findLatestAssistantMessageAtOrBeforeRevision(
            sessionId,
            evidence.sourceEventRevision,
          );
    if (lastMsg) {
      return {
        content: lastMsg.text.replace(/\s+/g, ' ').trim().slice(0, 400),
        sourceEventRevision: evidence.sourceEventRevision,
        sourceRebuildAfterRevision: evidence.rebuildAfterRevision,
        generationSource: 'assistant-fallback',
      };
    }

    // The final fallback is a bounded event-kind summary.
    return {
      content: localStatsFallback(events),
      sourceEventRevision: evidence.sourceEventRevision,
      sourceRebuildAfterRevision: evidence.rebuildAfterRevision,
      generationSource: 'stats-fallback',
    };
  }
}
