/**
 * `denyExternalIfNotAllowed` unit test 5 场景（plan deep-review-batch-a1-b-fixes-20260519
 * §Phase 1 Step 1.1a → plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 1.1d 落地）。
 *
 * **本测试 vs `spoofing-attack-paths.test.ts` 角色边界**：
 * - `spoofing-attack-paths.test.ts`（Phase 1.1c）：**端到端集成** — 走 4 段防御链
 *   （transport override + makeCtx 短路 + makeCallerContext + denyExternalIfNotAllowed）
 *   验证攻击路径完整阻断 / 合法路径完整通过
 * - **本测试**：**纯 unit** — 直接构造 `CallerContext` + 调 `denyExternalIfNotAllowed`，
 *   只测函数自身行为合约，不绑 transport-http / transport-stdio override 实现细节
 *
 * 5 场景（与 spoofing-attack-paths 集成场景同款，但只测 deny 函数：在 caller 被前面 3 段
 * 防御处理后 / 漏改场景下，deny 函数兜底是否正确）：
 *
 * - (1) in-process honest baseline → 任意 sid + 写 tool → ALLOW
 * - (2) stdio + sentinel callerSid + 写 tool → DENY（sentinel 检测命中）
 * - (3) HTTP global token fallback → callerSid 被前置 sentinel 化 + 写 tool → DENY
 * - (4) HTTP per-session authn 通过 → callerSid = real sid + 写 tool → ALLOW
 * - (5) HTTP fallbackToGlobal=true 攻击向量 → 前置 sentinel 化 + 写 tool → DENY
 *
 * 额外 invariant violation 兜底（B-HIGH-1 修法 (a)）：
 * - stdio + 非 sentinel callerSid（transport 层漏改场景）+ 写 tool → DENY
 * - HTTP + 非 sentinel callerSid（per-session 合法路径）+ 写 tool → ALLOW（不误杀）
 *
 * read-only 例外（EXTERNAL_CALLER_ALLOWED.list_sessions=true / get_session=true）：
 * - 任意 transport + sentinel + 读 tool → ALLOW
 */

import { describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

// helpers.ts 间接拉 electron via session-repo；mock 绕开
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));

import { denyExternalIfNotAllowed } from '../tools/helpers';
import {
  EXTERNAL_CALLER_SENTINEL,
  type CallerContext,
} from '../types';

/** 直接构造 CallerContext — 不走 makeCallerContext / transport override 路径 */
function ctx(
  callerSessionId: string,
  transport: CallerContext['transport'],
): CallerContext {
  return { callerSessionId, transport };
}

describe('denyExternalIfNotAllowed — 5 场景 unit test', () => {
  // ============================================================================
  // (1) in-process honest baseline → ALLOW
  // ============================================================================
  it('(1) in-process honest baseline (任意 sid 写 tool) → null（不 DENY）', () => {
    // in-process closure 永远 override 真实 sid，callerSessionId 必然非 sentinel；
    // deny 函数仅 sentinel 触发第一条 if 与 stdio invariant 触发第二条 if。
    // in-process 完全跳过两条 deny 路径 → return null。
    const c = ctx('real-in-process-owner-sid', 'in-process');
    expect(denyExternalIfNotAllowed('spawn_session', c)).toBeNull();
    expect(denyExternalIfNotAllowed('send_message', c)).toBeNull();
    expect(denyExternalIfNotAllowed('archive_plan', c)).toBeNull();
    expect(denyExternalIfNotAllowed('hand_off_session', c)).toBeNull();
  });

  // ============================================================================
  // (2) stdio + sentinel + 写 tool → DENY
  // ============================================================================
  it('(2) stdio + sentinel callerSid + 写 tool → DENY（external sentinel 检测）', () => {
    // 修法后 transport-stdio.ts:85 永远 force sentinel；本 case 模拟 transport 层正确写
    // sentinel 后到 helpers 这层，函数应该正常 DENY 写 tool。
    const c = ctx(EXTERNAL_CALLER_SENTINEL, 'stdio');
    const denial = denyExternalIfNotAllowed('spawn_session', c);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    const denialJson = JSON.parse(denial!.content[0].text);
    expect(denialJson.error).toMatch(/spawn_session not allowed for external caller/);
    expect(denialJson.hint).toMatch(/External MCP clients can only call read-only tools/);
  });

  // ============================================================================
  // (3) HTTP global token fallback → 前置 sentinel 化 + 写 tool → DENY
  // ============================================================================
  it('(3) HTTP global token fallback → callerSid 被 transport 前置 sentinel + 写 tool → DENY', () => {
    // transport-http.ts resolveCallerSidForReadOnly 见 fallbackToGlobal=true 直接 force
    // sentinel；本 case 模拟那段防御做完后到 helpers 这层。
    const c = ctx(EXTERNAL_CALLER_SENTINEL, 'http');
    const denial = denyExternalIfNotAllowed('spawn_session', c);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
  });

  // ============================================================================
  // (4) HTTP per-session authn → callerSid = real sid + 写 tool → ALLOW
  // ============================================================================
  it('(4) HTTP per-session authn 通过 → callerSid="codex-teammate-1" + 写 tool → ALLOW', () => {
    // 合法 caller 路径：mcpSessionTokenMap 反查命中 → resolvedSid = real sid → callerSid
    // 非 sentinel。helpers 这层的两条 deny 路径都不命中 → return null（合法通过）。
    // 注：后续 validateExternalCaller（另一个 helper）会反查 sessionRepo 看 sid 是否真存在
    // active 会话，本 case 只测 deny 这层。
    const c = ctx('codex-teammate-1', 'http');
    expect(denyExternalIfNotAllowed('spawn_session', c)).toBeNull();
    expect(denyExternalIfNotAllowed('send_message', c)).toBeNull();
    expect(denyExternalIfNotAllowed('archive_plan', c)).toBeNull();
    expect(denyExternalIfNotAllowed('hand_off_session', c)).toBeNull();
  });

  // ============================================================================
  // (5) HTTP fallbackToGlobal=true 攻击向量 → 前置 sentinel 化 + 写 tool → DENY
  // ============================================================================
  it('(5) HTTP fallbackToGlobal=true 攻击向量 → callerSid 已被 transport 前置 sentinel → DENY', () => {
    // 与 (3) 相同场景，强调即使攻击者尝试在 authInfo 同时塞 resolvedSid + fallbackToGlobal=true，
    // transport-http 优先返 sentinel，到 helpers 这层 callerSid 已 sentinel → DENY。
    const c = ctx(EXTERNAL_CALLER_SENTINEL, 'http');
    expect(denyExternalIfNotAllowed('spawn_session', c)?.isError).toBe(true);
    expect(denyExternalIfNotAllowed('send_message', c)?.isError).toBe(true);
    expect(denyExternalIfNotAllowed('shutdown_session', c)?.isError).toBe(true);
    expect(denyExternalIfNotAllowed('archive_plan', c)?.isError).toBe(true);
    expect(denyExternalIfNotAllowed('hand_off_session', c)?.isError).toBe(true);
    expect(denyExternalIfNotAllowed('enter_worktree', c)?.isError).toBe(true);
    expect(denyExternalIfNotAllowed('exit_worktree', c)?.isError).toBe(true);
  });
});

describe('denyExternalIfNotAllowed — read-only tool 例外（EXTERNAL_CALLER_ALLOWED 表）', () => {
  it('sentinel + list_sessions（read-only） → null（不 DENY）', () => {
    // EXTERNAL_CALLER_ALLOWED.list_sessions=true → 任意 transport + sentinel callerSid 都允许
    expect(denyExternalIfNotAllowed('list_sessions', ctx(EXTERNAL_CALLER_SENTINEL, 'stdio'))).toBeNull();
    expect(denyExternalIfNotAllowed('list_sessions', ctx(EXTERNAL_CALLER_SENTINEL, 'http'))).toBeNull();
    expect(denyExternalIfNotAllowed('list_sessions', ctx(EXTERNAL_CALLER_SENTINEL, 'in-process'))).toBeNull();
  });

  it('sentinel + get_session（read-only） → null（不 DENY）', () => {
    expect(denyExternalIfNotAllowed('get_session', ctx(EXTERNAL_CALLER_SENTINEL, 'stdio'))).toBeNull();
    expect(denyExternalIfNotAllowed('get_session', ctx(EXTERNAL_CALLER_SENTINEL, 'http'))).toBeNull();
  });
});

describe('denyExternalIfNotAllowed — stdio invariant violation 兜底（B-HIGH-1 (C) 修法 (a)）', () => {
  it('stdio + 非 sentinel callerSid + 写 tool → DENY（invariant violation 兜底守门）', () => {
    // 假设 transport-stdio.ts:85 漏改回 `callerSessionIdOverride: null`，攻击者 args.callerSessionId
    // escape 进 makeCtx → callerSid='attacker-sid'。helpers 这层兜底守门：
    // transport='stdio' + callerSessionId 非 sentinel → invariant violation DENY + console.error
    const c = ctx('attacker-sid', 'stdio');
    const denial = denyExternalIfNotAllowed('spawn_session', c);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    const denialJson = JSON.parse(denial!.content[0].text);
    expect(denialJson.error).toMatch(/not allowed for stdio transport with non-sentinel/);
    expect(denialJson.hint).toMatch(/transport-stdio.ts.*callerSessionIdOverride/);
  });

  it('stdio + 非 sentinel callerSid + read-only tool → null（read-only 例外不命中 invariant 守门）', () => {
    // helpers.ts:90-93 invariant 守门条件含 `!EXTERNAL_CALLER_ALLOWED[toolName]`，read-only
    // tool 仍允许（即使 stdio invariant 漏改也不阻拦只读访问，安全降级）。
    const c = ctx('attacker-sid', 'stdio');
    expect(denyExternalIfNotAllowed('list_sessions', c)).toBeNull();
    expect(denyExternalIfNotAllowed('get_session', c)).toBeNull();
  });

  it('HTTP + 非 sentinel callerSid + 写 tool → null（per-session real sid 合法路径，不误杀）', () => {
    // 关键 plan-review v2 codex NEW-H1 反馈实证：旧版条件 `transport !== 'in-process' &&
    // callerSid !== sentinel` 会误杀 HTTP per-session real sid。修订仅针对 stdio。
    const c = ctx('codex-teammate-real-sid', 'http');
    expect(denyExternalIfNotAllowed('spawn_session', c)).toBeNull();
    expect(denyExternalIfNotAllowed('send_message', c)).toBeNull();
    expect(denyExternalIfNotAllowed('archive_plan', c)).toBeNull();
  });

  it('in-process + 非 sentinel callerSid（正常 closure override）+ 写 tool → null（in-process 不受守门约束）', () => {
    // in-process closure 永远 override 真实 sid；helpers 完全跳过两条 deny 路径。
    const c = ctx('sdk-owner-sid-456', 'in-process');
    expect(denyExternalIfNotAllowed('spawn_session', c)).toBeNull();
    expect(denyExternalIfNotAllowed('send_message', c)).toBeNull();
  });
});

describe('denyExternalIfNotAllowed — core write tools × 3 transport 全覆盖矩阵', () => {
  // 矩阵覆盖：sentinel × 3 transport × core write tools 全 DENY
  // **R3 fix-7 (M1 reviewer-claude LOW)**: 加 'shutdown_baton_teammates' 第 8 个写 tool
  // (Phase 5.3 新增 mcp tool,types.ts EXTERNAL_CALLER_ALLOWED.shutdown_baton_teammates=false)
  const writeTools = [
    'spawn_session',
    'send_message',
    'present_plan',
    'present_diff',
    'shutdown_session',
    'archive_plan',
    'hand_off_session',
    'enter_worktree',
    'exit_worktree',
    'shutdown_baton_teammates',
  ] as const;
  const transports: CallerContext['transport'][] = ['in-process', 'http', 'stdio'];

  for (const t of transports) {
    for (const tool of writeTools) {
      it(`sentinel + transport=${t} + ${tool} → ${t === 'in-process' ? 'null（in-process 跳过 deny）' : 'DENY'}`, () => {
        const c = ctx(EXTERNAL_CALLER_SENTINEL, t);
        const denial = denyExternalIfNotAllowed(tool, c);
        if (t === 'in-process') {
          // in-process 不会出现 sentinel callerSid（closure override 永远 truthy real sid）；
          // 但本 case 防御性测：即使 sentinel 进 in-process（理论不应发生），sentinel 检测仍生效 → DENY。
          // 即所有 transport 下 sentinel + 写 tool 都 DENY（无 transport 例外）。
          expect(denial).not.toBeNull();
          expect(denial?.isError).toBe(true);
        } else {
          expect(denial).not.toBeNull();
          expect(denial?.isError).toBe(true);
        }
      });
    }
  }
});
