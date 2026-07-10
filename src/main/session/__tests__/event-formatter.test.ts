/**
 * event-formatter 纯函数单测（REVIEW_83 LOW，reviewer-codex E2 finding）。
 *
 * 覆盖 formatEventsForPrompt 的排序契约：
 * - 同毫秒事件按 id tie-breaker 还原 chronological（旧→新），不因 JS stable sort 保留
 *   listForSession 的 (ts DESC, id DESC) 输入顺序而在 prompt 里逆序。
 * - 取末尾 30 条（最新一段），不是前 30。
 *
 * 纯函数无 SQLite / 无 better-sqlite3 binding 依赖，任何 Node 版本都能跑。
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { formatEventsForPrompt } from '../summarizer/event-formatter';

function msg(id: number, ts: number, text: string): AgentEvent & { id: number } {
  return {
    id,
    sessionId: 's1',
    agentId: 'claude-code',
    kind: 'message',
    payload: { text, role: 'assistant' },
    ts,
    source: 'sdk',
  };
}

describe('formatEventsForPrompt — 排序契约', () => {
  // **REVIEW_83 LOW (reviewer-codex)**: 同毫秒事件 id tie-breaker 还原 chronological。
  // listForSession 返回 (ts DESC, id DESC) → 同 ts 输入顺序是 id 降序（新→旧）；
  // 旧版仅 sort((a,b)=>a.ts-b.ts) 稳定保留输入顺序 → prompt 里同毫秒逆序。
  it('同毫秒事件按 id 升序还原（旧→新），不保留输入 id 降序', () => {
    // 模拟 listForSession 输出：同 ts=1000，id 降序（新的在前）
    const events = [
      msg(3, 1000, 'third-newest'),
      msg(2, 1000, 'second'),
      msg(1, 1000, 'first-oldest'),
    ];
    const out = formatEventsForPrompt(events);
    // 期望 chronological：first → second → third（id 升序）
    const idxFirst = out.indexOf('first-oldest');
    const idxSecond = out.indexOf('second');
    const idxThird = out.indexOf('third-newest');
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxFirst).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxThird);
  });

  it('跨毫秒主排序仍按 ts 升序（id tie-breaker 不破坏主序）', () => {
    const events = [
      msg(10, 3000, 'late'),
      msg(20, 1000, 'early'), // id 更大但 ts 更小 → 应排前
      msg(15, 2000, 'mid'),
    ];
    const out = formatEventsForPrompt(events);
    expect(out.indexOf('early')).toBeLessThan(out.indexOf('mid'));
    expect(out.indexOf('mid')).toBeLessThan(out.indexOf('late'));
  });

  it('取末尾 30 条（最新一段）而非前 30', () => {
    // 造 35 条递增 ts，期望保留最新 30（ts 6..35），丢弃最旧 5（ts 1..5）
    const events: (AgentEvent & { id: number })[] = [];
    for (let i = 1; i <= 35; i++) events.push(msg(i, i * 1000, `m${i}`));
    const out = formatEventsForPrompt(events);
    // 最旧 5 条不在
    expect(out).not.toContain('m1 ');
    expect(out).not.toContain('m5 ');
    // 最新条在
    expect(out).toContain('m35');
    expect(out).toContain('m6');
  });

  it('无 id 字段时降级到纯 ts 排序（兼容无 id caller，?? 0 兜底不抛错）', () => {
    const noId = [
      { sessionId: 's1', agentId: 'claude-code', kind: 'message', payload: { text: 'a', role: 'assistant' }, ts: 1000, source: 'sdk' },
      { sessionId: 's1', agentId: 'claude-code', kind: 'message', payload: { text: 'b', role: 'assistant' }, ts: 2000, source: 'sdk' },
    ] as AgentEvent[];
    expect(() => formatEventsForPrompt(noId)).not.toThrow();
    const out = formatEventsForPrompt(noId);
    expect(out.indexOf('a')).toBeLessThan(out.indexOf('b'));
  });

  it('周期总结和 hand-off 输入保留 Codex 协作 Agent 的安全参数', () => {
    const event: AgentEvent = {
      sessionId: 's1',
      agentId: 'codex-cli',
      kind: 'tool-use-start',
      payload: {
        toolName: 'Agent',
        toolInput: {
          collab_tool: 'wait_agent',
          target: '/root/reviewer',
          model: 'gpt-5.6-codex',
          reasoning_effort: 'xhigh',
          timeout_ms: 30000,
        },
      },
      ts: 1000,
      source: 'sdk',
    };

    expect(formatEventsForPrompt([event])).toContain(
      'Agent · wait_agent · → /root/reviewer · gpt-5.6-codex/xhigh · 超时 30 秒',
    );
  });
});
