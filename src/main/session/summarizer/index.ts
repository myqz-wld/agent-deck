import type { SummaryRecord } from '@shared/types';
import { summaryRepo } from '@main/store/summary-repo';
import { eventRepo } from '@main/store/event-repo';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { settingsStore } from '@main/store/settings-store';
import { summariseCodexSessionViaOneshot } from '@main/adapters/codex-cli/summarizer-runner';
import { formatEventsForPrompt, localStatsFallback } from './event-formatter';
import { summariseViaLlm } from './llm-runners';

// CHANGELOG_104 物理拆分：保持外部 import path `from '@main/session/summarizer'` 不变
// （sessions.ts / hand-off.test.ts caller 直接用），TS module resolution 自动 fallback
// 到 `summarizer/index.ts`。re-export 也方便未来直接 import 子文件无歧义。
export { summariseSessionForHandOff } from './llm-runners';
export { formatEventsForPrompt } from './event-formatter';

/**
 * Summarizer 调度：定时扫描所有活跃会话，为达到「时间阈值」或「事件数阈值」
 * 的会话生成一段「会话目前在做什么」的意义层面描述。
 *
 * 优先级：LLM 一句话 → 最近一条 assistant 文字 → 事件统计兜底。
 */
export class Summarizer {
  private timer: NodeJS.Timeout | null = null;
  private currentIntervalMs = 0;
  private lastSummarizedAt = new Map<string, number>();
  private inFlight = new Set<string>();
  /**
   * 最近一次失败原因（by sessionId），CHANGELOG_20 / G。UI 设置面板能拉到诊断。
   * 成功 summarize 后 delete 该 sessionId（避免历史错误一直留着误导）。
   */
  private lastErrorBySession = new Map<string, { message: string; ts: number }>();
  /** event-bus 上 session-removed 监听的解绑函数，stop() 时调一下避免泄漏。 */
  private offSessionRemoved: (() => void) | null = null;
  /** event-bus 上 session-renamed 监听的解绑函数，stop() 时调一下避免泄漏（REVIEW_35 MED-B2）。 */
  private offSessionRenamed: (() => void) | null = null;

  start(): void {
    if (this.timer) return;
    this.scheduleTimer();
    // 会话被删除时同步清掉 lastSummarizedAt 该 sessionId，
    // 否则这张 Map 单调增长（每条 SDK summary 都 set，永不 delete），
    // 长期跑下来 + 历史超期清理 / 用户手动删 / SDK fallback rename 都会留孤儿 key。
    if (!this.offSessionRemoved) {
      const handler = (sid: string): void => {
        this.lastSummarizedAt.delete(sid);
        // 同时清错误诊断：会话都没了，错误也无意义。
        this.lastErrorBySession.delete(sid);
      };
      eventBus.on('session-removed', handler);
      this.offSessionRemoved = () => eventBus.off('session-removed', handler);
    }
    // REVIEW_35 MED-B2：summarizer per-session state 必须跟随 session rename 迁移。
    // manager.renameSdkSession 只 emit `session-renamed` + `session-upserted`，**不**emit
    // `session-removed`。如果只挂 session-removed listener，CLI 隐式 fork (OLD→NEW) /
    // SDK fallback (tempKey→realId) 后 lastSummarizedAt[OLD] 变孤儿、NEW 从 startedAt 重算
    // 重复处理旧事件；lastErrorBySession[OLD] 同样孤儿（renderer 设置面板永远显示 OLD_ID 错）。
    if (!this.offSessionRenamed) {
      const renameHandler = (payload: { from: string; to: string }): void => {
        const lastTs = this.lastSummarizedAt.get(payload.from);
        if (lastTs !== undefined) {
          this.lastSummarizedAt.set(payload.to, lastTs);
          this.lastSummarizedAt.delete(payload.from);
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

  /**
   * 设置面板里把 summaryIntervalMs 改了 → 立刻重启 setInterval 周期。
   * 之前 start() 只读一次配置写进 setInterval，运行时改设置永远不生效，必须重启应用，
   * 这与 CLAUDE.md 自家的「即改即生效中转点」约定相违。
   */
  setIntervalMs(ms: number): void {
    if (!this.timer) return; // 还没 start 过，下次 start 会读最新值
    const next = Math.max(30_000, Math.floor(ms / 2));
    if (next === this.currentIntervalMs) return; // 周期没变就不重置 timer
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.scanAll(), next);
    this.currentIntervalMs = next;
    console.log(`[summarizer] interval updated to ${next}ms`);
  }

  private scheduleTimer(): void {
    const interval = settingsStore.get('summaryIntervalMs');
    const period = Math.max(30_000, Math.floor(interval / 2));
    this.timer = setInterval(() => void this.scanAll(), period);
    this.currentIntervalMs = period;
  }

  async scanAll(): Promise<void> {
    const sessions = sessionRepo.listActiveAndDormant(50);
    const intervalMs = settingsStore.get('summaryIntervalMs');
    const eventCount = settingsStore.get('summaryEventCount');
    // 全局并发上限：每次总结都会拉一个 cli.js oneshot 子进程跑 LLM，
    // 同时拉起 10+ 子进程会打爆 CPU/网络/API 限流。超出的会话交给下次扫描；
    // sessions 按 last_event_at 倒序，最近活跃的优先得到总结。
    const maxConcurrent = Math.max(1, settingsStore.get('summaryMaxConcurrent'));
    const now = Date.now();
    for (const s of sessions) {
      // 全局并发上限：到顶就退出本轮扫描，下次扫描重新评估。
      if (this.inFlight.size >= maxConcurrent) break;
      if (this.inFlight.has(s.id)) continue;
      const lastTs = this.lastSummarizedAt.get(s.id) ?? s.startedAt;
      const eventsSince = eventRepo.countForSession(s.id, lastTs);
      // 没新事件就跳过：静默会话不需要反复跑 LLM 拿一模一样的总结。
      // 这条比时间/数量阈值优先级更高。
      if (eventsSince === 0) continue;
      const shouldByTime = now - lastTs >= intervalMs;
      const shouldByCount = eventsSince >= eventCount;
      if (!shouldByTime && !shouldByCount) continue;

      // 不阻塞循环：每个会话独立 await，避免一个慢的 LLM 总结拖慢其余会话
      this.inFlight.add(s.id);
      void this.summarize(s.id)
        .then((content) => {
          if (!content) return;
          // REVIEW_35 R2 HIGH-B1：in-flight summary 在 LLM await 期间撞 renameSdkSession(OLD,NEW)
          // → sessionRepo.rename 已 UPDATE summaries SET session_id=NEW + DELETE FROM sessions WHERE id=OLD
          // → 此处 insert sessionId=OLD 撞 FK constraint failed (v001 schema CASCADE+pragma foreign_keys=ON)
          // 修法：insert 前预检 sessionRepo.get(s.id)，rename 后 OLD 已不存在则短路（让 next scanAll
          // 拿 NEW 重新跑 LLM，本次 LLM 工作白费但避免 FK 错 + 不写孤儿诊断）
          if (!sessionRepo.get(s.id)) {
            console.warn(`[summarizer] session ${s.id} renamed/deleted during in-flight LLM, skipping insert`);
            return;
          }
          const rec = summaryRepo.insert({
            sessionId: s.id,
            content,
            trigger: shouldByCount ? 'event-count' : 'time',
            ts: Date.now(),
          });
          eventBus.emit('summary-added', rec);
          this.lastSummarizedAt.set(s.id, Date.now());
          // REVIEW_35 MED-B1：旧版 .then 无脑 delete LLM 错误 — 但 summarize() 在 LLM 失败时
          // 会继续走 fallback 兜底（assistant 文字 / 事件统计），fallback 成功 → content 非 null →
          // 走到这里 → delete 把刚发生的 LLM 错误诊断洗掉，CLAUDE.md「LLM oneshot 失败要透传 stderr」
          // 约束被破坏。修法：lastErrorBySession 的 set/delete 都收口在 summarize() 内部
          // （只有 LLM 真成功时才 delete），caller .then 不再 touch。
        })
        .catch((err) => {
          // REVIEW_35 R2 HIGH-B1 同款防御：rename 后 OLD 不存在则 set lastErrorBySession[OLD] 是
          // orphan（rename listener 已迁，再 set 创建第二个 OLD key 永久滞留）→ 短路防 orphan diagnostics
          if (!sessionRepo.get(s.id)) return;
          // 总失败（LLM + fallback 都挂）：summarize() 内 catch 已 set；这里兜底再写一次保证
          // 极端情况（summarize() throw 在 catch 之前的 sync 段）也有诊断。
          this.lastErrorBySession.set(s.id, {
            message: (err as Error)?.message ?? String(err),
            ts: Date.now(),
          });
          console.warn(`[summarizer] session ${s.id} failed:`, err);
        })
        .finally(() => this.inFlight.delete(s.id));
    }
  }

  /** 拉取最近一次失败诊断（by sessionId），UI 设置面板用。空 Map 表示没有任何会话失败过。 */
  getLastErrors(): Record<string, { message: string; ts: number }> {
    const out: Record<string, { message: string; ts: number }> = {};
    for (const [sid, info] of this.lastErrorBySession.entries()) {
      out[sid] = info;
    }
    return out;
  }

  /** 手动触发某会话的总结 */
  async summarizeNow(sessionId: string): Promise<SummaryRecord | null> {
    const summary = await this.summarize(sessionId);
    if (!summary) return null;
    const rec = summaryRepo.insert({
      sessionId,
      content: summary,
      trigger: 'manual',
      ts: Date.now(),
    });
    eventBus.emit('summary-added', rec);
    this.lastSummarizedAt.set(sessionId, Date.now());
    return rec;
  }

  private async summarize(sessionId: string): Promise<string | null> {
    const session = sessionRepo.get(sessionId);
    if (!session) return null;
    const events = eventRepo.listForSession(sessionId, 40);
    if (events.length === 0) return null;

    // 1) 优先：跑一次 LLM oneshot，按 session.agentId dispatch（CHANGELOG_<X> A3）：
    //    - 'claude-code' → claude SDK oneshot（haiku，~/.claude OAuth）
    //    - 'codex-cli'   → codex SDK oneshot（read-only sandbox + 'low' reasoning effort）
    //    - 其他 adapter（aider / generic-pty）→ 没有 SDK oneshot 通道，跳过 LLM 直接走 fallback
    //    spike-A3 实测 5 codex 并发 oneshot 复用 app-server 单例，资源温和（10s / ~44MB），
    //    与 claude 共用全局 summaryMaxConcurrent 不需分桶。
    //
    //    R37 P2-H Step 3.2：原本 caller 这里为 codex 路径起 Promise.race 兜底防卡死（codex
    //    SDK 没 q.interrupt 等价物，runner 当时不内置 timeout）。重构后 timeout 已下沉到
    //    `summariseCodexSessionViaOneshot` 内部（走 settings.summaryTimeoutMs，与 claude path
    //    统一），caller 直接 await 即可。
    try {
      let llm: string | null = null;
      if (session.agentId === 'claude-code') {
        llm = await summariseViaLlm(session.cwd, events);
      } else if (session.agentId === 'codex-cli') {
        llm = await summariseCodexSessionViaOneshot(
          session.cwd,
          events,
          formatEventsForPrompt,
        );
      }
      if (llm) {
        // REVIEW_35 MED-B1：LLM 真成功才 delete 历史错误，确保「LLM 失败 + fallback 成功」
        // 时 lastErrorBySession 仍保留 LLM 错误诊断（与 CLAUDE.md「LLM oneshot 失败要透传 stderr」
        // 约束一致）。
        this.lastErrorBySession.delete(sessionId);
        return llm;
      }
    } catch (err) {
      // REVIEW_35 MED-B1：LLM 失败时立即 set 错误诊断（不仅 console.warn）。caller .then 不再
      // 删除（已修），所以「fallback 成功」不会洗掉本错误。下次 LLM 真成功时 delete（line 上方）。
      this.lastErrorBySession.set(sessionId, {
        message: (err as Error)?.message ?? String(err),
        ts: Date.now(),
      });
      console.warn(`[summarizer] LLM failed for ${sessionId} (${session.agentId}), fallback to last-message`, err);
    }

    // 2) 退化：取最近一条「assistant 自己说的话」（任何 adapter 都走这条）。
    //    走独立 SQL 查询（eventRepo.findLatestAssistantMessage）而不是 events.find，
    //    原因：
    //    a. events 限 40 条，tool 密集会话最近 40 条可能 0 条 message → find 必返 undefined
    //    b. 没过滤 role/error 时会拿到用户输入（"push 一下"）或 ⚠ 警告
    //    sinceTs 用 lastSummarizedAt：只取自上次总结后的最新 assistant 文字，
    //    避免回到几小时前的旧 message 当成"现在在做什么"。
    const sinceTs = this.lastSummarizedAt.get(sessionId) ?? session.startedAt;
    const lastMsg = eventRepo.findLatestAssistantMessage(sessionId, sinceTs);
    if (lastMsg) {
      return lastMsg.text.replace(/\s+/g, ' ').trim().slice(0, 100);
    }

    // 3) 再退化：事件 kind 统计
    return localStatsFallback(events);
  }
}

export const summarizer = new Summarizer();
