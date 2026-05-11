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
    teamName: null,
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

  it('cycle deny 路径自动 release in-flight', () => {
    settingsState.mcpMaxFanOutPerParent = 2;
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
    // 第一次同 cwd 同 adapter cycle → deny + 内部已 release
    const r = applySpawnGuards(caller('lead'), '/repo', 'claude-code');
    expect('isError' in r).toBe(true);
    expect(inFlightChildren.get('lead')).toBe(0); // 没残留
  });
});

describe('applySpawnGuards — cwd cycle 整链回溯', () => {
  it('caller 自身同 cwd 同 adapter → deny', () => {
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
    const r = applySpawnGuards(caller('lead'), '/repo', 'claude-code');
    expect('isError' in r).toBe(true);
    if ('isError' in r) {
      const data = JSON.parse(r.content[0].text);
      expect(data.error).toMatch(/spawn cycle detected/);
    }
  });

  it('祖父同 cwd 同 adapter → deny（整链）', () => {
    seedSession('grandpa', { cwd: '/repo', agentId: 'claude-code', spawnDepth: 0 });
    seedSession('parent', { cwd: '/sub', agentId: 'codex-cli', spawnedBy: 'grandpa', spawnDepth: 1 });
    seedSession('caller', { cwd: '/other', agentId: 'codex-cli', spawnedBy: 'parent', spawnDepth: 2 });
    settingsState.mcpMaxSpawnDepth = 10; // 不让 depth 先 deny
    // 即将 spawn 在 /repo + claude-code，祖父正好这俩 → 应被 cycle 检测拦下
    const r = applySpawnGuards(caller('caller'), '/repo', 'claude-code');
    expect('isError' in r).toBe(true);
    if ('isError' in r) {
      const data = JSON.parse(r.content[0].text);
      expect(data.error).toMatch(/ancestor cwd cycle detected/);
    }
  });

  it('不同 adapter 不算 cycle（异构 reviewer pair 合法）', () => {
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
    const r = applySpawnGuards(caller('lead'), '/repo', 'codex-cli');
    expect('ok' in r).toBe(true);
    if ('ok' in r) r.fanOutSlot.release();
  });

  it('caller 不在 sessionRepo（in-process 闭包伪 id）→ 不阻塞', () => {
    // caller 'unknown-id' 不在 sessionStore，cycle 检测放行
    const r = applySpawnGuards(caller('unknown-id'), '/repo', 'claude-code');
    expect('ok' in r).toBe(true);
    if ('ok' in r) r.fanOutSlot.release();
  });
});
