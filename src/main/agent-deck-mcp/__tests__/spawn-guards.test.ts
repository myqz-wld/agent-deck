/**
 * spawn-guards.ts 4 条防递归规则单测（B'5）。
 *
 * 关注点：
 * - 各 deny 路径的 error message 关键字
 * - inFlightChildren 占位 → release 计数对称
 * - sessionRepo / settingsStore mock，避免 Electron / SQLite
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// R37 P2-F Step 3.1：sessionRepo / settingsStore 走 _shared/mocks/ factory；
// vi.hoisted 让 sessionStore Map 在 vi.mock factory 调用前已初始化（vitest hoist 后
// vi.mock 求值时直接 access module-level const 会撞 ReferenceError）。
const { sessionStore, settingsState } = vi.hoisted(() => ({
  sessionStore: new Map<string, SessionRecord>(),
  settingsState: {
    mcpMaxSpawnDepth: 3,
    mcpMaxFanOutPerParent: 5,
    mcpSpawnRatePerMinute: 100,
  },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({ sessions: sessionStore }),
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock({
    overrides: {
      getAll: () => ({ ...settingsState }),
    },
  }),
}));

import { applySpawnGuards } from '../spawn-guards';
import { spawnRateLimiter, inFlightChildren, RateLimiter } from '../rate-limiter';

function seedSession(sid: string, opts: Partial<SessionRecord> = {}) {
  sessionStore.set(sid, {
    id: sid,
    agentId: 'claude-code',
    cwd: '/repo',
    title: 'test',
    source: 'sdk' as const,
    lifecycle: 'active' as const,
    activity: 'working' as const,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    endedAt: null,
    archivedAt: null,
    spawnedBy: null,
    spawnDepth: 0,
    ...opts,
  });
}

beforeEach(() => {
  sessionStore.clear();
  spawnRateLimiter.reset();
  inFlightChildren.reset();
  settingsState.mcpMaxSpawnDepth = 3;
  settingsState.mcpMaxFanOutPerParent = 5;
  settingsState.mcpSpawnRatePerMinute = 100;
});

const caller = (sid: string) => ({
  callerSessionId: sid,
  parentSessionId: sid,
  transport: 'http' as const,
});

describe('applySpawnGuards — depth 上限', () => {
  it('caller depth >= max → deny', () => {
    seedSession('lead', { spawnDepth: 3 });
    const r = applySpawnGuards(caller('lead'), '/elsewhere', 'codex-cli');
    expect('isError' in r).toBe(true);
    if ('isError' in r) {
      const data = JSON.parse(r.content[0].text);
      expect(data.error).toMatch(/spawn depth 3 >= max 3/);
    }
  });

  it('caller depth < max → 通过该规则', () => {
    seedSession('lead', { spawnDepth: 2 });
    const r = applySpawnGuards(caller('lead'), '/elsewhere', 'codex-cli');
    expect('ok' in r).toBe(true);
  });

  // plan handoff-no-spawn-guards-20260526 §D4/§D6: hand-off 路径完全跳过三道防御
  // (depth + fan-out + spawn-rate)+ 不进 in-flight 计数表(原 batonMode 仅跳 depth,
  // 现 handOffMode 跳全部)。故意推翻 REVIEW_46/47 「archiveCaller=false 退化 normal spawn」修法。
  it('handOffMode=true → caller depth >= max 仍通过(跳过 depth check,§D4 修法)', () => {
    seedSession('lead', { spawnDepth: 3 });
    const r = applySpawnGuards(caller('lead'), '/elsewhere', 'codex-cli', { handOffMode: true });
    expect('ok' in r).toBe(true);
    if ('ok' in r) {
      // parentDepth 字段仍返回真实值(下游 spawn handler 在 handOffMode 路径不消费 +1 但显式返不增成本)
      expect(r.parentDepth).toBe(3);
      r.fanOutSlot.release();
    }
  });

  it('handOffMode=true 三道全跳 — fan-out 上限 + rate-limit 都不 enforce(§D4 推翻 REVIEW_46/47)', () => {
    settingsState.mcpMaxFanOutPerParent = 1;
    settingsState.mcpSpawnRatePerMinute = 1;
    seedSession('lead', { spawnDepth: 3 });
    seedSession('c1', { spawnedBy: 'lead', lifecycle: 'active' });
    // 即使 caller depth 撞顶 + DB 已有 1 child(fan-out=1) + 已起 1 次(rate=1),
    // handOffMode=true 路径都无脑通过 — hand-off 是平级接力,完全不进 spawn-guards 防御
    const r1 = applySpawnGuards(caller('lead'), '/p1', 'codex-cli', { handOffMode: true });
    expect('ok' in r1).toBe(true);
    if ('ok' in r1) r1.fanOutSlot.release();
    const r2 = applySpawnGuards(caller('lead'), '/p2', 'codex-cli', { handOffMode: true });
    expect('ok' in r2).toBe(true);
    if ('ok' in r2) r2.fanOutSlot.release();
  });

  it('handOffMode=true → 不进 in-flight 计数表 + token 不消耗(§D4 + R1 MED-6 + R2 LOW-3)', () => {
    settingsState.mcpMaxFanOutPerParent = 5;
    settingsState.mcpSpawnRatePerMinute = 5;
    seedSession('lead');
    const initialInflight = inFlightChildren.get('lead');
    const initialTokenCount = spawnRateLimiter.currentCount;
    const r = applySpawnGuards(caller('lead'), '/p1', 'codex-cli', { handOffMode: true });
    expect('ok' in r).toBe(true);
    if ('ok' in r) {
      // hand-off 路径不调 inFlightChildren.inc(没进计数表)
      expect(inFlightChildren.get('lead')).toBe(initialInflight);
      // hand-off 路径 && 短路 → tryConsume 不调 → token 不消耗
      expect(spawnRateLimiter.currentCount).toBe(initialTokenCount);
      r.fanOutSlot.release();
      // release 后仍是 0(因没 inc 过 dec 也是 no-op)
      expect(inFlightChildren.get('lead')).toBe(initialInflight);
    }
  });

  it('handOffMode=false(默认)→ depth check 仍 enforce(普通 spawn 不受 handOffMode 影响)', () => {
    seedSession('lead', { spawnDepth: 3 });
    const r = applySpawnGuards(caller('lead'), '/elsewhere', 'codex-cli', { handOffMode: false });
    expect('isError' in r).toBe(true);
    if ('isError' in r) {
      const data = JSON.parse(r.content[0].text);
      expect(data.error).toMatch(/spawn depth 3 >= max 3/);
    }
  });
});

describe('applySpawnGuards — spawn-rate 滑动窗口', () => {
  it('小于 limit 全过', () => {
    settingsState.mcpSpawnRatePerMinute = 3;
    seedSession('lead');
    for (let i = 0; i < 3; i++) {
      const r = applySpawnGuards(caller('lead'), `/p${i}`, 'codex-cli');
      expect('ok' in r).toBe(true);
      if ('ok' in r) r.fanOutSlot.release();
    }
  });

  it('超 limit → deny + retry hint', () => {
    settingsState.mcpSpawnRatePerMinute = 2;
    seedSession('lead');
    applySpawnGuards(caller('lead'), '/p1', 'codex-cli');
    applySpawnGuards(caller('lead'), '/p2', 'codex-cli');
    const r = applySpawnGuards(caller('lead'), '/p3', 'codex-cli');
    expect('isError' in r).toBe(true);
    if ('isError' in r) {
      const data = JSON.parse(r.content[0].text);
      expect(data.error).toMatch(/spawn rate exceeded: 2\/min/);
      expect(data.hint).toMatch(/Wait/);
    }
  });
});

describe('applySpawnGuards — fan-out', () => {
  it('children >= max → deny', () => {
    settingsState.mcpMaxFanOutPerParent = 2;
    seedSession('lead');
    seedSession('c1', { spawnedBy: 'lead', lifecycle: 'active' });
    seedSession('c2', { spawnedBy: 'lead', lifecycle: 'active' });
    const r = applySpawnGuards(caller('lead'), '/elsewhere', 'codex-cli');
    expect('isError' in r).toBe(true);
    if ('isError' in r) {
      const data = JSON.parse(r.content[0].text);
      expect(data.error).toMatch(/fan-out 2 reached/);
    }
  });

  it('in-flight 计入 effective fan-out（race protection）', () => {
    settingsState.mcpMaxFanOutPerParent = 2;
    seedSession('lead');
    seedSession('c1', { spawnedBy: 'lead', lifecycle: 'active' });
    // 第一次通过 → in-flight = 1（DB child + 1 in-flight = 2，下次再 spawn 触顶）
    const r1 = applySpawnGuards(caller('lead'), '/p1', 'codex-cli');
    expect('ok' in r1).toBe(true);
    // 第二次因 in-flight + DB child = 2 触顶
    const r2 = applySpawnGuards(caller('lead'), '/p2', 'codex-cli');
    expect('isError' in r2).toBe(true);
    if ('ok' in r1) r1.fanOutSlot.release();
    // release 后 in-flight = 0，第三次又能通过（DB child 仍 1，inflight 0，effective+1=2 ≤ 2 不 deny）
    const r3 = applySpawnGuards(caller('lead'), '/p3', 'codex-cli');
    expect('ok' in r3).toBe(true);
  });

  it('release 幂等', () => {
    settingsState.mcpMaxFanOutPerParent = 1;
    seedSession('lead');
    const r = applySpawnGuards(caller('lead'), '/p1', 'codex-cli');
    expect('ok' in r).toBe(true);
    if ('ok' in r) {
      r.fanOutSlot.release();
      r.fanOutSlot.release(); // 第二次不应继续 dec
    }
    expect(inFlightChildren.get('lead')).toBe(0);
  });

  // REVIEW_28 reviewer-codex MED-1 修法验证：fan-out deny 不消耗 spawn-rate token，
  // 防止已达 fan-out 上限的 lead spam spawn_session 把 app-wide token 拒掉给别的 lead。
  it('fan-out deny 不消耗 spawn-rate token（防饥饿）', () => {
    settingsState.mcpMaxFanOutPerParent = 1;
    settingsState.mcpSpawnRatePerMinute = 3;
    seedSession('greedy');
    seedSession('greedy-c1', { spawnedBy: 'greedy', lifecycle: 'active' });
    // greedy 已达 fan-out=1，连 spam 5 次 spawn 全被 fan-out deny
    for (let i = 0; i < 5; i++) {
      const r = applySpawnGuards(caller('greedy'), `/p${i}`, 'codex-cli');
      expect('isError' in r).toBe(true);
    }
    // spawn-rate token 应该一个都没消耗
    expect(spawnRateLimiter.currentCount).toBe(0);
    // 别的 lead 还能正常用 3 次 quota
    seedSession('honest');
    for (let i = 0; i < 3; i++) {
      const r = applySpawnGuards(caller('honest'), `/h${i}`, 'codex-cli');
      expect('ok' in r).toBe(true);
      if ('ok' in r) r.fanOutSlot.release();
    }
  });
});

// REVIEW_85 LOW-2 (reviewer-codex): 滑动窗口 exact-boundary off-by-one。
// prune 用 `<= threshold`(修前 `<`)让 now === oldest + windowMs 时 oldest 被裁,与 retryAfterMs
// 边界返 0 语义一致 — 修前「retry after 0ms 但立即 retry 仍失败」。
describe('RateLimiter — exact-boundary off-by-one (LOW-2)', () => {
  it('now === oldest + windowMs 时 retryAfterMs=0 且 tryConsume 立即成功（不再差 1ms）', () => {
    const rl = new RateLimiter(1, 60_000);
    // t=0 消耗满 quota（max=1）
    expect(rl.tryConsume(0)).toBe(true);
    // t=59999（窗口内）仍被拒，retryAfterMs=1
    expect(rl.tryConsume(59_999)).toBe(false);
    expect(rl.retryAfterMs(59_999)).toBe(1);
    // t=60000（exact boundary）：retryAfterMs=0 且 tryConsume 必须立即成功
    expect(rl.retryAfterMs(60_000)).toBe(0);
    expect(rl.tryConsume(60_000)).toBe(true);
  });

  it('修前回归断言：旧 `<` 实现会在 boundary 多拒 1ms（本测试守门 prune 用 <=）', () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.tryConsume(0)).toBe(true);
    expect(rl.tryConsume(500)).toBe(true);
    // 满 quota=2。t=1000 时 oldest(0)恰好出窗 → 必须能再 consume
    expect(rl.retryAfterMs(1000)).toBe(0);
    expect(rl.tryConsume(1000)).toBe(true);
  });
});
