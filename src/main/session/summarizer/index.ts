import type { SummaryRecord } from '@shared/types';
import { summaryRepo } from '@main/store/summary-repo';
import { eventRepo } from '@main/store/event-repo';
import { eventRevisionRepo } from '@main/store/event-revision-repo';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { settingsStore } from '@main/store/settings-store';
import { adapterRegistry } from '@main/adapters/registry';
import { localStatsFallback } from './event-formatter';
import { capturePeriodicSummaryEvidence } from './evidence-snapshot';
import { isSummaryProviderCapabilityError } from './provider-capability-error';
import { SummarizerDiagnosticCoordinator } from './logging';

interface GeneratedSummary {
  content: string;
  sourceEventRevision: number;
  sourceRebuildAfterRevision: number;
  generationSource: SummaryRecord['generationSource'];
}

// Keep the formatter facade stable for periodic-summary callers.
export { formatEventsForPrompt } from './event-formatter';

/**
 * Summarizer 调度：定时扫描所有活跃会话，为达到「时间阈值」或「事件数阈值」
 * 的会话生成一段「会话目前在做什么」的意义层面描述。
 *
 * 优先级：LLM 结构化短摘要 → 最近一条 assistant 文字 → 事件统计兜底。
 */
export class Summarizer {
  private timer: NodeJS.Timeout | null = null;
  private currentIntervalMs = 0;
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
  private readonly diagnostics = new SummarizerDiagnosticCoordinator();
  /** Unsubscribes the session-removal state cleanup. */
  private offSessionRemoved: (() => void) | null = null;
  /** Unsubscribes the session-rename state migration. */
  private offSessionRenamed: (() => void) | null = null;

  start(): void {
    if (this.timer) return;
    this.scheduleTimer();
    // Session deletion drops every per-session cache and diagnostic owner.
    if (!this.offSessionRemoved) {
      const handler = (sid: string): void => {
        this.latestSummaryBySession.delete(sid);
        this.lastErrorBySession.delete(sid);
        this.diagnostics.forgetSession(sid);
      };
      eventBus.on('session-removed', handler);
      this.offSessionRemoved = () => eventBus.off('session-removed', handler);
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
      eventBus.on('session-renamed', renameHandler);
      this.offSessionRenamed = () => eventBus.off('session-renamed', renameHandler);
    }
  }

  stop(): void {
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
    const interval = settingsStore.get('summaryIntervalMs');
    const period = Math.max(30_000, Math.floor(interval / 2));
    this.timer = setInterval(() => void this.scanAll(), period);
    this.currentIntervalMs = period;
  }

  async scanAll(): Promise<void> {
    if (settingsStore.get('summaryEnabled') === false) return;
    const sessions = sessionRepo.listActiveAndDormant(50);
    const intervalMs = settingsStore.get('summaryIntervalMs');
    const eventCount = settingsStore.get('summaryEventCount');
    // Sessions are already ordered by recent activity; excess eligible work waits for the next
    // scan when the bounded provider concurrency is full.
    const maxConcurrent = Math.max(1, settingsStore.get('summaryMaxConcurrent'));
    const now = Date.now();
    for (const s of sessions) {
      if (this.inFlight.size >= maxConcurrent) break;
      if (this.inFlight.has(s.id)) continue;
      const previous = this.latestSummary(s.id);
      const revisionState = eventRevisionRepo.state(s.id);
      if (!revisionState) continue;
      const previousRevision = previous?.sourceEventRevision ?? null;
      const previousRebuildEpoch = previous?.sourceRebuildAfterRevision ?? null;
      const revisionCursorValid =
        previousRevision !== null &&
        previousRebuildEpoch === revisionState.rebuildAfterRevision &&
        previousRevision >= revisionState.rebuildAfterRevision &&
        previousRevision <= revisionState.revision;
      const cursorRequiresRebuild = previousRevision !== null && !revisionCursorValid;
      const lastTs = previous?.ts ?? s.startedAt;
      const legacyEventsSince = (): number => eventRepo.countForSession(s.id, lastTs);
      const eventsSince = revisionCursorValid
        ? revisionState.revision - previousRevision
        : previousRevision !== null
          // A destructive event rebuild/rename invalidates the old revision cursor. Force one
          // fresh bounded snapshot even when all rebuilt event timestamps predate the summary.
          ? Math.max(1, legacyEventsSince())
          : legacyEventsSince();
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
      eventBus.on('session-renamed', renameInflightHandler);
      void this.summarize(s.id, previous)
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
            ts: Date.now(),
            sourceEventRevision: generated.sourceEventRevision,
            sourceRebuildAfterRevision: generated.sourceRebuildAfterRevision,
            generationSource: generated.generationSource,
          });
          eventBus.emit('summary-added', rec);
          this.latestSummaryBySession.set(s.id, rec);
        })
        .catch((err) => {
          // Never recreate raw UI state for an identity removed during in-flight work.
          if (!sessionRepo.get(s.id)) return;
          // Unexpected failures still retain their raw detail for the UI.
          this.lastErrorBySession.set(s.id, {
            message: (err as Error)?.message ?? String(err),
            ts: Date.now(),
          });
          this.diagnostics.observeUnexpectedFailure(s.id, null);
        })
        .finally(() => {
          // Release the final renamed key and its operation-scoped listener.
          this.inFlight.delete(currentSid);
          eventBus.off('session-renamed', renameInflightHandler);
        });
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
  async summarizeNow(sessionId: string): Promise<SummaryRecord | null> {
    if (this.inFlight.has(sessionId)) return null;
    this.inFlight.add(sessionId);
    try {
      const generated = await this.summarize(sessionId, this.latestSummary(sessionId));
      if (!generated) return null;
      try {
        const rec = summaryRepo.insert({
          sessionId,
          content: generated.content,
          trigger: 'manual',
          ts: Date.now(),
          sourceEventRevision: generated.sourceEventRevision,
          sourceRebuildAfterRevision: generated.sourceRebuildAfterRevision,
          generationSource: generated.generationSource,
        });
        eventBus.emit('summary-added', rec);
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

  private async summarize(
    sessionId: string,
    previous: SummaryRecord | null,
  ): Promise<GeneratedSummary | null> {
    if (settingsStore.get('summaryEnabled') === false) return null;
    const session = sessionRepo.get(sessionId);
    if (!session) return null;
    const evidence = capturePeriodicSummaryEvidence(sessionId, previous);
    if (!evidence) return null;
    const events = evidence.events;
    if (events.length === 0 && !evidence.promptContext) return null;

    // Summary runtime selection is independent from the summarized session's runtime.
    const adapterId = settingsStore.get('summaryAdapter');
    const runtimeProvider =
      settingsStore.get('summaryRuntimeProvider').trim() || undefined;
    const runtimeKey = `${adapterId}:${runtimeProvider ?? ''}`;
    const blockedProvider = this.providerCapabilityFailures.get(runtimeKey);
    if (!blockedProvider) {
      const diagnosticStartedAt = this.diagnostics.begin();
      try {
        const adapter = adapterRegistry.get(adapterId);
        let llm: string | null = null;
        if (adapter?.summariseEvents) {
          llm = await adapter.summariseEvents(
            session.cwd,
            events,
            evidence.promptContext,
            {
              provider: runtimeProvider,
              model: settingsStore.get('summaryModel').trim() || undefined,
              thinking: settingsStore.get('summaryThinking'),
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
              ts: Date.now(),
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
            ts: Date.now(),
          });
          this.diagnostics.observeTransientFailure(
            sessionId,
            err,
            diagnosticStartedAt,
          );
        }
      }
    }

    // Prefer a recent assistant message outside the bounded evidence window. Use revision bounds
    // when available and a timestamp lower bound only for summaries without a revision cursor.
    const previousRevisionValid =
      previous?.sourceEventRevision != null &&
      previous.sourceRebuildAfterRevision === evidence.rebuildAfterRevision &&
      previous.sourceEventRevision >= evidence.rebuildAfterRevision &&
      previous.sourceEventRevision <= evidence.sourceEventRevision;
    const lastMsg = previousRevisionValid
        ? eventRepo.findLatestAssistantMessageAfterRevision(
            sessionId,
            previous!.sourceEventRevision!,
            evidence.sourceEventRevision,
          )
        : eventRepo.findLatestAssistantMessageAtOrBeforeRevision(
            sessionId,
            evidence.sourceEventRevision,
            previous?.sourceEventRevision == null
              ? previous?.ts ?? session.startedAt
              : undefined,
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

export const summarizer = new Summarizer();
