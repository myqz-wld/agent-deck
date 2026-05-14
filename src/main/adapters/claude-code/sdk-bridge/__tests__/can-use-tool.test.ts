/**
 * makeCanUseTool 单测（CHANGELOG_72 Bug 3 配套）。
 *
 * 重点验证 bypassPermissions 短路修法：
 * - bypass + 普通工具（Write）→ 直接 allow，不进 pendingPermissions / 不 emit waiting-for-user
 * - bypass + SandboxNetworkAccess → auto-deny + fallback message（不被 bypass 短路覆盖）
 * - bypass + AskUserQuestion → 走 UI 通路 emit waiting-for-user，进 pendingAskUserQuestions
 * - bypass + READ_ONLY (Read) → 白名单优先放行
 * - default + 普通工具（Write）→ 走默认路径 emit waiting-for-user（regression baseline）
 *
 * Mock 策略：makeCanUseTool 是纯工厂函数，依赖通过 deps 注入。本测不起 ClaudeSdkBridge 全栈，
 * 不 mock sessionRepo（修法关键收益就是不再读它）— 直接构造最小 InternalSession + 注入 stub deps。
 *
 * **关键**：测试 sets `getPermissionTimeoutMs: () => 0` 跳过 setTimeout 分支
 * （can-use-tool.ts default 路径 line 308 `if (timeoutMs > 0)`）— 避免 vitest 内 timer leak。
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { makeCanUseTool, type MakeCanUseToolDeps } from '../can-use-tool';
import type { InternalSession } from '../types';
import type { PermissionResponder } from '../permission-responder';
import type { PermissionMode } from '@main/adapters/types';

function makeInternal(permissionMode: PermissionMode): InternalSession {
  return {
    realSessionId: 'sess-test',
    cwd: '/tmp/test',
    query: undefined as unknown as Query,
    permissionMode,
    pendingUserMessages: [],
    notify: null,
    pendingPermissions: new Map(),
    pendingAskUserQuestions: new Map(),
    pendingExitPlanModes: new Map(),
    toolUseNames: new Map(),
  };
}

function makeDeps(internal: InternalSession): {
  deps: MakeCanUseToolDeps;
  emitted: AgentEvent[];
} {
  const emitted: AgentEvent[] = [];
  const deps: MakeCanUseToolDeps = {
    internal,
    getSessionId: () => internal.realSessionId ?? 'tempkey',
    getPermissionMode: () => internal.permissionMode,
    emit: (e) => {
      emitted.push(e);
    },
    // 0 = 不开 setTimeout，避免 vitest timer leak（与 can-use-tool.ts:308/151 默认路径一致）
    getPermissionTimeoutMs: () => 0,
    // PermissionResponder stub：本测不会触发任何 timeout 分支（getPermissionTimeoutMs=0 短路）
    // 但 abort listener 可能引用 responder，故给个空对象兜底
    responder: {} as unknown as PermissionResponder,
  };
  return { deps, emitted };
}

/** 最小 ToolPermissionContext stub（CanUseTool 第三参）。
 *
 * REVIEW_35 R2 MED-C-claude/codex test gap：SDK 0.2.118 类型是 `toolUseID` (camelCase) 不是
 * `tool_use_id` (snake_case)。修前测试只传 tool_use_id，与生产代码 `ctx.toolUseID ?? ctx.tool_use_id`
 * 兼容修法分道扬镳 — 测试 pass 但其实没真测 SDK 实际字段名。修法：双字段都暴露，让 test 可
 * 选择性测正路径 toolUseID（线上真实）+ fallback path tool_use_id（兼容老协议）。
 */
function makeCtx(opts: { toolUseID?: string; tool_use_id?: string } = {}): Parameters<
  ReturnType<typeof makeCanUseTool>
>[2] {
  // signal 给 AbortController.signal — 测试不主动 abort，listener 不会触发
  const ac = new AbortController();
  return {
    signal: ac.signal,
    suggestions: undefined,
    ...opts,
  } as Parameters<ReturnType<typeof makeCanUseTool>>[2];
}

describe('makeCanUseTool — bypassPermissions 短路（CHANGELOG_72 Bug 3）', () => {
  it('bypass + 普通工具（Write）→ allow，不进 pendingPermissions / 不 emit waiting-for-user', async () => {
    const internal = makeInternal('bypassPermissions');
    const { deps, emitted } = makeDeps(internal);
    const canUseTool = makeCanUseTool(deps);

    const result = await canUseTool(
      'Write',
      { file_path: '/tmp/foo.txt', content: 'hi' },
      makeCtx(),
    );

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/foo.txt', content: 'hi' },
    });
    expect(internal.pendingPermissions.size).toBe(0);
    // 不应 emit 任何 waiting-for-user（PendingTab 完全不接到这条工具调用）
    expect(emitted.filter((e) => e.kind === 'waiting-for-user')).toEqual([]);
  });

  it('bypass + SandboxNetworkAccess → 仍 auto-deny + 引导 fallback（不被 bypass 短路覆盖）', async () => {
    const internal = makeInternal('bypassPermissions');
    const { deps, emitted } = makeDeps(internal);
    const canUseTool = makeCanUseTool(deps);

    const result = await canUseTool('SandboxNetworkAccess', { host: 'example.com' }, makeCtx());

    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toMatch(/沙盒|dangerouslyDisableSandbox/);
      expect(result.interrupt).toBe(false);
    }
    // 沙盒拦截只 console.log（不 emit waiting-for-user，与原行为一致）
    expect(emitted.filter((e) => e.kind === 'waiting-for-user')).toEqual([]);
  });

  it('bypass + AskUserQuestion → 走 UI 通路 emit waiting-for-user + 进 pendingAskUserQuestions', async () => {
    const internal = makeInternal('bypassPermissions');
    const { deps, emitted } = makeDeps(internal);
    const canUseTool = makeCanUseTool(deps);

    // 不 await — AskUserQuestion 的 Promise 卡在等用户回复，本测只验证 emit + pending 注册副作用
    void canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'go?', header: 'X', options: [], multiSelect: false }] },
      makeCtx({ toolUseID: 'tu-ask-1' }),
    );

    // 同步副作用：emit + pending 注册（emit 在 Promise 构造前，await 微任务边界后即可观察）
    await Promise.resolve();
    expect(emitted.some((e) => e.kind === 'waiting-for-user')).toBe(true);
    expect(internal.pendingAskUserQuestions.size).toBe(1);
  });

  it('bypass + READ_ONLY (Read) → 白名单优先放行（任何 mode 都 allow）', async () => {
    const internal = makeInternal('bypassPermissions');
    const { deps, emitted } = makeDeps(internal);
    const canUseTool = makeCanUseTool(deps);

    const result = await canUseTool('Read', { file_path: '/tmp/foo.txt' }, makeCtx());

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/foo.txt' },
    });
    expect(emitted.filter((e) => e.kind === 'waiting-for-user')).toEqual([]);
  });

  it('default + 普通工具（Write）→ 走默认路径 emit waiting-for-user + 进 pendingPermissions（regression baseline）', async () => {
    const internal = makeInternal('default');
    const { deps, emitted } = makeDeps(internal);
    const canUseTool = makeCanUseTool(deps);

    void canUseTool(
      'Write',
      { file_path: '/tmp/foo.txt', content: 'hi' },
      makeCtx(),
    );

    await Promise.resolve();
    const waitings = emitted.filter((e) => e.kind === 'waiting-for-user');
    expect(waitings.length).toBe(1);
    const payload = waitings[0].payload as { type: string; toolName: string };
    expect(payload.type).toBe('permission-request');
    expect(payload.toolName).toBe('Write');
    expect(internal.pendingPermissions.size).toBe(1);
  });

  it('热切换 setPermissionMode 等价：internal.permissionMode 更新后立刻按新 mode 短路', async () => {
    // 模拟 setPermissionMode('bypassPermissions') 同步更新 in-memory cache 后的行为
    const internal = makeInternal('default');
    const { deps, emitted } = makeDeps(internal);
    const canUseTool = makeCanUseTool(deps);

    // 切前：default 模式 Write 走默认路径
    void canUseTool('Write', { file_path: '/a' }, makeCtx());
    await Promise.resolve();
    expect(internal.pendingPermissions.size).toBe(1);

    // 切到 bypass：模拟 setPermissionMode 同步更新（与 sdk-bridge/index.ts:setPermissionMode 一致）
    internal.permissionMode = 'bypassPermissions';

    // 切后：相同 Write 走 bypass 短路 allow
    const result = await canUseTool('Write', { file_path: '/b' }, makeCtx());
    expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: '/b' } });

    // 仅切前那次留 pending（pendingPermissions Map 没变化）
    expect(internal.pendingPermissions.size).toBe(1);
    // 切后那次不 emit waiting-for-user（waitings 仅来自切前那次）
    expect(emitted.filter((e) => e.kind === 'waiting-for-user').length).toBe(1);
  });
});
