/**
 * REVIEW_107 Batch 9 回归测试 — TeamDetail 展示纯逻辑（events-payload-describe.ts +
 * helpers.relativeTime）。
 *
 * 覆盖 R1：
 * - LOW（双方独立）：describeEventPayload 对 truthy 非 string 原始值 payload 守门（`'in'`
 *   对原始值抛 TypeError → TeamDetail 无 local ErrorBoundary → 整 app 崩）。
 * - LOW（双方独立）：relativeTime 非 finite 输入兜底（Date.parse(非法 ISO)=NaN → "NaN 天前"）。
 * - R4 安全面回归：未知 kind / 缺字段不暴露 raw JSON（保持「无更多详情」兜底）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { describeEventPayload, truncate80 } from '../events-payload-describe';
import { relativeTime } from '../helpers';

function ev(kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return { sessionId: 's', agentId: '', kind, payload, ts: 0 };
}

describe('describeEventPayload — REVIEW_107 LOW primitive payload 守门', () => {
  it('number payload 不抛 TypeError，返「无更多详情」', () => {
    // 修前：`'text' in 42` 抛 TypeError → 整 app 崩
    expect(() => describeEventPayload(ev('message', 42))).not.toThrow();
    expect(describeEventPayload(ev('message', 42))).toBe('无更多详情');
  });
  it('boolean true payload 不抛，返「无更多详情」', () => {
    expect(() => describeEventPayload(ev('message', true))).not.toThrow();
    expect(describeEventPayload(ev('message', true))).toBe('无更多详情');
  });
  it('falsy payload（0 / false / null）返空串', () => {
    expect(describeEventPayload(ev('message', 0))).toBe('');
    expect(describeEventPayload(ev('message', false))).toBe('');
    expect(describeEventPayload(ev('message', null))).toBe('');
  });
});

describe('describeEventPayload — 正常路径', () => {
  it('string payload 直接返（≤80）', () => {
    expect(describeEventPayload(ev('message', 'hello'))).toBe('hello');
  });
  it('string payload >80 截断 + …', () => {
    const long = 'x'.repeat(100);
    expect(describeEventPayload(ev('message', long))).toBe(`${'x'.repeat(80)}…`);
  });
  it('object.text 优先', () => {
    expect(describeEventPayload(ev('message', { text: 'hi', summary: 'no' }))).toBe('hi');
  });
  it('session-end reason 翻译', () => {
    expect(describeEventPayload(ev('session-end', { reason: 'completed' }))).toBe('正常结束');
  });
  it('team-task-created 拼 desc → assigned @ team', () => {
    expect(
      describeEventPayload(
        ev('team-task-created', { description: '修 bug', teammateName: 'codex', teamName: 't1' }),
      ),
    ).toBe('修 bug → codex @ t1');
  });
});

describe('describeEventPayload — R4 安全面（不暴露 raw JSON）', () => {
  it('未知 kind + 无识别字段 → 无更多详情（非 JSON.stringify）', () => {
    const out = describeEventPayload(ev('finished', { cwd: '/x', stopHookActive: true }));
    expect(out).toBe('无更多详情');
    expect(out).not.toContain('{');
    expect(out).not.toContain('stopHookActive');
  });
});

describe('truncate80', () => {
  it('≤80 原样', () => {
    expect(truncate80('abc')).toBe('abc');
  });
  it('>80 截断 + …', () => {
    expect(truncate80('y'.repeat(81))).toBe(`${'y'.repeat(80)}…`);
  });
});

describe('relativeTime — REVIEW_107 LOW 非 finite 守门', () => {
  it('NaN 返空串（修前 → "NaN 天前"）', () => {
    expect(relativeTime(NaN)).toBe('');
  });
  it('Date.parse(非法 ISO) → NaN → 空串', () => {
    expect(relativeTime(Date.parse('not-a-date'))).toBe('');
  });
  it('Infinity 返空串', () => {
    expect(relativeTime(Infinity)).toBe('');
  });
});

describe('relativeTime — 正常路径', () => {
  const now = 1_000_000_000_000;
  it('<5s → 刚刚', () => {
    expect(relativeTime(now - 2_000, now)).toBe('刚刚');
  });
  it('分钟级', () => {
    expect(relativeTime(now - 3 * 60_000, now)).toBe('3 分钟前');
  });
  it('未来时间（now-ts<0）→ Math.max(0,..) → 刚刚', () => {
    expect(relativeTime(now + 100_000, now)).toBe('刚刚');
  });
});
