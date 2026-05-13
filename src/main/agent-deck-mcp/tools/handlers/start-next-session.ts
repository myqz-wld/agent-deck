/**
 * start_next_session handler 入口（plan mcp-bug-and-feature-batch-20260513 Phase 4b Step 4b.2）。
 *
 * 薄 wrapper：deny external caller + validateExternalCaller + 调 startNextSessionImpl
 * 拿 resolved 上下文（planFilePath / worktreePath / coldStartPrompt） + 组装 spawn_session
 * args + 调 spawnSessionHandler 完成实际 spawn + 包 K2 metadata + spawn 字段透传。
 *
 * 业务行为完全在 start-next-session-impl.ts（plan resolve / frontmatter parse / status 校验
 * / prompt 构造），spawn 行为完全复用 spawnSessionHandler（与 spawn_session tool 同款防御链
 * + permission_mode / sandbox 继承 + team ensure + addMember + placeholder enqueue 全套）。
 *
 * **Deny external caller**（types.ts: EXTERNAL_CALLER_ALLOWED.start_next_session = false）：
 * 起 SDK session 的 fork bomb 风险（同 spawn_session / archive_plan），绝不允许 stdio
 * external client 调用。
 *
 * **复用策略**：调 spawnSessionHandler 时透传同一个 ctx（caller_session_id），让 spawn
 * 链路里的 spawn-link / lead 加入 / placeholder enqueue 全部按 caller 视角正确归属。
 * 透传后 spawnSessionHandler 返回的 HandlerResult 含 JSON.stringify ok 数据，本 handler
 * parse 出 sessionId 等字段，包 K2 自己的 ok return（额外加 K2 metadata: planFilePath /
 * worktreePath / initialPrompt / phaseLabel）。
 */

import {
  denyExternalIfNotAllowed,
  err,
  ok,
  validateExternalCaller,
  type HandlerContext,
  type HandlerResult,
} from '../helpers';
import type { StartNextSessionArgs, SpawnSessionArgs } from '../schemas';
import {
  startNextSessionImpl,
  _isStartNextSessionError,
  type StartNextSessionDeps,
} from './start-next-session-impl';
import { spawnSessionHandler } from './spawn';

/**
 * 测试 inject seam：默认调真 spawnSessionHandler；test 通过 depsOverride 注入 mock spawn
 * 函数避免起真 SDK session。impl deps 也透传给 startNextSessionImpl。
 */
export interface StartNextSessionHandlerDeps {
  spawnSession?: typeof spawnSessionHandler;
  implDeps?: StartNextSessionDeps;
}

export async function startNextSessionHandler(
  args: StartNextSessionArgs,
  ctx: HandlerContext,
  handlerDeps?: StartNextSessionHandlerDeps,
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('start_next_session', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;

  // 1. impl 层：解析 plan 文件 + frontmatter + 构造 cold-start prompt
  const resolved = await startNextSessionImpl(
    {
      planId: args.plan_id,
      phaseLabel: args.phase_label,
      planFilePathOverride: args.plan_file_path,
    },
    handlerDeps?.implDeps,
  );
  if (_isStartNextSessionError(resolved)) {
    return err(resolved.error, resolved.hint);
  }

  // 2. 组装 spawn_session args：cwd 默认 worktree_path，team_name 默认 plan_id，
  // 其他字段透传 caller 显式传的（permission_mode / adapter）。
  const spawnArgs: SpawnSessionArgs = {
    adapter: args.adapter ?? 'claude-code',
    cwd: args.cwd ?? resolved.worktreePath,
    prompt: resolved.coldStartPrompt,
    team_name: args.team_name ?? args.plan_id,
    ...(args.permission_mode !== undefined ? { permission_mode: args.permission_mode } : {}),
    // caller_session_id 透传：spawn handler 内 makeCtx 已重新算（in-process closure
    // override），但这里用 ctx 直接转发跳过中间层。下方 spawnSessionHandler 接受 ctx 参数
    // 直接传同一个 caller，不依赖 spawn_session 的 args.caller_session_id 字段。
  };

  // 3. 调 spawn handler 完成实际 spawn（透传同一 ctx 让 caller 视角一致）
  const spawnFn = handlerDeps?.spawnSession ?? spawnSessionHandler;
  const spawnResult = await spawnFn(spawnArgs, ctx);
  if (spawnResult.isError) {
    // 透传 spawn 的 error 不再二次包装（避免「start_next_session error: spawn error: ...」嵌套）
    return spawnResult;
  }

  // 4. parse spawn 的 ok JSON → 包 K2 metadata
  let spawnData: Record<string, unknown>;
  try {
    spawnData = JSON.parse(spawnResult.content[0]?.text ?? '{}');
  } catch (e) {
    return err(
      `failed to parse spawn_session result: ${(e as Error).message}`,
      'spawn_session returned non-JSON content; this is an internal error.',
    );
  }

  return ok({
    // K2 metadata（lead 用来追踪 plan 上下文）
    planId: args.plan_id,
    planFilePath: resolved.planFilePath,
    worktreePath: resolved.worktreePath,
    baseBranch: resolved.baseBranch,
    phaseLabel: args.phase_label ?? null,
    initialPrompt: resolved.coldStartPrompt,
    // 透传 spawn_session 字段（兼容 spawn 调用方）
    ...spawnData,
  });
}
