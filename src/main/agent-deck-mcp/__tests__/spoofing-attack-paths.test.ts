/**
 * B-HIGH-1 caller spoofing 4 段防御链端到端集成测试（plan deep-review-batch-a1-b-fixes-20260519
 * §Phase 1 Step 1.1c → plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 1.1c 落地）。
 *
 * **背景**：B-HIGH-1（REVIEW_46） — codex 提 + claude 反驳 mini-test 实证：旧版 HTTP global
 * token caller + stdio caller 都能通过 `args.callerSessionId='victim-active-sid'` 伪装
 * 任意活动会话身份调写工具（spawn_session / send_message / shutdown_session / archive_plan
 * / hand_off_session）。修法 (C) 两层守门：
 * 1. transport-http.ts `resolveCallerSidForReadOnly(extra)`：fallbackToGlobal=true 时 force
 *    sentinel；per-session authn 通过时 resolvedSid 真 sid；其他兜底 sentinel
 * 2. transport-stdio.ts `callerSessionIdOverride: () => EXTERNAL_CALLER_SENTINEL` 永远 sentinel
 * 3. tools/index.ts `makeCtx` `overridden ?? args.callerSessionId` — overridden 非 null
 *    短路 args（不让伪造字段 escape）
 * 4. tools/helpers.ts `denyExternalIfNotAllowed`：sentinel + 写 tool 不允许 external → DENY；
 *    stdio + 非 sentinel callerSid（应该不可能，invariant violation 兜底）→ DENY
 *
 * **本测试 1:1 重写 reviewer-claude 反驳轮 mini-test 4 攻击向量**：
 * - (A) stdio + spoofed args.callerSessionId → 4 段防御链组合 → DENY
 * - (B) HTTP global token + spoofed args.callerSessionId → DENY
 * - (C) HTTP per-session authn + real resolvedSid（合法路径） → ALLOW（不 DENY；合法 caller）
 * - (D) HTTP fallbackToGlobal=true + 攻击者塞 resolvedSid='attacker-sid' → DENY
 * - in-process honest baseline → in-process closure 路径正常工作（覆盖 args sid）
 *
 * **plan §Phase 1.1c 任务**：「按 reviewer-claude 反驳轮 mini test 模拟 4 段防御链 1:1 重写」
 * → verify (A)/(B)/(D) 行为变化 = (A)(B) DENY，(D) DENY，(C) 仍 ALLOW（per-session 合法路径不破坏）。
 *
 * **测试策略**：
 * - 不起真实 transport（HTTP server / stdio process），mock 出每段防御链的输入/输出
 *   然后 chain 起来跑端到端
 * - 调真实 production lambda（`resolveCallerSidForReadOnly` from transport-http；stdio override
 *   写死 `() => EXTERNAL_CALLER_SENTINEL` 与 transport-stdio.ts:85 一致）
 * - 调真实 `makeCallerContext` / `denyExternalIfNotAllowed`（不 inline 复制）
 * - 模拟 makeCtx 短路逻辑（与 tools/index.ts:108-109 1:1 一致）
 */

import { describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

// helpers.ts → sessionRepo → store/index → electron。mock 绕开 electron load。
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));

import { resolveCallerSidForReadOnly } from '../transport-http';
import { stdioCallerSessionIdOverride } from '../transport-stdio';
import { makeCallerContext, denyExternalIfNotAllowed } from '../tools/helpers';
import {
  EXTERNAL_CALLER_SENTINEL,
  type AgentDeckMcpTransport,
  type McpAuthInfo,
} from '../types';

/**
 * 模拟 tools/index.ts:108-109 `makeCtx` 短路逻辑（与生产 1:1）：
 * 1. `callerSessionIdOverride?.(extra) ?? null` 拿 override 结果
 * 2. `overridden ?? args.callerSessionId` 短路（overridden 非 null 短路 args）
 * 3. `makeCallerContext(callerSid, ..., transport)` 兜底缺省 sentinel
 */
function simulateMakeCtx(opts: {
  override: ((extra?: unknown) => string | null) | null;
  extra?: unknown;
  argsCallerSid?: string;
  transport: AgentDeckMcpTransport;
}) {
  const overridden = opts.override?.(opts.extra) ?? null;
  const callerSid = overridden ?? opts.argsCallerSid;
  return makeCallerContext(callerSid, undefined, opts.transport);
}

/**
 * R3 fix-4 (M2 codex Batch C+D MED-1) 修法：真 import production stdio override lambda
 * 替代旧版本地复制 `() => EXTERNAL_CALLER_SENTINEL`。production transport-stdio.ts 若回退成
 * `callerSessionIdOverride: null` test 同步 fail（防 B-HIGH-1 修法被静默回归）。
 */
const stdioOverride = stdioCallerSessionIdOverride;

describe('B-HIGH-1 4 段防御链 — 5 攻击 / 合法向量端到端', () => {
  // ============================================================================
  // (A) stdio + spoofed sid → DENY
  // ============================================================================
  it('(A) stdio client 调 spawn_session + args.callerSessionId="victim-active-sid" → DENY', () => {
    // 攻击场景：Cursor / Continue / 任何 stdio MCP client 调 spawn_session
    // 时把 args.callerSessionId 填成已知活动会话 id 想 spoof victim 身份调写工具。
    //
    // 防御链：
    // 1. transport-stdio.ts:85 override `() => SENTINEL` 永返 sentinel
    // 2. makeCtx 短路 `overridden ?? args.callerSessionId` → SENTINEL
    // 3. makeCallerContext → callerSessionId = SENTINEL
    // 4. denyExternalIfNotAllowed('spawn_session', ctx) → DENY（spawn_session 不允许 external）
    const ctx = simulateMakeCtx({
      override: stdioOverride,
      extra: undefined, // stdio 无 HTTP authInfo
      argsCallerSid: 'victim-active-sid',
      transport: 'stdio',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL); // 不是 'victim-active-sid'

    const denial = denyExternalIfNotAllowed('spawn_session', ctx);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    const denialJson = JSON.parse(denial!.content[0].text);
    expect(denialJson.error).toMatch(/spawn_session not allowed for external caller/);
  });

  it('(A) stdio + spoofed sid + 写 tool send_message / shutdown_session / archive_plan → 全部 DENY', () => {
    const ctx = simulateMakeCtx({
      override: stdioOverride,
      argsCallerSid: 'victim-active-sid',
      transport: 'stdio',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);

    for (const tool of [
      'send_message',
      'shutdown_session',
      'archive_plan',
      'hand_off_session',
      'enter_worktree',
      'exit_worktree',
      // R3 fix-7 (M1 reviewer-claude LOW): Phase 5.3 新增 shutdown_baton_teammates 写 tool
      // (types.ts EXTERNAL_CALLER_ALLOWED.shutdown_baton_teammates=false)
      'shutdown_baton_teammates',
      // plan task-mcp-merge-into-agent-deck-mcp-20260521 §D6 R1 F1：5 task tool 合并入 agent-deck
      // namespace 后 3 写 tool 加进 deny external 列表（EXTERNAL_CALLER_ALLOWED.task_*=false）
      'task_create',
      'task_update',
      'task_delete',
    ] as const) {
      const denial = denyExternalIfNotAllowed(tool, ctx);
      expect(denial, `tool=${tool}`).not.toBeNull();
      expect(denial?.isError, `tool=${tool}`).toBe(true);
    }
  });

  // ============================================================================
  // (B) HTTP global token + spoofed sid → DENY
  // ============================================================================
  it('(B) HTTP global token caller + args.callerSessionId="victim-active-sid" → DENY', () => {
    // 攻击场景：CLI / 第三方 HTTP MCP client 用 mcpServerToken 全局 Bearer 调 spawn_session
    // 时把 args.callerSessionId 填成已知活动会话 id 想 spoof victim。
    //
    // 防御链：
    // 1. HookServer.checkMcpAuth 反查 per-session map miss + match 全局 token → 写
    //    `req.auth = {resolvedSid: null, fallbackToGlobal: true}`
    // 2. transport-http.ts:73 `resolveCallerSidForReadOnly(extra)` 见 fallbackToGlobal=true
    //    → return SENTINEL（force 防 spoofing）
    // 3. makeCtx 短路 SENTINEL，不走 args
    // 4. denyExternalIfNotAllowed → DENY
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    const ctx = simulateMakeCtx({
      override: resolveCallerSidForReadOnly,
      extra,
      argsCallerSid: 'victim-active-sid', // 攻击者伪造的 victim sid
      transport: 'http',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);

    const denial = denyExternalIfNotAllowed('spawn_session', ctx);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
  });

  // ============================================================================
  // (C) HTTP per-session authn + real sid → ALLOW（合法路径，不 DENY）
  // ============================================================================
  it('(C) HTTP per-session authn caller + resolvedSid="codex-teammate-1" → ALLOW（合法 caller）', () => {
    // 合法场景：agent-deck spawn 的 codex teammate 子进程在 envOverride 注入 per-session
    // mcp token，CLI MCP client 用 Bearer header 发请求 → HookServer.checkMcpAuth 反查
    // mcpSessionTokenMap 命中 → 写 `req.auth = {resolvedSid: 'codex-teammate-1',
    // fallbackToGlobal: false}`。修法后这条合法路径仍正常通过。
    //
    // 防御链：
    // 1. authInfo.resolvedSid='codex-teammate-1' + fallbackToGlobal=false
    // 2. resolveCallerSidForReadOnly → return 'codex-teammate-1'（非 SENTINEL）
    // 3. makeCtx 短路 'codex-teammate-1'
    // 4. denyExternalIfNotAllowed → null（非 sentinel + 不命中 stdio invariant）→ ALLOW
    const extra = {
      authInfo: {
        resolvedSid: 'codex-teammate-1',
        fallbackToGlobal: false,
      } satisfies McpAuthInfo,
    };
    const ctx = simulateMakeCtx({
      override: resolveCallerSidForReadOnly,
      extra,
      transport: 'http',
    });
    expect(ctx.callerSessionId).toBe('codex-teammate-1');

    // spawn_session 不被 denyExternalIfNotAllowed 拦下（这是合法 per-session caller）
    // 注：后续 validateExternalCaller 会反查 sessionRepo 看 sid 是否有效活动会话，但本测试
    // 关注 denyExternalIfNotAllowed 这层，反查由集成测试覆盖
    const denial = denyExternalIfNotAllowed('spawn_session', ctx);
    expect(denial).toBeNull();
  });

  it('(C) HTTP per-session authn caller + args 塞 fake-injected-sid → resolvedSid 优先（防 prompt 注入）', () => {
    // codex teammate 真正 callerSessionId 由 HookServer.checkMcpAuth 反查 token 解析；
    // 即使 codex agent 在 args.callerSessionId 伪造 fake sid（如被 LLM prompt 注入），
    // lambda 返的 resolvedSid 优先 — `overridden ?? args` overridden=real sid 短路 args。
    const extra = {
      authInfo: { resolvedSid: 'real-sid', fallbackToGlobal: false } satisfies McpAuthInfo,
    };
    const ctx = simulateMakeCtx({
      override: resolveCallerSidForReadOnly,
      extra,
      argsCallerSid: 'fake-injected-sid',
      transport: 'http',
    });
    expect(ctx.callerSessionId).toBe('real-sid'); // 不是 'fake-injected-sid'
  });

  // ============================================================================
  // (D) HTTP fallbackToGlobal=true + 攻击者塞 resolvedSid → DENY（fallback 优先 sentinel）
  // ============================================================================
  it('(D) HTTP fallbackToGlobal=true + 攻击者塞 resolvedSid="attacker-forged-sid" → DENY', () => {
    // 高级攻击场景：攻击者发现 authInfo 字段结构后，构造 Bearer header + 同时伪造
    // {resolvedSid: 'attacker-sid', fallbackToGlobal: true}。
    // 但 HookServer.checkMcpAuth 是服务端写 req.auth；攻击者无法直接控制。这条 case 模拟
    // 「假如 hookServer 内部 bug 让攻击者 inject 了字段」的兜底 — resolveCallerSidForReadOnly
    // **优先** 检查 fallbackToGlobal=true → SENTINEL，不让 resolvedSid 兜底路径有机会。
    //
    // 防御链：
    // 1. extra.authInfo = {resolvedSid: 'attacker-forged-sid', fallbackToGlobal: true}
    // 2. resolveCallerSidForReadOnly 早 `if (authInfo?.fallbackToGlobal) return SENTINEL`
    //    → 不读 resolvedSid → return SENTINEL
    // 3. makeCtx 短路 SENTINEL
    // 4. denyExternalIfNotAllowed → DENY
    const extra = {
      authInfo: {
        resolvedSid: 'attacker-forged-sid',
        fallbackToGlobal: true,
      } satisfies McpAuthInfo,
    };
    const ctx = simulateMakeCtx({
      override: resolveCallerSidForReadOnly,
      extra,
      transport: 'http',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);

    const denial = denyExternalIfNotAllowed('spawn_session', ctx);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    const denialJson = JSON.parse(denial!.content[0].text);
    expect(denialJson.error).toMatch(/spawn_session not allowed for external caller/);
  });

  // ============================================================================
  // (E) in-process honest baseline → 正常路径（closure override 覆盖 args sid）
  // ============================================================================
  it('(E) in-process honest baseline — closure override 覆盖 args.callerSessionId', () => {
    // baseline：in-process transport（应用内 SDK session 调 mcp tool）走 closure
    // override（getAgentDeckMcpServerForSession.ts：`callerSessionIdOverride = () => ownerSid`）
    // 强制覆盖 callerSessionId，args 字段被忽略 — 即使 SDK Claude 自我 prompt 注入想伪造
    // 别的 sid 也无效。
    const ownerSid = 'sdk-owner-sid-123';
    const inProcessOverride = () => ownerSid;
    const ctx = simulateMakeCtx({
      override: inProcessOverride,
      argsCallerSid: 'self-prompt-injected-sid', // SDK Claude 想伪造别的 sid
      transport: 'in-process',
    });
    expect(ctx.callerSessionId).toBe(ownerSid); // 不是 'self-prompt-injected-sid'

    // in-process 是合法 caller — 不被 denyExternalIfNotAllowed 拦下
    const denial = denyExternalIfNotAllowed('spawn_session', ctx);
    expect(denial).toBeNull();
  });
});

describe('B-HIGH-1 防御链组合：read-only tool 例外（list_sessions / get_session / task_list）', () => {
  it('(A) stdio + spoofed sid + list_sessions（read-only） → ALLOW（external 允许只读）', () => {
    // EXTERNAL_CALLER_ALLOWED.list_sessions=true（read-only 允许 external）
    // stdio sentinel callerSid + read-only tool → 不 DENY
    const ctx = simulateMakeCtx({
      override: stdioOverride,
      argsCallerSid: 'victim-active-sid',
      transport: 'stdio',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);

    const denial = denyExternalIfNotAllowed('list_sessions', ctx);
    expect(denial).toBeNull();
  });

  it('(B) HTTP global token + spoofed sid + get_session（read-only） → ALLOW', () => {
    // global token + read-only get_session 仍 allow
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    const ctx = simulateMakeCtx({
      override: resolveCallerSidForReadOnly,
      extra,
      argsCallerSid: 'victim-active-sid',
      transport: 'http',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);

    const denial = denyExternalIfNotAllowed('get_session', ctx);
    expect(denial).toBeNull();
  });

  // plan task-mcp-merge-into-agent-deck-mcp-20260521 §D6 R1 F1：5 task tool 合并后
  // task_list 加入 read-only 例外（EXTERNAL_CALLER_ALLOWED.task_list=true）
  // plan task-team-id-restore-20260525 §D8（user 拍板方案 A flip false）:task_get 改 DENY
  // — 与 task_create/update/delete 同款 deny external 对称;v023 「lead 跨 team 看 teammate task /
  // external mcp client 凭已知 id 查 task」两类 use case 推翻
  it('(A) stdio + spoofed sid + task_list（read-only） → ALLOW', () => {
    const ctx = simulateMakeCtx({
      override: stdioOverride,
      argsCallerSid: 'victim-active-sid',
      transport: 'stdio',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);

    const denial = denyExternalIfNotAllowed('task_list', ctx);
    expect(denial).toBeNull();
  });

  it('(A) stdio + spoofed sid + task_get（D8 flip false） → DENY', () => {
    const ctx = simulateMakeCtx({
      override: stdioOverride,
      argsCallerSid: 'victim-active-sid',
      transport: 'stdio',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);

    const denial = denyExternalIfNotAllowed('task_get', ctx);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    expect(JSON.parse(denial!.content[0].text).error).toMatch(
      /task_get not allowed for external caller/,
    );
  });

  it('(B) HTTP global token + task_list（read-only） → ALLOW', () => {
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    const ctx = simulateMakeCtx({
      override: resolveCallerSidForReadOnly,
      extra,
      transport: 'http',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);

    const denial = denyExternalIfNotAllowed('task_list', ctx);
    expect(denial).toBeNull();
  });

  it('(B) HTTP global token + task_get（D8 flip false） → DENY', () => {
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    const ctx = simulateMakeCtx({
      override: resolveCallerSidForReadOnly,
      extra,
      transport: 'http',
    });
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);

    const denial = denyExternalIfNotAllowed('task_get', ctx);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    expect(JSON.parse(denial!.content[0].text).error).toMatch(
      /task_get not allowed for external caller/,
    );
  });
});

describe('B-HIGH-1 防御链兜底：stdio invariant violation（transport 层漏改时兜底守门）', () => {
  it('stdio + 非 sentinel callerSid（假设 transport 层漏改） → denyExternalIfNotAllowed 兜底 DENY', () => {
    // 假设 transport-stdio.ts:85 漏改回老 `callerSessionIdOverride: null`，攻击者 args 字段
    // escape 进 makeCtx callerSid='attacker-sid'。helpers.ts denyExternalIfNotAllowed (a)
    // 兜底守门：transport='stdio' + callerSessionId 非 sentinel → invariant violation DENY。
    //
    // 直接构造 ctx 模拟这种 transport 层漏改的 bug 场景，验证兜底守门。
    const ctx = makeCallerContext('attacker-sid', undefined, 'stdio');
    expect(ctx.callerSessionId).toBe('attacker-sid'); // 非 sentinel（漏改场景）

    const denial = denyExternalIfNotAllowed('spawn_session', ctx);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    const denialJson = JSON.parse(denial!.content[0].text);
    expect(denialJson.error).toMatch(/not allowed for stdio transport with non-sentinel/);
    expect(denialJson.hint).toMatch(/transport-stdio.ts.*callerSessionIdOverride/);
  });

  it('HTTP transport + 非 sentinel callerSid（per-session real sid） → 不命中 stdio 兜底（避免误杀合法）', () => {
    // 不能对 HTTP 加同款守门（plan-review v2 codex NEW-H1 反馈）— HTTP per-session
    // resolvedSid 是合法路径，real sid 应通过 denyExternalIfNotAllowed。
    // 仅 sentinel + 非 read-only tool 走 deny；非 sentinel 应通过此层（后续 validateExternalCaller
    // 反查 sessionRepo 是否真实存在 + lifecycle active）。
    const ctx = makeCallerContext('codex-teammate-real-sid', undefined, 'http');
    expect(ctx.callerSessionId).toBe('codex-teammate-real-sid');

    const denial = denyExternalIfNotAllowed('spawn_session', ctx);
    expect(denial).toBeNull(); // HTTP 不走 stdio 兜底
  });
});
