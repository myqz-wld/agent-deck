/**
 * HTTP transport `callerSessionIdOverride` lambda 单测（plan codex-handoff-team-alignment-20260518
 * P2 Step 2.10 / TC4-4b）。
 *
 * 测试目标：transport-http.ts:92-98 内嵌的 `callerSessionIdOverride` lambda 在不同
 * `extra.authInfo` 输入下的反查行为，以及与 `makeCallerContext` 的集成（lambda 返 null →
 * fallback 到 args.caller_session_id → 缺省 / `__external__` 让 deny tool 命中）。
 *
 * 覆盖：
 * - TC4: HTTP transport extra.authInfo.resolvedSid 正确反查（per-session 命中）
 * - TC4b: fallback global token 时 resolvedSid=null + fallbackToGlobal=true →
 *   makeCallerContext fallback args.caller_session_id → 缺省即 `__external__`
 *   → spawn_session 被 EXTERNAL_CALLER_ALLOWED 拦截（D1 §(b) 测试）
 *
 * 测试策略：lambda 本身是 transport-http.ts 文件内的纯函数（不导出），本测试**对齐
 * 契约**（inline 同款 lambda）+ 直接 unit-test 行为。这种契约测试既验证 lambda 简
 * 单的语义（authInfo?.resolvedSid ?? null），又验证下游 makeCallerContext / spawn_session
 * deny 的 integration。如果 transport-http.ts lambda body 改动，本测试 inline 复制需
 * 同步更新（强制 reviewer 看一眼契约是否还匹配）。
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

import { makeCallerContext, denyExternalIfNotAllowed } from '../tools/helpers';
import { EXTERNAL_CALLER_SENTINEL, type McpAuthInfo } from '../types';

/**
 * Inline copy of transport-http.ts:92-98 `callerSessionIdOverride` lambda contract.
 * 同步 transport-http.ts 改动时必须更新本契约（reviewer 单测看一眼对齐与否）。
 */
function httpCallerSessionIdOverride(extra?: unknown): string | null {
  const authInfo = (extra as { authInfo?: McpAuthInfo } | undefined)?.authInfo;
  return authInfo?.resolvedSid ?? null;
}

describe('transport-http callerSessionIdOverride lambda contract', () => {
  it('TC4: per-session 命中 → 返回 resolvedSid（mcpSessionTokenMap.get 反查命中场景）', () => {
    // HookServer.checkMcpAuth 反查 mcpSessionTokenMap 命中 → 写 extra.authInfo
    // 模拟 codex teammate 子进程 envOverride 注入 per-session token → CLI MCP client
    // Bearer header → HookServer 反查命中 sid='codex-teammate-1'
    const extra = {
      authInfo: { resolvedSid: 'codex-teammate-1', fallbackToGlobal: false } satisfies McpAuthInfo,
    };
    expect(httpCallerSessionIdOverride(extra)).toBe('codex-teammate-1');
  });

  it('TC4b lambda: fallback global token → resolvedSid=null + fallbackToGlobal=true → 返回 null', () => {
    // HookServer.checkMcpAuth 反查 per-session map 不命中但等于全局 mcpServerToken → 写
    // extra.authInfo.resolvedSid=null + fallbackToGlobal=true。lambda 返回 null,handler
    // makeCtx fallback args.caller_session_id（external caller 缺省即 `__external__`）。
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    expect(httpCallerSessionIdOverride(extra)).toBeNull();
  });

  it('TC4 边角: extra=undefined（in-process / stdio 路径不走 lambda 但理论可调） → 返回 null', () => {
    expect(httpCallerSessionIdOverride(undefined)).toBeNull();
  });

  it('TC4 边角: extra={} 无 authInfo → 返回 null（HookServer 应已 401 拦截; defensive）', () => {
    expect(httpCallerSessionIdOverride({})).toBeNull();
  });

  it('TC4 边角: extra.authInfo 缺 resolvedSid 字段 → 返回 null', () => {
    expect(httpCallerSessionIdOverride({ authInfo: {} })).toBeNull();
  });
});

describe('TC4b integration: lambda null → makeCallerContext fallback → __external__ → deny', () => {
  it('lambda 返 null + args.caller_session_id 缺省 → makeCallerContext 用 __external__ sentinel', () => {
    // 模拟 tools/index.ts makeCtx 逻辑（line 108-112）：
    //   const overridden = callerSessionIdOverride?.(extra) ?? null;
    //   const callerSid = overridden ?? args.caller_session_id;
    //   return { caller: makeCallerContext(callerSid, args.parent_session_id, transport) };
    //
    // 全局 fallback path: lambda 返 null + args.caller_session_id 未传 →
    // callerSid=undefined → makeCallerContext 用 EXTERNAL_CALLER_SENTINEL 补
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    const overridden = httpCallerSessionIdOverride(extra);
    expect(overridden).toBeNull();

    const args: { caller_session_id?: string } = {}; // external caller 不传 caller_session_id
    const callerSid = overridden ?? args.caller_session_id;
    const ctx = makeCallerContext(callerSid, undefined, 'http');

    // 缺省 caller → __external__ sentinel，下游 deny tool 命中
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('makeCallerContext __external__ + spawn_session → denyExternalIfNotAllowed 拒绝', () => {
    // 全局 fallback caller → `__external__` → spawn_session deny（EXTERNAL_CALLER_ALLOWED.spawn_session=false）
    const ctx = makeCallerContext(EXTERNAL_CALLER_SENTINEL, undefined, 'http');
    const denial = denyExternalIfNotAllowed('spawn_session', ctx);

    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    const textJson = JSON.parse(denial!.content[0].text);
    expect(textJson.error).toMatch(/spawn_session not allowed for external caller/);
  });

  it('makeCallerContext __external__ + list_sessions（read-only） → 不拒绝（read-only 例外）', () => {
    // EXTERNAL_CALLER_ALLOWED.list_sessions=true（read-only 允许 external）
    const ctx = makeCallerContext(EXTERNAL_CALLER_SENTINEL, undefined, 'http');
    const denial = denyExternalIfNotAllowed('list_sessions', ctx);
    expect(denial).toBeNull();
  });

  it('lambda 返 resolvedSid + args.caller_session_id 伪造 → resolvedSid 优先（防 prompt 注入）', () => {
    // codex teammate 真正 caller_session_id 由 HookServer.checkMcpAuth 反查 token 解析,
    // 即使 codex agent 在 args.caller_session_id 伪造一个 fake sid,lambda 返的 resolvedSid
    // 优先（makeCtx: `overridden ?? args.caller_session_id` — overridden 非 null 覆盖 args）
    const extra = {
      authInfo: { resolvedSid: 'real-sid', fallbackToGlobal: false } satisfies McpAuthInfo,
    };
    const overridden = httpCallerSessionIdOverride(extra);
    const args = { caller_session_id: 'fake-injected-sid' };
    const callerSid = overridden ?? args.caller_session_id;
    expect(callerSid).toBe('real-sid'); // 不是 'fake-injected-sid'
  });
});
