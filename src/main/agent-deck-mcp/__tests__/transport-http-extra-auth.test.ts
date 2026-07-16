/**
 * HTTP transport `callerSessionIdOverride` lambda 单测（plan codex-handoff-team-alignment-20260518
 * P2 Step 2.10 / TC4-4b → plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 1.1b 重写）。
 *
 * **本次重写目标（plan §Phase 1.1b / D6 export production lambda）**：
 * 旧版用 inline copy 的 `httpCallerSessionIdOverride` lambda（`?? null` 老合约），合约会随
 * production 修法漂移（H4 教训 — REVIEW_47 §A1-HIGH-1）。本轮重写改为 import production
 * `resolveCallerSidForReadOnly`（plan §Phase 1.1a commit `034efea` 已 export），test 调真实
 * 代码，杜绝合约漂移 bug。
 *
 * 合约（B-HIGH-1 (C) 修法 (c)，详 transport-http.ts:73 production lambda JSDoc）：
 * - `authInfo.fallbackToGlobal === true` → 返回 EXTERNAL_CALLER_SENTINEL（防 spoofing）
 * - `authInfo.resolvedSid` 非空 → 返回该 sid（per-session authn 通过路径）
 * - 缺 authInfo / resolvedSid / extra → 返回 EXTERNAL_CALLER_SENTINEL（兜底防 spoofing）
 *
 * 旧合约 lambda 返 null + caller 走 makeCallerContext fallback `__external__` 的链路被
 * production 短路（lambda 直接返 sentinel），所以 TC4b 集成测试一并改写为「lambda 直接返
 * sentinel → makeCallerContext 用 sentinel → 写 tool deny」单段链路（plan §Phase 1.1b
 * 断言 3 分支铁证 + B-HIGH-1 反驳轮场景 1:1 重写在另文件 spoofing-attack-paths.test.ts /
 * Phase 1.1c）。
 */

import { describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

// helpers.ts 通过 `import { sessionRepo } from '@main/store/session-repo'` 间接拉 electron
// （sessionRepo → store/index → electron app paths）。本测试不需要真实 sessionRepo 行为
// （只用 makeCallerContext / denyExternalIfNotAllowed 两个纯函数 helper），mock 让 import
// 链路绕开 electron load。vi.mock 由 vitest hoist 到所有 import 之前生效。
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));

import {
  describeMcpHttpRequest,
  mcpSlowRequestThresholdMs,
  resolveCallerSidForReadOnly,
} from '../transport-http';
import { makeCallerContext, denyExternalIfNotAllowed } from '../tools/helpers';
import { EXTERNAL_CALLER_SENTINEL, type McpAuthInfo } from '../types';

describe('resolveCallerSidForReadOnly (production lambda) — 3 分支合约', () => {
  it('TC4 per-session authn 通过 → 返回 resolvedSid（mcpSessionTokenMap.get 反查命中）', () => {
    // HookServer.checkMcpAuth 反查 mcpSessionTokenMap 命中 → 写 extra.authInfo
    // 模拟 codex teammate 子进程 envOverride 注入 per-session token → CLI MCP client
    // Bearer header → HookServer 反查命中 sid='codex-teammate-1'
    const extra = {
      authInfo: { resolvedSid: 'codex-teammate-1', fallbackToGlobal: false } satisfies McpAuthInfo,
    };
    expect(resolveCallerSidForReadOnly(extra)).toBe('codex-teammate-1');
  });

  it('TC4b fallbackToGlobal=true → 返回 SENTINEL（防 spoofing — B-HIGH-1 (C) 修法 (c)）', () => {
    // HookServer.checkMcpAuth 反查 per-session map 不命中但等于全局 mcpServerToken → 写
    // extra.authInfo.resolvedSid=null + fallbackToGlobal=true。production lambda **直接**
    // 返 SENTINEL（旧版返 null 让 spoofing 路径有可乘之机；新版从源头切断）。
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    expect(resolveCallerSidForReadOnly(extra)).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('边角 extra=undefined → 返回 SENTINEL（in-process 不走 lambda；defensive 兜底）', () => {
    expect(resolveCallerSidForReadOnly(undefined)).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('边角 extra={} 无 authInfo → 返回 SENTINEL（HookServer 应已 401 拦截; defensive 兜底）', () => {
    expect(resolveCallerSidForReadOnly({})).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('边角 extra.authInfo 缺 resolvedSid 字段 → 返回 SENTINEL（fallback 二档兜底）', () => {
    expect(resolveCallerSidForReadOnly({ authInfo: {} })).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('防 spoofing：fallbackToGlobal=true + 同时塞 resolvedSid 攻击向量 → 仍返 SENTINEL', () => {
    // 攻击者伪造 authInfo 同时塞 fallbackToGlobal=true（global token 路径）+ resolvedSid（伪 sid）
    // 想以伪 sid 身份调写工具。production lambda 早 return SENTINEL，不让 resolvedSid 兜底路径有
    // 机会。fallbackToGlobal 优先级高于 resolvedSid（防 spoofing 兜底层）。
    const extra = {
      authInfo: {
        resolvedSid: 'attacker-forged-sid',
        fallbackToGlobal: true,
      } satisfies McpAuthInfo,
    };
    expect(resolveCallerSidForReadOnly(extra)).toBe(EXTERNAL_CALLER_SENTINEL);
  });
});

describe('describeMcpHttpRequest', () => {
  it('extracts the tool name without retaining tool arguments', () => {
    expect(
      describeMcpHttpRequest({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'send_message', arguments: { text: 'sensitive body' } },
      }),
    ).toEqual({ rpcMethod: 'tools/call', toolName: 'send_message' });
  });

  it('labels protocol, batch, and malformed requests safely', () => {
    expect(describeMcpHttpRequest({ method: 'initialize', params: {} })).toEqual({
      rpcMethod: 'initialize',
      toolName: null,
    });
    expect(describeMcpHttpRequest([])).toEqual({ rpcMethod: 'batch', toolName: null });
    expect(describeMcpHttpRequest('bad')).toEqual({ rpcMethod: 'unknown', toolName: null });
  });
});

describe('MCP slow-request thresholds', () => {
  it('does not classify user-gated presentation waits as server latency', () => {
    expect(mcpSlowRequestThresholdMs('present_plan')).toBe(Number.POSITIVE_INFINITY);
    expect(mcpSlowRequestThresholdMs('present_diff')).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps ordinary calls sensitive while allowing provider startup work', () => {
    expect(mcpSlowRequestThresholdMs('send_message')).toBe(500);
    expect(mcpSlowRequestThresholdMs(null)).toBe(500);
    expect(mcpSlowRequestThresholdMs('spawn_session')).toBe(60_000);
    expect(mcpSlowRequestThresholdMs('hand_off_session')).toBe(180_000);
  });
});

describe('TC4b integration: production lambda → makeCallerContext → 写 tool deny', () => {
  it('global fallback → lambda 返 SENTINEL → makeCallerContext 用 __external__', () => {
    // 模拟 tools/index.ts makeCtx 逻辑（plan §Phase 1.1b 简化后流程）：
    //   const overridden = callerSessionIdOverride?.(extra) ?? null;
    //   const callerSid = overridden ?? args.callerSessionId;
    //   return { caller: makeCallerContext(callerSid, args.parentSessionId, transport) };
    //
    // 新合约 lambda 返 SENTINEL（不是 null），直接进 makeCallerContext，callerSid='__external__'。
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    const overridden = resolveCallerSidForReadOnly(extra);
    expect(overridden).toBe(EXTERNAL_CALLER_SENTINEL);

    const args: { callerSessionId?: string } = {}; // external caller 不传 callerSessionId
    const callerSid = overridden ?? args.callerSessionId;
    const ctx = makeCallerContext(callerSid, undefined, 'http');

    // SENTINEL 直传 makeCallerContext，callerSessionId 仍为 __external__
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('spoofing 兜底：fallbackToGlobal=true + args 塞伪 sid → lambda 优先 SENTINEL → 写 tool deny', () => {
    // 攻击场景（B-HIGH-1 反驳轮）：global token caller 传 args.callerSessionId='active-victim-sid'
    // 试图以 victim 身份调 spawn_session。production lambda 早 return SENTINEL **优先于** args
    // fallback，让 deny 命中（不会因为 lambda 返 null 让 args 字段 escape 到 spoof 路径）。
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    const overridden = resolveCallerSidForReadOnly(extra);
    const args = { callerSessionId: 'active-victim-sid' };
    // **关键**：overridden = SENTINEL (truthy)，?? 短路返 SENTINEL，args 伪 sid 不生效
    const callerSid = overridden ?? args.callerSessionId;
    expect(callerSid).toBe(EXTERNAL_CALLER_SENTINEL);

    const ctx = makeCallerContext(callerSid, undefined, 'http');
    const denial = denyExternalIfNotAllowed('spawn_session', ctx);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    const textJson = JSON.parse(denial!.content[0].text);
    expect(textJson.error).toMatch(/spawn_session not allowed for external caller/);
  });

  it('per-session 合法路径：lambda 返 resolvedSid + args 塞伪 sid → resolvedSid 优先', () => {
    // codex teammate 真正 callerSessionId 由 HookServer.checkMcpAuth 反查 token 解析,
    // 即使 codex agent 在 args.callerSessionId 伪造一个 fake sid,lambda 返的 resolvedSid
    // 优先（makeCtx: `overridden ?? args.callerSessionId` — overridden 非 null 短路 args）。
    const extra = {
      authInfo: { resolvedSid: 'real-sid', fallbackToGlobal: false } satisfies McpAuthInfo,
    };
    const overridden = resolveCallerSidForReadOnly(extra);
    const args = { callerSessionId: 'fake-injected-sid' };
    const callerSid = overridden ?? args.callerSessionId;
    expect(callerSid).toBe('real-sid'); // 不是 'fake-injected-sid'
  });

  it('makeCallerContext __external__ + list_sessions（read-only） → 不拒绝（read-only 例外）', () => {
    // EXTERNAL_CALLER_ALLOWED.list_sessions=true（read-only 允许 external）
    const ctx = makeCallerContext(EXTERNAL_CALLER_SENTINEL, undefined, 'http');
    const denial = denyExternalIfNotAllowed('list_sessions', ctx);
    expect(denial).toBeNull();
  });
});
