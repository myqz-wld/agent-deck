/**
 * injectResumeHistory 共享层单测（plan resume-inject-raw-messages-20260601 §D5/§D6/§D7 测试矩阵）。
 *
 * **测试方式**：直接调 module-level `injectResumeHistory(opts)`，4 thunk 全 stub（summariseFn /
 * listEventsFn / listMessagesFn / maxEventIdFn），纯函数 input/output 验证，不依赖 DB / TestBridge。
 *
 * 覆盖维度：
 * - 双数据源（listEventsFn 全量喂总结 / listMessagesFn message-only 拼 raw 段）
 * - 三段拼接顺序（总结前 / 原始消息中 / 当前消息后）+ chronological reverse
 * - maxEventIdFn 作 beforeIdInclusive 传入 listMessagesFn（排除当前消息）
 * - D6 降级链：step0 original-over-length / no-history / over-length-dropped-summary /
 *   summary-failed-raw-used / history-budget-empty
 * - 永不抛错：maxEventIdFn / listMessagesFn / listEventsFn / summariseFn 任一 throw 仍返 PrependResult
 * - 预算式拼接：raw 段逐条加到逼近预算停（动态条数 ≤ N）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  injectResumeHistory,
  type InjectResumeHistoryOptions,
} from '../inject-history';
import type { AgentEvent } from '@shared/types';

/** 造一条全量 event（喂 listEventsFn，summariseFn 数据源）。 */
function evt(text: string): AgentEvent {
  return { sessionId: 's', agentId: '', kind: 'message', payload: { text }, ts: 1, source: 'sdk' };
}

/** 造一条 message-only event（role/text）。 */
function msg(id: number, role: 'user' | 'assistant', text: string): AgentEvent & { id: number } {
  return { id, sessionId: 's', agentId: '', kind: 'message', payload: { role, text }, ts: id, source: 'sdk' };
}

/** 默认 opts —— 各 case 用 overrides 覆盖。 */
function makeOpts(overrides: Partial<InjectResumeHistoryOptions> = {}): InjectResumeHistoryOptions {
  return {
    sessionId: 'sess-1',
    originalText: '当前消息',
    cwd: '/tmp/cwd',
    recentMessagesCount: 30,
    maxLength: 102_400,
    agentName: 'Claude',
    maxEventIdFn: () => null,
    summariseFn: vi.fn(async () => null),
    listEventsFn: vi.fn(() => []),
    listMessagesFn: vi.fn(() => []),
    ...overrides,
  };
}

describe('injectResumeHistory (plan resume-inject §D5/§D6/§D7)', () => {
  // ─── step0: original-over-length（唯一阻塞态）───
  it('step0: originalText > maxLength → used=false + original-over-length（caller 不进 createSession）', async () => {
    const r = await injectResumeHistory(
      makeOpts({ originalText: 'x'.repeat(101), maxLength: 100 }),
    );
    expect(r.used).toBe(false);
    expect(r.failReason).toBe('original-over-length');
    expect(r.prompt).toBe('x'.repeat(101)); // 退回 originalText 原样
  });

  // ─── no-history: listMessages 空 → 退回 originalText ───
  it('no-history: listMessages 空 → used=false + no-history（raw 段是底线）', async () => {
    const r = await injectResumeHistory(
      makeOpts({
        summariseFn: vi.fn(async () => '总结内容'), // 即使总结成功
        listMessagesFn: vi.fn(() => []), // 但无原始对话 → no-history
      }),
    );
    expect(r.used).toBe(false);
    expect(r.failReason).toBe('no-history');
    expect(r.prompt).toBe('当前消息');
  });

  // ─── full: 总结 + 原始消息 + 当前消息三段齐全 ───
  it('full: 总结成功 + 有原始对话 → used=true + 三段顺序（总结前/原始中/当前后）', async () => {
    const r = await injectResumeHistory(
      makeOpts({
        originalText: '用户当前问题',
        summariseFn: vi.fn(async () => 'LLM 总结正文'),
        listEventsFn: vi.fn(() => [evt('x')]),
        listMessagesFn: vi.fn(() => [msg(1, 'user', '历史问 A'), msg(2, 'assistant', '历史答 B')]),
      }),
    );
    expect(r.used).toBe(true);
    expect(r.failReason).toBeUndefined();
    // 三段 header 都在
    expect(r.prompt).toContain('历史会话摘要');
    expect(r.prompt).toContain('LLM 总结正文');
    expect(r.prompt).toContain('最近原始对话消息');
    expect(r.prompt).toContain('用户当前消息');
    expect(r.prompt).toContain('用户当前问题');
    // 顺序：总结 < 原始 < 当前
    const iSummary = r.prompt.indexOf('历史会话摘要');
    const iRaw = r.prompt.indexOf('最近原始对话消息');
    const iCur = r.prompt.indexOf('用户当前消息');
    expect(iSummary).toBeLessThan(iRaw);
    expect(iRaw).toBeLessThan(iCur);
  });

  // ─── chronological：listMessages DESC → helper reverse 成升序（旧→新）───
  it('原始对话段 chronological 升序（listMessages DESC 输入 → 输出旧在前）', async () => {
    const r = await injectResumeHistory(
      makeOpts({
        summariseFn: vi.fn(async () => null), // 无总结，只验 raw 段顺序
        // listMessages 按 SQL ORDER BY ts DESC 返回最新在前：msg(2) 比 msg(1) 新
        listMessagesFn: vi.fn(() => [msg(2, 'assistant', '较新答'), msg(1, 'user', '较旧问')]),
      }),
    );
    expect(r.used).toBe(true);
    // reverse 后「较旧问」在「较新答」之前（chronological）
    expect(r.prompt.indexOf('较旧问')).toBeLessThan(r.prompt.indexOf('较新答'));
  });

  // ─── agentName：assistant 前缀按 adapter 视角 ───
  it('agentName=Agent → assistant 消息前缀显示 Agent（codex 视角）', async () => {
    const r = await injectResumeHistory(
      makeOpts({
        agentName: 'Agent',
        summariseFn: vi.fn(async () => null),
        listMessagesFn: vi.fn(() => [msg(1, 'assistant', '助手回复')]),
      }),
    );
    expect(r.prompt).toContain('[Agent] 助手回复');
  });

  it('agentName=Claude → assistant 消息前缀显示 Claude（claude 视角）', async () => {
    const r = await injectResumeHistory(
      makeOpts({
        agentName: 'Claude',
        summariseFn: vi.fn(async () => null),
        listMessagesFn: vi.fn(() => [msg(1, 'assistant', '助手回复')]),
      }),
    );
    expect(r.prompt).toContain('[Claude] 助手回复');
  });

  // ─── maxEventIdFn 作 beforeIdInclusive 传给 listMessagesFn ───
  it('maxEventIdFn 返值作 beforeIdInclusive 传入 listMessagesFn（排除当前消息）', async () => {
    const listMessagesSpy = vi.fn(() => [msg(1, 'user', '历史')]);
    await injectResumeHistory(
      makeOpts({
        maxEventIdFn: () => 42,
        recentMessagesCount: 15,
        listMessagesFn: listMessagesSpy,
      }),
    );
    // listMessagesFn(sessionId, limit=15, beforeIdInclusive=42)
    expect(listMessagesSpy).toHaveBeenCalledWith('sess-1', 15, 42);
  });

  it('maxEventIdFn 返 null → 不加 beforeIdInclusive（restart 路径退化为查最近 N）', async () => {
    const listMessagesSpy = vi.fn(() => [msg(1, 'user', '历史')]);
    await injectResumeHistory(
      makeOpts({ maxEventIdFn: () => null, recentMessagesCount: 20, listMessagesFn: listMessagesSpy }),
    );
    expect(listMessagesSpy).toHaveBeenCalledWith('sess-1', 20, undefined);
  });

  // ─── 永不抛错（§不变量 1）───
  it('永不抛错: maxEventIdFn throw → 降级 beforeId=undefined 仍继续（used=true）', async () => {
    const listMessagesSpy = vi.fn(() => [msg(1, 'user', '历史')]);
    const r = await injectResumeHistory(
      makeOpts({
        maxEventIdFn: () => {
          throw new Error('DB locked');
        },
        listMessagesFn: listMessagesSpy,
      }),
    );
    expect(r.used).toBe(true); // 仍注入
    expect(listMessagesSpy).toHaveBeenCalledWith('sess-1', 30, undefined); // beforeId 降级 undefined
  });

  it('永不抛错: listMessagesFn throw → used=false + no-history（不抛错）', async () => {
    const r = await injectResumeHistory(
      makeOpts({
        listMessagesFn: vi.fn(() => {
          throw new Error('payload_json corrupt');
        }),
      }),
    );
    expect(r.used).toBe(false);
    expect(r.failReason).toBe('no-history');
    expect(r.thrown).toBeInstanceOf(Error);
    expect(r.prompt).toBe('当前消息'); // 退回 originalText
  });

  it('永不抛错: summariseFn throw → summary-failed-raw-used（不连带丢 raw，§D7）', async () => {
    const r = await injectResumeHistory(
      makeOpts({
        summariseFn: vi.fn(async () => {
          throw new Error('LLM timeout');
        }),
        listEventsFn: vi.fn(() => [evt('x')]),
        listMessagesFn: vi.fn(() => [msg(1, 'user', '历史问题')]),
      }),
    );
    expect(r.used).toBe(true); // 仍注入 raw 段
    expect(r.failReason).toBe('summary-failed-raw-used');
    expect(r.prompt).toContain('历史问题'); // raw 段在
    expect(r.prompt).not.toContain('历史会话摘要'); // 总结段缺省
  });

  it('永不抛错: listEventsFn throw → summary 段缺省走 summary-failed-raw-used（仍注 raw）', async () => {
    const r = await injectResumeHistory(
      makeOpts({
        listEventsFn: vi.fn(() => {
          throw new Error('events read error');
        }),
        summariseFn: vi.fn(async () => '不应被调用到（events throw 在前）'),
        listMessagesFn: vi.fn(() => [msg(1, 'user', '历史问题')]),
      }),
    );
    expect(r.used).toBe(true);
    expect(r.failReason).toBe('summary-failed-raw-used');
    expect(r.prompt).toContain('历史问题');
  });

  // ─── 总结返 null/空 → summary-failed-raw-used（仍注 raw）───
  it('summariseFn 返 null → summary-failed-raw-used（仍注 raw 段）', async () => {
    const r = await injectResumeHistory(
      makeOpts({
        summariseFn: vi.fn(async () => null),
        listMessagesFn: vi.fn(() => [msg(1, 'user', '历史问题')]),
      }),
    );
    expect(r.used).toBe(true);
    expect(r.failReason).toBe('summary-failed-raw-used');
    expect(r.prompt).toContain('历史问题');
    expect(r.prompt).not.toContain('历史会话摘要');
  });

  // ─── 预算式拼接：raw 段逐条加到逼近预算停 ───
  it('预算式拼接: maxLength 紧 → raw 段只拼下最新的几条（动态条数 ≤ N）', async () => {
    // maxLength 故意设小：当前消息「当前消息」(4字) + wrapper + 只够 1-2 条 raw
    // 10 条 message 每条 ~50 字，预算只够最新 1 条
    const many = Array.from({ length: 10 }, (_, i) => msg(i + 1, 'user', `历史消息编号${i + 1}内容`.padEnd(40, '填')));
    const r = await injectResumeHistory(
      makeOpts({
        originalText: '现',
        maxLength: 120, // 很紧的预算
        summariseFn: vi.fn(async () => null),
        listMessagesFn: vi.fn(() => many), // DESC：编号 1 是「最新」(列表第一个)
      }),
    );
    // used=true（至少拼下最新 1 条）
    expect(r.used).toBe(true);
    // 最新那条（列表第一个 = 编号1）一定在；最旧的（编号10）预算不够被丢
    expect(r.prompt).toContain('历史消息编号1');
    expect(r.prompt).not.toContain('历史消息编号10');
  });

  // ─── history-budget-empty: 当前消息 + wrapper 逼近 maxLength → raw 段空 ───
  it('history-budget-empty: 当前消息+wrapper 逼近 maxLength → 退回 originalText（wrapper 边界兜底）', async () => {
    // originalText 接近 maxLength：过了 step0（<= maxLength）但减去 wrapper 后预算 ≤ 0
    const big = 'x'.repeat(95);
    const r = await injectResumeHistory(
      makeOpts({
        originalText: big,
        maxLength: 100, // big(95) + wrapper(>5) → raw 预算 ≤ 0
        summariseFn: vi.fn(async () => null),
        listMessagesFn: vi.fn(() => [msg(1, 'user', '历史问题')]),
      }),
    );
    expect(r.used).toBe(false);
    expect(r.failReason).toBe('history-budget-empty');
    expect(r.prompt).toBe(big); // 退回纯 originalText（已过 step0 → ≤ maxLength → createSession 能起）
  });

  // ─── over-length-dropped-summary: 总结段超大 → 丢总结保 raw ───
  it('over-length-dropped-summary: 总结段单独超大 → 丢总结保 raw（used=true）', async () => {
    // 总结超大（占满预算），但当前消息 + raw 小 → 丢总结后 raw 能 fit
    const hugeSummary = '总'.repeat(200);
    const r = await injectResumeHistory(
      makeOpts({
        originalText: '现',
        maxLength: 300, // 当前消息小 + raw 小能 fit，但 +hugeSummary(200) 超
        summariseFn: vi.fn(async () => hugeSummary),
        listEventsFn: vi.fn(() => [evt('x')]),
        listMessagesFn: vi.fn(() => [msg(1, 'user', '历史问题短')]),
      }),
    );
    expect(r.used).toBe(true);
    expect(r.failReason).toBe('over-length-dropped-summary');
    expect(r.prompt).toContain('历史问题短'); // raw 段在
    expect(r.prompt).not.toContain('历史会话摘要'); // 总结段被丢
  });
});
