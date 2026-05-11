/**
 * WaitReplyCoordinator 单测（B'0 ADR §3.3 / B'2.b）。
 *
 * 测试 coordinator 自身行为（不依赖 SQLite / sessionRepo）：
 * - 三档 until 语义（first_message / turn_complete / idle）
 * - 并发同 (sid, until, idleQuietMs) 共享 promise
 * - baseline_ts 防御 race（只收 ts >= baseline_ts 的事件）
 * - session-removed 强制 resolve
 * - shutdownAll 清理所有 active
 *
 * tools.ts wait_reply handler 的「caller since_ts filter + backfill 合并」
 * 在 tools.test.ts 与 coordinator 配合测。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { eventBus } from '../../event-bus';
import { WaitReplyCoordinator } from '../wait-reply-coordinator';
import type { AgentEvent } from '@shared/types';

function emit(sid: string, kind: AgentEvent['kind'], payload: unknown = {}, ts = Date.now()) {
  eventBus.emit('agent-event', {
    sessionId: sid,
    agentId: 'claude-code',
    kind,
    payload,
    ts,
    source: 'sdk',
  });
}

describe('WaitReplyCoordinator', () => {
  let coord: WaitReplyCoordinator;

  beforeEach(() => {
    coord = new WaitReplyCoordinator();
    // 清理 eventBus 监听器（防止跨测污染）
    eventBus.removeAllListeners();
  });

  it('first_message：拿到第一条 message 即 resolve', async () => {
    const promise = coord.waitFor('s1', 'first_message', 5000);
    setTimeout(() => emit('s1', 'message', { text: 'hello world' }), 5);
    const result = await promise;
    expect(result.reason).toBe('first-message');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe('message');
    expect(result.events[0].text).toBe('hello world');
    expect(coord.activeCount).toBe(0); // resolve 后清掉 entry
  });

  it('turn_complete：拿到 finished 即 resolve', async () => {
    const promise = coord.waitFor('s1', 'turn_complete', 5000);
    // 中间事件不触发 resolve
    setTimeout(() => emit('s1', 'message', { text: 'thinking...' }), 5);
    setTimeout(() => emit('s1', 'tool-use-start', { toolName: 'Read' }), 10);
    setTimeout(() => emit('s1', 'finished', { subtype: 'normal' }), 15);
    const result = await promise;
    expect(result.reason).toBe('turn-complete');
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.kind)).toEqual([
      'message',
      'tool-use-start',
      'finished',
    ]);
  });

  it('turn_complete：waiting-for-user 也触发 resolve', async () => {
    const promise = coord.waitFor('s1', 'turn_complete', 5000);
    setTimeout(() => emit('s1', 'waiting-for-user', { reason: 'permission' }), 5);
    const result = await promise;
    expect(result.reason).toBe('turn-complete');
  });

  it('idle：N ms 无事件后 resolve', async () => {
    const promise = coord.waitFor('s1', 'idle', 50);
    // emit 一个 message → 不立即 resolve（idle 模式）→ 重置 timer
    setTimeout(() => emit('s1', 'message', { text: 'a' }), 10);
    setTimeout(() => emit('s1', 'message', { text: 'b' }), 30);
    // t=30 之后 50ms 内（即 t=80）无事件 → resolve
    const result = await promise;
    expect(result.reason).toBe('idle');
    expect(result.events).toHaveLength(2);
  });

  it('并发同 (sid, until, idleQuietMs) 共享 promise', async () => {
    const p1 = coord.waitFor('s1', 'first_message', 5000);
    const p2 = coord.waitFor('s1', 'first_message', 5000);
    const p3 = coord.waitFor('s1', 'first_message', 5000);
    expect(coord.activeCount).toBe(1); // 仅一个 entry
    setTimeout(() => emit('s1', 'message', { text: 'shared reply' }), 5);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    // 三个 caller 拿到同一个 result（baselineTs / events 都相同）
    expect(r1.events).toEqual(r2.events);
    expect(r2.events).toEqual(r3.events);
    expect(r1.events[0].text).toBe('shared reply');
  });

  it('不同 until 各自一个 promise', async () => {
    const p1 = coord.waitFor('s1', 'first_message', 5000);
    const p2 = coord.waitFor('s1', 'turn_complete', 5000);
    expect(coord.activeCount).toBe(2); // 两个独立 entry
    setTimeout(() => emit('s1', 'message', { text: 'mid' }), 5);
    const r1 = await p1;
    expect(r1.reason).toBe('first-message');
    expect(coord.activeCount).toBe(1); // p1 resolve 后剩 p2
    setTimeout(() => emit('s1', 'finished', {}), 10);
    const r2 = await p2;
    expect(r2.reason).toBe('turn-complete');
    expect(coord.activeCount).toBe(0);
  });

  it('baseline_ts 之前的 event 不收（防 race）', async () => {
    const baseline = Date.now();
    const promise = coord.waitFor('s1', 'first_message', 5000);
    // 假装一个 baseline_ts 之前的 event 进来（理论上 listener 注册前就过去了，
    // 但极端情况下可能因为 event ts 来自上游 hook 时间漂移而出现）
    emit('s1', 'message', { text: 'old' }, baseline - 100);
    // 真实新 event：ts 必须 > baseline
    setTimeout(() => emit('s1', 'message', { text: 'new' }, Date.now() + 1), 5);
    const result = await promise;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].text).toBe('new');
  });

  it('其他 sessionId 的 event 不收', async () => {
    const promise = coord.waitFor('s1', 'first_message', 5000);
    setTimeout(() => emit('s2', 'message', { text: 'noise' }), 5);
    setTimeout(() => emit('s1', 'message', { text: 'real' }), 10);
    const result = await promise;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].text).toBe('real');
  });

  it('session-removed 强制 resolve（reason=session-closed）', async () => {
    const promise = coord.waitFor('s1', 'turn_complete', 5000);
    setTimeout(() => eventBus.emit('session-removed', 's1'), 5);
    const result = await promise;
    expect(result.reason).toBe('session-closed');
    expect(coord.activeCount).toBe(0);
  });

  it('shutdownAll 强制 resolve 所有 active', async () => {
    const p1 = coord.waitFor('s1', 'first_message', 5000);
    const p2 = coord.waitFor('s2', 'turn_complete', 5000);
    const p3 = coord.waitFor('s3', 'idle', 1000);
    expect(coord.activeCount).toBe(3);
    coord.shutdownAll();
    expect(coord.activeCount).toBe(0);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.reason).toBe('session-closed');
    expect(r2.reason).toBe('session-closed');
    expect(r3.reason).toBe('session-closed');
  });

  it('hasActive 反查正确', async () => {
    expect(coord.hasActive('s1', 'idle', 1000)).toBe(false);
    coord.waitFor('s1', 'idle', 1000);
    expect(coord.hasActive('s1', 'idle', 1000)).toBe(true);
    expect(coord.hasActive('s1', 'idle', 2000)).toBe(false); // 不同 idleQuietMs 不命中
    expect(coord.hasActive('s2', 'idle', 1000)).toBe(false);
  });

  it('resolve 后再 waitFor 起新 promise（不复用旧的）', async () => {
    const p1 = coord.waitFor('s1', 'first_message', 5000);
    setTimeout(() => emit('s1', 'message', { text: 'first' }), 5);
    const r1 = await p1;
    expect(r1.events[0].text).toBe('first');
    expect(coord.activeCount).toBe(0);
    // 起第二个 wait
    const p2 = coord.waitFor('s1', 'first_message', 5000);
    expect(coord.activeCount).toBe(1);
    setTimeout(() => emit('s1', 'message', { text: 'second' }), 5);
    const r2 = await p2;
    expect(r2.events[0].text).toBe('second');
  });

  it('event projection：tool-use-start 投影 toolName', async () => {
    const promise = coord.waitFor('s1', 'turn_complete', 5000);
    setTimeout(() => emit('s1', 'tool-use-start', { toolName: 'Bash' }), 5);
    setTimeout(() => emit('s1', 'finished', {}), 10);
    const result = await promise;
    expect(result.events[0].kind).toBe('tool-use-start');
    expect(result.events[0].summary).toBe('Bash');
  });
});
