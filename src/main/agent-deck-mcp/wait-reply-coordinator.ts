/**
 * Agent Deck MCP `wait_reply` coordinator（B'0 ADR §3.3 + §3.3.4 修订）。
 *
 * 三档 until 语义 + 并发同 session 共享 promise + caller 各自 since_ts filter +
 * 历史 backfill 合并。
 *
 * 设计要点（reviewer 双对抗 HIGH-2 修法）：
 *
 * 1. **promise key** = `${sessionId}:${until}:${idleQuietMs}`（不含 timeout_ms /
 *    since_ts）。同 key 复用一个 promise，避免每个 caller 起一个 listener。
 *
 * 2. **baseline_ts** = promise 首次创建瞬间 `Date.now()`，由 coordinator 内部记录，
 *    promise resolve 时一并返回。collected events 数组只含 `event.ts >= baseline_ts`
 *    的实时事件。
 *
 * 3. **caller 各自 since_ts filter（在 wait_reply handler 层）**：
 *    - sinceTs = args.since_ts ?? handlerEntryTs
 *    - 若 sinceTs < baseline_ts：调 eventRepo.listForSessionRange(sid, sinceTs, baseline_ts)
 *      拿历史 backfill 段
 *    - 合并 backfill + collected，按 ts ASC 输出
 *    - collected 用 e.ts > sinceTs 二次 filter（避免 sinceTs > baseline_ts 时 caller
 *      仍漏过滤旧事件）
 *
 * 4. **超时**：caller 一侧 `Promise.race(coordinator.promise, sleep(timeout_ms))`；
 *    超时返回 partial events + timed_out=true。**不**影响 session 自身（不 abort）。
 *
 * 5. **中断**：caller 通过 SDK abortSignal 中断时，handler 返回 events + aborted=true。
 *    coordinator 不感知 abort（continue 收集给其他 caller）。
 *
 * 6. **resolve 后清 key**：promise resolve 后 coordinator 删除 entry 并解绑 listener，
 *    下一个 wait_reply 重建新 promise，从下一波事件开始。
 *
 * 7. **session-removed 防护**：被监听 session 被删 / closed 时强制 resolve（events
 *    + reason='session-closed'），不让 caller 卡死。
 */

import { eventBus } from '@main/event-bus';
import type { AgentEvent, SessionRecord } from '@shared/types';

export type WaitReplyUntil = 'first_message' | 'turn_complete' | 'idle';

/** 投影后给 MCP client 的精简事件（剥离 source / hookOrigin 等内部字段）。 */
export interface EventProjection {
  kind: AgentEvent['kind'];
  ts: number;
  /** assistant message kind 才有的文字摘要 */
  text?: string;
  /** 其他 kind 的简短描述（tool-use-start: 工具名；finished: subtype；等） */
  summary?: string;
}

export interface WaitReplyResult {
  baselineTs: number;
  events: EventProjection[];
  /**
   * resolve 触发原因：
   * - 'first-message' / 'turn-complete' / 'idle'：until 条件满足
   * - 'session-closed'：session 被 close / delete 时强制 resolve
   */
  reason: 'first-message' | 'turn-complete' | 'idle' | 'session-closed';
}

interface PromiseRecord {
  promise: Promise<WaitReplyResult>;
  resolve: (value: WaitReplyResult) => void;
  baselineTs: number;
  collected: EventProjection[];
  unsubscribeAgent: () => void;
  unsubscribeRemove: () => void;
  /** R3.E5 / ADR §4.8 修法：监听 session-upserted.lifecycle='closed'，
   *  让 sessionManager.close / markClosed / setLifecycle(closed) 都能解锁 wait_reply。 */
  unsubscribeUpsert: () => void;
  /** idle 模式：每收一个 event reset 一次定时器 */
  idleTimer: NodeJS.Timeout | null;
  idleQuietMs: number;
  until: WaitReplyUntil;
}

function projectEvent(e: AgentEvent): EventProjection {
  const proj: EventProjection = {
    kind: e.kind,
    ts: e.ts,
  };
  // message kind：拿 payload.text 作为投影
  if (e.kind === 'message') {
    const payload = e.payload as { text?: unknown } | null | undefined;
    if (payload && typeof payload.text === 'string') {
      proj.text = payload.text;
    }
  } else if (e.kind === 'thinking') {
    const payload = e.payload as { text?: unknown } | null | undefined;
    if (payload && typeof payload.text === 'string') {
      proj.summary = payload.text.slice(0, 200);
    }
  } else if (e.kind === 'tool-use-start' || e.kind === 'tool-use-end') {
    const payload = e.payload as { toolName?: unknown } | null | undefined;
    if (payload && typeof payload.toolName === 'string') {
      proj.summary = payload.toolName;
    }
  } else if (e.kind === 'finished') {
    const payload = e.payload as { subtype?: unknown } | null | undefined;
    if (payload && typeof payload.subtype === 'string') {
      proj.summary = payload.subtype;
    }
  }
  return proj;
}

/**
 * 判断当前事件是否满足某个 until 模式的「立即返回」条件（idle 不在此 —— idle 是
 * 「N 秒静默」timer 触发，不靠单个事件）。
 */
function eventSatisfies(until: WaitReplyUntil, e: AgentEvent): boolean {
  if (until === 'first_message') return e.kind === 'message';
  if (until === 'turn_complete') {
    return e.kind === 'finished' || e.kind === 'waiting-for-user';
  }
  return false; // idle 走 timer
}

export class WaitReplyCoordinator {
  private active = new Map<string, PromiseRecord>(); // key → record

  private keyFor(sid: string, until: WaitReplyUntil, idleQuietMs: number): string {
    return `${sid}:${until}:${idleQuietMs}`;
  }

  /**
   * 等待 sessionId 下一波事件直到 until 条件 / session 被 close。
   * 同 (sid, until, idleQuietMs) 多个 caller 共享同一 promise。
   * **不**返回 backfill 段 —— backfill 由 caller 在 wait_reply handler 内自己拉。
   */
  waitFor(sessionId: string, until: WaitReplyUntil, idleQuietMs: number): Promise<WaitReplyResult> {
    const key = this.keyFor(sessionId, until, idleQuietMs);
    const existing = this.active.get(key);
    if (existing) return existing.promise;

    const baselineTs = Date.now();
    let resolveFn!: (v: WaitReplyResult) => void;
    const promise = new Promise<WaitReplyResult>((res) => {
      resolveFn = res;
    });

    const collected: EventProjection[] = [];

    const finish = (reason: WaitReplyResult['reason']) => {
      // 清掉 listener / timer / map entry，确保只 resolve 一次
      const rec = this.active.get(key);
      if (!rec) return;
      this.active.delete(key);
      rec.unsubscribeAgent();
      rec.unsubscribeRemove();
      rec.unsubscribeUpsert();
      if (rec.idleTimer) {
        clearTimeout(rec.idleTimer);
        rec.idleTimer = null;
      }
      rec.resolve({
        baselineTs: rec.baselineTs,
        events: rec.collected.slice(),
        reason,
      });
    };

    const onAgentEvent = (e: AgentEvent) => {
      if (e.sessionId !== sessionId) return;
      // 只收 baseline_ts 之后的事件（防御 race：listener 注册前老事件不应到达）
      if (e.ts < baselineTs) return;
      collected.push(projectEvent(e));

      if (until === 'first_message' && eventSatisfies('first_message', e)) {
        finish('first-message');
        return;
      }
      if (until === 'turn_complete' && eventSatisfies('turn_complete', e)) {
        finish('turn-complete');
        return;
      }
      if (until === 'idle') {
        // 重置 idle timer：N 秒内无新事件 → finish('idle')
        const rec = this.active.get(key);
        if (rec) {
          if (rec.idleTimer) clearTimeout(rec.idleTimer);
          rec.idleTimer = setTimeout(() => finish('idle'), idleQuietMs);
        }
      }
    };

    const onSessionRemoved = (removedSid: string) => {
      if (removedSid !== sessionId) return;
      finish('session-closed');
    };

    // R3.E5 / ADR §4.8 修法：sessionManager.close / markClosed / setLifecycle(closed)
    // 都仅 emit `session-upserted`，**不**触发 `session-removed`。caller 用 until='turn_complete'
    // 时 close 流程不必然 emit `finished` / `waiting-for-user` / `message`，会卡到 timeout。
    // 这里同步监听 session-upserted lifecycle 切到 closed 立即解锁 wait_reply。
    const onSessionUpserted = (rec: SessionRecord) => {
      if (rec.id !== sessionId) return;
      if (rec.lifecycle === 'closed') finish('session-closed');
    };

    const unsubscribeAgent = eventBus.on('agent-event', onAgentEvent);
    const unsubscribeRemove = eventBus.on('session-removed', onSessionRemoved);
    const unsubscribeUpsert = eventBus.on('session-upserted', onSessionUpserted);

    const record: PromiseRecord = {
      promise,
      resolve: resolveFn,
      baselineTs,
      collected,
      unsubscribeAgent,
      unsubscribeRemove,
      unsubscribeUpsert,
      idleTimer: until === 'idle' ? setTimeout(() => finish('idle'), idleQuietMs) : null,
      idleQuietMs,
      until,
    };
    this.active.set(key, record);

    return promise;
  }

  /** 测试 / debug 用：当前 active key 数量 */
  get activeCount(): number {
    return this.active.size;
  }

  /** 测试 / debug 用：检查某 key 是否还在 active map（未 resolve） */
  hasActive(sessionId: string, until: WaitReplyUntil, idleQuietMs: number): boolean {
    return this.active.has(this.keyFor(sessionId, until, idleQuietMs));
  }

  /**
   * 应用关闭时清理：强制 resolve 所有 active promise（reason='session-closed' 复用
   * 同语义），让被卡住的 caller 退出。
   */
  shutdownAll(): void {
    for (const [, rec] of this.active.entries()) {
      rec.unsubscribeAgent();
      rec.unsubscribeRemove();
      rec.unsubscribeUpsert();
      if (rec.idleTimer) clearTimeout(rec.idleTimer);
      rec.resolve({
        baselineTs: rec.baselineTs,
        events: rec.collected.slice(),
        reason: 'session-closed',
      });
    }
    this.active.clear();
  }
}

export const waitReplyCoordinator = new WaitReplyCoordinator();
