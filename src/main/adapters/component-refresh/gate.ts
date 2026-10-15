import type { SessionComponentRefreshStatus, ComponentRefreshResult, ComponentDiscoveryEvidence } from '@shared/session-component-refresh';

export interface RefreshApplication {
  results: ComponentRefreshResult[];
  discovery?: ComponentDiscoveryEvidence;
}
export type ApplyRefresh = (assertCurrent: () => void) => Promise<RefreshApplication>;

/** A provider-owned input reservation, separate from model work and worktree transitions. */
export class ComponentRefreshGate {
  private pending: ApplyRefresh | null = null;
  private applying: Promise<void> | null = null;
  private invalidated = false;
  private revision = 0;
  private checking: Promise<void> | null = null;
  private checkController: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private status: SessionComponentRefreshStatus = { phase: 'idle', revision: 0, results: [] };
  constructor(private readonly host: {
    current(): boolean;
    idle(): boolean;
    idleCheck?(signal: AbortSignal): Promise<boolean>;
    wake(): void;
    emit(status: SessionComponentRefreshStatus): void;
  }) {}
  get blocked(): boolean { return this.pending !== null || this.applying !== null; }
  get reusable(): boolean { return !this.invalidated && this.host.current(); }
  assertNotApplying(): void {
    if (this.applying) throw new Error('扩展刷新正在应用，请完成后再切换会话运行设置。');
  }
  snapshot(): SessionComponentRefreshStatus { return { ...this.status, results: [...this.status.results] }; }
  request(apply: ApplyRefresh): SessionComponentRefreshStatus {
    this.assertCurrent();
    this.pending = apply; // Latest explicit request wins, including during an existing application.
    this.status = { phase: this.applying ? 'applying' : 'queued', revision: ++this.revision, results: [] };
    this.publish();
    void this.checkpoint();
    return this.snapshot();
  }
  cancel(): SessionComponentRefreshStatus {
    if (this.applying) {
      if (this.pending) {
        this.pending = null;
        this.status = { ...this.status, detail: '已撤销后续排队的扩展刷新；正在应用的刷新会继续完成。' };
      }
      this.publish(); return this.snapshot();
    }
    if (this.pending) {
      this.pending = null;
      this.status = { ...this.status, phase: 'cancelled', results: [] };
      this.stopCheck(); this.publish(); this.host.wake();
    } else {
      this.status = { phase: 'idle', revision: this.revision, results: [] }; this.publish();
    }
    return this.snapshot();
  }
  invalidate(): void {
    const wasBlocked = this.blocked;
    this.invalidated = true; this.pending = null; this.stopCheck();
    this.status = { ...this.status, phase: 'cancelled', results: [], detail: '会话运行环境已变化，刷新不会转移到其他会话。' };
    if (wasBlocked) { this.publish(); this.host.wake(); }
  }
  private assertCurrent = (): void => {
    if (this.invalidated || !this.host.current()) throw new Error('刷新目标的运行环境已变化。');
  };
  async checkpoint(): Promise<void> {
    if (this.applying) return this.applying;
    if (!this.pending) return;
    if (this.invalidated || !this.host.current()) { this.invalidate(); return; }
    if (!this.host.idle()) return;
    if (this.checking) return this.checking;
    if (this.retry) return;
    if (this.host.idleCheck) {
      const controller = new AbortController(); this.checkController = controller;
      this.checking = this.host.idleCheck(controller.signal).then(ready => {
        if (!this.pending || controller.signal.aborted) return;
        this.assertCurrent();
        if (ready && this.host.idle()) return this.startApplying();
        this.retry = setTimeout(() => { this.retry = null; void this.checkpoint(); }, 1000);
        this.retry.unref?.();
        return;
      }).catch(() => {
        if (!this.pending || controller.signal.aborted) return;
        this.pending = null;
        this.status = { phase: 'failed', revision: this.revision, results: [], detail: '无法确认原生后台任务已结束，未应用刷新。请重试或新建会话。' };
        this.publish(); this.host.wake();
      }).finally(() => {
        this.checking = null; this.checkController = null;
        if (this.pending && !this.retry && !this.applying && this.host.current()) void this.checkpoint();
      });
      return this.checking;
    }
    return this.startApplying();
  }
  private startApplying(): Promise<void> {
    const apply = this.pending; this.pending = null;
    const revision = this.revision;
    this.status = { phase: 'applying', revision, results: [] };
    // Install the reservation before invoking any native asynchronous code.
    this.applying = Promise.resolve().then(async () => {
      this.assertCurrent(); this.publish();
      const result = await apply!(this.assertCurrent);
      this.assertCurrent();
      const outcomes = result.results.map(r => r.outcome);
      const phase = outcomes.every(o => o === 'failed') ? 'failed'
        : outcomes.some(o => !['updated', 'unchanged'].includes(o)) ? 'partial' : 'completed';
      this.status = { phase, revision, ...result };
      this.publish();
    }).catch(() => {
      this.status = { phase: this.invalidated || !this.host.current() ? 'cancelled' : 'failed',
        revision, results: [], detail: '刷新未确认完成；请检查会话状态后重试。' };
      this.publish();
    }).finally(() => {
      this.applying = null;
      if (this.pending && !this.invalidated) {
        this.status = { phase: 'queued', revision: this.revision, results: [] };
        void this.checkpoint();
      }
      this.host.wake();
    });
    return this.applying;
  }
  private stopCheck(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null; this.checkController?.abort();
  }
  private publish(): void {
    if (!this.host.current()) return; // Never resurrect a deleted or replaced runtime through feedback.
    try { this.host.emit(this.snapshot()); } catch { /* Feedback cannot change native operation ownership. */ }
  }
}
