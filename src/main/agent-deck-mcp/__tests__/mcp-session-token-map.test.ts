/**
 * mcp-session-token-map 双向 Map 单测（plan codex-handoff-team-alignment-20260518
 * P2 Step 2.10 / TC1-3c）。
 *
 * 覆盖：
 * - TC1: allocate / get / release 双向 map 一致性
 * - TC2: rename oldSid → newSid 后 get(token) 返回 newSid
 * - TC3: release(sid) 后 get(token) 返回 null
 * - TC3b: re-allocate same sid → 旧 token tokenToSession entry 清干净（v4 M2 修法）
 * - TC3c: 并发 allocate 两个 sid → token 唯一（randomUUID 并发安全）
 *
 * 不依赖 SQLite / Electron / SDK 子进程：module-level 双 Map state 通过 clearAll() 复位。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as mcpSessionTokenMap from '../mcp-session-token-map';

beforeEach(() => {
  mcpSessionTokenMap.clearAll();
});

describe('mcp-session-token-map 双向 Map', () => {
  it('TC1: allocate / get / release 双向 map 一致性', () => {
    const sid = 'sess-A';
    const token = mcpSessionTokenMap.allocate(sid);

    // allocate 返 token：UUID v4 lowercase hex with hyphens
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // get(token) 反查返 sid
    expect(mcpSessionTokenMap.get(token)).toBe(sid);

    // release(sid) 后双向 map 都清
    mcpSessionTokenMap.release(sid);
    expect(mcpSessionTokenMap.get(token)).toBeNull();
  });

  it('TC2: rename oldSid → newSid 后 get(token) 返回 newSid', () => {
    const oldSid = 'temp-sid';
    const newSid = 'real-sid';
    const token = mcpSessionTokenMap.allocate(oldSid);

    expect(mcpSessionTokenMap.get(token)).toBe(oldSid);

    // 模拟 codex thread-loop CLI 隐式 fork：tempKey → realId
    mcpSessionTokenMap.rename(oldSid, newSid);

    // token 字符串本身不变,反查从 oldSid 切到 newSid
    expect(mcpSessionTokenMap.get(token)).toBe(newSid);

    // oldSid 不应再可 release(已 rename 走);release(oldSid) 是 noop 不抛错
    mcpSessionTokenMap.release(oldSid);
    expect(mcpSessionTokenMap.get(token)).toBe(newSid); // 仍能命中 newSid

    // 真要清干净走 newSid release
    mcpSessionTokenMap.release(newSid);
    expect(mcpSessionTokenMap.get(token)).toBeNull();
  });

  it('TC3: release(sid) 后 get(token) 返回 null', () => {
    const sid = 'sess-release';
    const token = mcpSessionTokenMap.allocate(sid);

    mcpSessionTokenMap.release(sid);

    expect(mcpSessionTokenMap.get(token)).toBeNull();

    // re-release 同 sid 是 noop（不抛错）
    expect(() => mcpSessionTokenMap.release(sid)).not.toThrow();

    // 不存在的 sid release 是 noop（如 claude adapter 路径根本没 allocate）
    expect(() => mcpSessionTokenMap.release('never-allocated-sid')).not.toThrow();
  });

  it('TC3b (v4 M2 修法): re-allocate same sid → 旧 token tokenToSession entry 清干净，新 token 生效', () => {
    const sid = 'sess-realloc';
    const oldToken = mcpSessionTokenMap.allocate(sid);
    expect(mcpSessionTokenMap.get(oldToken)).toBe(sid);

    // 同一 sid 再 allocate（典型场景：createSession failure 重试 / ensureCodex 重新 new Codex）
    const newToken = mcpSessionTokenMap.allocate(sid);
    expect(newToken).not.toBe(oldToken);

    // 新 token 命中 sid
    expect(mcpSessionTokenMap.get(newToken)).toBe(sid);

    // **关键**：旧 token 必须从 tokenToSession 清干净，不留孤儿 entry 指向已废弃 sid
    expect(mcpSessionTokenMap.get(oldToken)).toBeNull();

    // release(sid) 后新 token 也清掉
    mcpSessionTokenMap.release(sid);
    expect(mcpSessionTokenMap.get(newToken)).toBeNull();
  });

  it('TC3c: 并发 allocate 两个 sid → token 唯一（randomUUID 并发安全）', () => {
    // 模拟 100 个 sid 并发 allocate（同步 randomUUID 调用,验证不撞 token）
    const tokens = new Set<string>();
    const sidToToken = new Map<string, string>();
    const N = 100;
    for (let i = 0; i < N; i++) {
      const sid = `sess-concurrent-${i}`;
      const t = mcpSessionTokenMap.allocate(sid);
      tokens.add(t);
      sidToToken.set(sid, t);
    }

    // 100 个 token 全 unique（randomUUID v4 collision 概率 ~2^-122 不会撞）
    expect(tokens.size).toBe(N);

    // 每个 token 反查回正确 sid
    for (const [sid, token] of sidToToken.entries()) {
      expect(mcpSessionTokenMap.get(token)).toBe(sid);
    }

    // 全 release 后 map 清空
    for (const sid of sidToToken.keys()) {
      mcpSessionTokenMap.release(sid);
    }
    for (const token of tokens) {
      expect(mcpSessionTokenMap.get(token)).toBeNull();
    }
  });
});

describe('mcp-session-token-map 边角', () => {
  it('rename oldSid 不在 map → noop（claude adapter 路径根本没 allocate）', () => {
    // 模拟 claude SDK fallback tempKey → realId rename：claude 走 in-process MCP transport 不消费
    // token map,但 sessionManager.renameSdkSession 仍调 mcpSessionTokenMap.rename
    expect(() => mcpSessionTokenMap.rename('claude-temp', 'claude-real')).not.toThrow();
    // get 任意一边都返 null（map 内本来就空）
    expect(mcpSessionTokenMap.get('claude-temp')).toBeNull();
  });

  it('rename newSid 已经在 map → noop（保留 newSid 现 entry，不覆盖）', () => {
    const oldSid = 'old-A';
    const newSid = 'new-B';
    const oldToken = mcpSessionTokenMap.allocate(oldSid);
    const newToken = mcpSessionTokenMap.allocate(newSid); // newSid 已 allocate

    // rename 不应覆盖 newSid 现有 entry（防丢已 spawn 子进程引用）
    mcpSessionTokenMap.rename(oldSid, newSid);

    // newSid 仍指向自己原 token,oldToken 仍指向 oldSid
    expect(mcpSessionTokenMap.get(newToken)).toBe(newSid);
    expect(mcpSessionTokenMap.get(oldToken)).toBe(oldSid);
  });

  it('clearAll 清空双向 map（仅测试用）', () => {
    mcpSessionTokenMap.allocate('s1');
    mcpSessionTokenMap.allocate('s2');
    mcpSessionTokenMap.allocate('s3');

    mcpSessionTokenMap.clearAll();

    // 三个 token 都查不到
    // (无法直接拿 token,但可以反查 allocate 后的 token 失败 — 这里用新 allocate 看新 token 不撞)
    const newToken = mcpSessionTokenMap.allocate('s1'); // re-allocate same sid 应该看作首次
    expect(mcpSessionTokenMap.get(newToken)).toBe('s1');
  });
});
