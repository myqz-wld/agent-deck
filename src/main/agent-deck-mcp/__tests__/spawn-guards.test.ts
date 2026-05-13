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

const sessionStore = new Map<string, SessionRecord>();

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (id: string) => sessionStore.get(id) ?? null,
    getSpawnDepth: (id: string) => sessionStore.get(id)?.spawnDepth ?? 0,
    listAncestors: (id: string) => {
      const out: SessionRecord[] = [];
      let cursor = sessionStore.get(id);
      const visited = new Set<string>([id]);
      while (cursor && cursor.spawnedBy && !visited.has(cursor.spawnedBy)) {
        visited.add(cursor.spawnedBy);
        const parent = sessionStore.get(cursor.spawnedBy);
        if (!parent) break;
        out.push(parent);
        cursor = parent;
      }
      return out;
    },
    listChildren: (parentId: string) =>
      [...sessionStore.values()].filter(
        (s) => s.spawnedBy === parentId && s.lifecycle === 'active',
      ),
  },
}));

const settingsState = {
  mcpMaxSpawnDepth: 3,
  mcpMaxFanOutPerParent: 5,
  mcpSpawnRatePerMinute: 100,
};

vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    getAll: () => ({ ...settingsState }),
  },
}));

import { applySpawnGuards } from '../spawn-guards';
import { spawnRateLimiter, inFlightChildren } from '../rate-limiter';

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

  // CHANGELOG_98 / R2 deep review HIGH-1：K2 baton 接力跳 depth check（baton 单向交接
  // 不构成 fork-bomb 风险）。仅 depth check 跳，fan-out + rate 仍 enforce（防 spam baton）。
  it('batonMode=true → caller depth >= max 仍通过（跳过 depth check）', () => {
    seedSession('lead', { spawnDepth: 3 });
    const r = applySpawnGuards(caller('lead'), '/elsewhere', 'codex-cli', { batonMode: true });
    expect('ok' in r).toBe(true);
    if ('ok' in r) {
      // parentDepth 字段仍返回真实值（spawn handler 用它决定 setSpawnLink 是否 +1）
      expect(r.parentDepth).toBe(3);
      r.fanOutSlot.release();
    }
  });

  it('batonMode=true 但 fan-out 上限仍 enforce（防 baton race 多次接力）', () => {
    settingsState.mcpMaxFanOutPerParent = 1;
    seedSession('lead', { spawnDepth: 3 });
    seedSession('c1', { spawnedBy: 'lead', lifecycle: 'active' });
    const r = applySpawnGuards(caller('lead'), '/elsewhere', 'codex-cli', { batonMode: true });
    expect('isError' in r).toBe(true);
    if ('isError' in r) {
      const data = JSON.parse(r.content[0].text);
      expect(data.error).toMatch(/fan-out 1 reached/);
    }
  });

  it('batonMode=true 但 rate-limit 仍 enforce（防 spam K2 接力）', () => {
    settingsState.mcpSpawnRatePerMinute = 1;
    seedSession('lead', { spawnDepth: 5 });
    const r1 = applySpawnGuards(caller('lead'), '/p1', 'codex-cli', { batonMode: true });
    expect('ok' in r1).toBe(true);
    if ('ok' in r1) r1.fanOutSlot.release();
    const r2 = applySpawnGuards(caller('lead'), '/p2', 'codex-cli', { batonMode: true });
    expect('isError' in r2).toBe(true);
    if ('isError' in r2) {
      const data = JSON.parse(r2.content[0].text);
      expect(data.error).toMatch(/spawn rate exceeded: 1\/min/);
    }
  });

  it('batonMode=false（默认）→ depth check 仍 enforce（普通 spawn 不受 batonMode 影响）', () => {
    seedSession('lead', { spawnDepth: 3 });
    const r = applySpawnGuards(caller('lead'), '/elsewhere', 'codex-cli', { batonMode: false });
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
