/**
 * hand-off-session cwd-resolver 子模块（plan deep-project-review-comprehensive-20260528 Step 4.1
 * 拆分产物，从原 hand-off-session.ts 1306 LOC facade 抽出 cwd 解析与 worktree 校验 helper）。
 *
 * 责任：
 * - caller cwd 反查（解 H5 caller cwd bug 核心）+ fail-open warnings 收集
 * - mergeCallerCwd（caller 显式 implDeps.cwd 优先 > sessionRepo 反查 > impl DEFAULT_DEPS）
 * - callerSessionRow 反查 + existsSync precheck（CHANGELOG_99 R1 fix MED-4）
 * - planModeDefaultCwd 推导（REVIEW_36 HIGH-3：约定 worktree 走 mainRepo / 外置 worktree 降级 worktreePath）
 * - finalCwd 推导 + worktreeExists missing 4 case 决策（REVIEW_56 Batch B R2 MED-1）
 * - computedExtraAllowWrite 计算（REVIEW_36 R2 MED-C：外置 worktree 自动加 mainRepo）
 *
 * **设计**：所有 helper 接受 `args` / `caller` / `resolved` / `handlerDeps` 作为输入，
 * 返回派生 state 给 handler-main 串联（避免单一巨型 ctx object 闭包污染 — 函数式
 * readability，与原 inline 闭包语义等价）。错误路径返 `{ isError: true, ... }`
 * 让 handler-main 短路 return。
 */

import { existsSync } from 'node:fs';
import { err, type HandlerResult } from '../../helpers';
import { EXTERNAL_CALLER_SENTINEL } from '../../../types';
import { sessionRepo } from '@main/store/session-repo';
import type { HandOffSessionArgs } from '../../schemas';
import type { HandOffSessionDeps } from '../hand-off-session-impl';
import type { HandOffSessionHandlerDeps } from './_deps';
import log from '@main/utils/logger';

const logger = log.scope('mcp-handoff-cwd');

/**
 * impl 调用结果对外契约的最小子集（避免引入 hand-off-session-impl 双向依赖）。
 * hand-off-session-impl.ts 真实返回 HandOffSessionResolved，本子模块只用以下字段。
 */
export interface ResolvedForCwd {
  mode: 'plan' | 'generic';
  mainRepo: string | null;
  worktreePath: string | null;
  worktreeExists: boolean;
}

/**
 * 从 caller session id 反查 sessions 表拿 cwd，构造 implDeps 子集（仅 cwd 字段）。
 *
 * 解 H5 caller cwd bug 的核心：impl DEFAULT_DEPS.cwd = process.cwd()（Electron main
 * 进程 cwd，通常 `/`），与真正的 caller SDK session cwd 无关，所以反查 main-repo /
 * 判定 worktree 都失败。handler 层必须从 sessionRepo 反查 caller session 的真实 cwd
 * 注入。external sentinel / 反查不到时返回空对象，impl 仍走 DEFAULT_DEPS.cwd 兜底。
 *
 * **REVIEW_56 §F9 修法 (Plan-Review Round 1 + spike3 实证决策 A) — 对称改 archive-plan.ts**:
 * 签名重构 `(sid): { deps: HandOffSessionDeps; warnings: string[] }` — fail-open 退化时
 * warnings 收集。handler 端拿 warnings 后只 console.warn 输出 (hand-off-session ok return
 * 没 warnings 字段不 surface,与 archive-plan.ts 不对称是设计取舍:hand_off 单 baton 退化风险
 * 低于 archive_plan 收口,加 ok return.warnings schema 是 breaking change 不值)。**signature 仍
 * 与 archive-plan 同款保持对称易维护**。同时顺手补 archive-plan P5 R1 同款 console.warn
 * (对称缺口 — 原 hand-off-session catch silent return {} 无 warn,运维 grep 不到 fail-open 退化)。
 */
export function resolveCallerCwdDeps(callerSessionId: string): {
  deps: HandOffSessionDeps;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (callerSessionId === EXTERNAL_CALLER_SENTINEL) return { deps: {}, warnings };
  // CHANGELOG_99 R1 fix MED-1:sessionRepo.get 包 try/catch fail-safe (与 L143 段对称)。
  // DB 异常 (test 未 init / 生产 SQLite locked / FK conflict) 时返回空 deps,让 impl 退化到
  // DEFAULT_DEPS.cwd = process.cwd() 兜底,而非 handler 直接 crash。
  // REVIEW_56 §F9 修法: 加 console.warn (对称 archive-plan.ts P5 R1 修法) + warnings 收集。
  let row: ReturnType<typeof sessionRepo.get> = null;
  try {
    row = sessionRepo.get(callerSessionId);
  } catch (e) {
    const msg = `[hand-off-session] sessionRepo.get(${callerSessionId}) threw — falling back to DEFAULT_DEPS (cwd=process.cwd). Hand off proceeds without caller cwd injection. err=${e instanceof Error ? e.message : String(e)}`;
    logger.warn(msg);
    warnings.push(msg);
    return { deps: {}, warnings };
  }
  if (!row?.cwd) {
    if (!row) {
      const msg = `[hand-off-session] sessionRepo.get(${callerSessionId}) returned null — caller session not found, falling back to DEFAULT_DEPS`;
      warnings.push(msg);
    }
    return { deps: {}, warnings };
  }
  const cwd = row.cwd;
  return { deps: { cwd: () => cwd }, warnings };
}

/**
 * 合并 caller 显式 implDeps 与 sessionRepo 反查的 callerCwd 注入。
 *
 * 优先级（从高到低）：
 * 1. caller 显式传 `handlerDeps.implDeps.cwd`（test 场景或 caller 想强制覆盖）
 * 2. sessionRepo 反查 callerSession.cwd（生产路径正常情况）
 * 3. impl 内 DEFAULT_DEPS.cwd（process.cwd，最后兜底）
 *
 * 实现策略：caller 显式 cwd 时直接返回 caller 原 implDeps；否则把 callerCwdInjection 放
 * **后面** spread 覆盖任何 caller implDeps 里 cwd: undefined 的边界 case。
 *
 * **REVIEW_56 §F9 修法**: 签名同 resolveCallerCwdDeps,返 `{deps, warnings}` 对称 archive-plan.ts。
 */
export function mergeCallerCwd(
  callerImplDeps: HandOffSessionDeps | undefined,
  callerSessionId: string,
): { deps: HandOffSessionDeps | undefined; warnings: string[] } {
  if (callerImplDeps?.cwd) return { deps: callerImplDeps, warnings: [] };
  const { deps: callerCwdInjection, warnings } = resolveCallerCwdDeps(callerSessionId);
  if (!callerCwdInjection.cwd) return { deps: callerImplDeps, warnings };
  return { deps: { ...callerImplDeps, ...callerCwdInjection }, warnings };
}

/**
 * 反查 callerSessionRow 拿 callerSessionCwd（generic 模式 default cwd 用 + 后续归档段复用）。
 *
 * CHANGELOG_99 R1 fix MED-4：generic 模式 default cwd 候选 callerSessionCwd 必须 existsSync
 * precheck。生产场景:caller 是 K2 老 session,cwd=worktree,worktree 已被 archive_plan 删 →
 * callerSessionCwd 仍是失效路径 → 直接传给 spawn 会 chdir 失败(recoverer 只覆盖已建立
 * session 的 sendMessage 路径,不覆盖新 spawn 的 createSession)。precheck false → null
 * 让 default cwd fallback 到 mainRepo。
 *
 * external sentinel / DB 错时 callerSessionRow null,fallback 到 mainRepo / undefined。
 */
export function resolveCallerSessionCwd(
  callerSessionId: string,
  handlerDeps: HandOffSessionHandlerDeps | undefined,
): {
  callerSessionRow: ReturnType<typeof sessionRepo.get>;
  callerSessionCwd: string | null;
} {
  let callerSessionRow: ReturnType<typeof sessionRepo.get> = null;
  if (callerSessionId !== EXTERNAL_CALLER_SENTINEL) {
    try {
      callerSessionRow = sessionRepo.get(callerSessionId);
    } catch {
      // DB 不可用(typical: test 环境 DB 未 init)→ 留 null
      callerSessionRow = null;
    }
  }
  const cwdExistsFn = handlerDeps?.cwdExists ?? existsSync;
  const callerSessionCwdRaw: string | null = callerSessionRow?.cwd ?? null;
  const callerSessionCwd: string | null =
    callerSessionCwdRaw !== null && cwdExistsFn(callerSessionCwdRaw) ? callerSessionCwdRaw : null;
  return { callerSessionRow, callerSessionCwd };
}

/**
 * REVIEW_36 HIGH-3：plan-driven 模式 default cwd 推导。
 * 优先 mainRepo（约定 worktree 走 cwd resilience），外置 worktree 退化 worktreePath
 * （让 sandbox.allowWrite=[cwd, /tmp, ~/.cache] 自然覆盖外置路径，否则
 * workspace-write 写每个文件弹框 / strict 完全卡死）。
 * 严格判定 worktree 在 mainRepo subtree（mainRepo + '/' 防同名前缀误命中
 * 如 `/repo` vs `/repo-other` —— `/repo-other`.startsWith('/repo') === true）。
 */
export function resolvePlanModeDefaultCwd(resolved: ResolvedForCwd): string | undefined {
  if (!resolved.mainRepo) {
    return resolved.worktreePath ?? undefined;
  }
  if (!resolved.worktreePath) {
    return resolved.mainRepo;
  }
  const mainRepoWithSep = resolved.mainRepo.endsWith('/')
    ? resolved.mainRepo
    : resolved.mainRepo + '/';
  const isInternalWorktree = resolved.worktreePath.startsWith(mainRepoWithSep);
  return isInternalWorktree ? resolved.mainRepo : resolved.worktreePath;
}

/**
 * worktreeExists missing 4 case 决策（REVIEW_56 Batch B R2 MED-1 修法）：
 * - finalCwd === resolved.worktreePath → hard reject (cwd 即将进失效目录,spawn 必 ENOENT)
 *   caller 显式 args.cwd=worktreePath OR 外置 worktree 自动 default 到 worktreePath 两条
 *   路径都走这条 reject
 * - finalCwd === resolved.mainRepo + 约定 worktree (mainRepo subtree) → graceful warn
 *   让 cold-start 调 enter_worktree 自建 worktree (cwd resilience)
 * - finalCwd === resolved.mainRepo + 外置 worktree → hard reject
 *   (外置 cold-start enter_worktree 同样会撞父目录不存在 — caller 必须先重建 worktree)
 *
 * 修前 R1 用 regex 在 impl 层判约定/外置直接 reject 或 graceful warn,但 regex 只看后缀
 * (`.claude/worktrees/<id>`),外置 conventional path 也匹配放行 → spawn ENOENT。
 *
 * CHANGELOG_169 F3 [MED]: finalCwd 必须在 mainRepo subtree 才走 graceful warn 路径。
 * reviewer-codex finding: 之前条件只 reject `finalCwd === worktreePath || !isInternalWorktree`,
 * caller 显式传 args.cwd=/tmp / cwd=other-repo 但 isInternalWorktree=true 时被静默放行,
 * 新 session 落到错 cwd 后 cold-start enter_worktree 会撞 ENOENT 或落错 repo。修法:加
 * finalCwdInMainRepo 校验 — finalCwd === mainRepo 或 finalCwd 在 mainRepo subtree 内才走 warn,
 * 否则 hard reject。
 *
 * 返回 `{ result: HandlerResult }` 表示 hard reject;`null` 表示通过(可能 warn 提示)。
 */
export function validatePlanModeWorktreeExists(
  resolved: ResolvedForCwd,
  finalCwd: string | undefined,
): { result: HandlerResult } | null {
  if (resolved.mode !== 'plan' || resolved.worktreeExists) return null;
  const isInternalWorktree =
    resolved.mainRepo !== null &&
    resolved.worktreePath !== null &&
    resolved.worktreePath.startsWith(
      resolved.mainRepo.endsWith('/') ? resolved.mainRepo : resolved.mainRepo + '/',
    );
  const finalCwdInMainRepo =
    resolved.mainRepo !== null &&
    finalCwd !== undefined &&
    (finalCwd === resolved.mainRepo ||
      finalCwd.startsWith(
        resolved.mainRepo.endsWith('/') ? resolved.mainRepo : resolved.mainRepo + '/',
      ));
  if (finalCwd === resolved.worktreePath || !isInternalWorktree || !finalCwdInMainRepo) {
    const reason =
      finalCwd === resolved.worktreePath
        ? 'Caller explicit cwd or external worktree default puts new session in this missing path → ENOENT inevitable.'
        : !isInternalWorktree
          ? 'External worktree (not in mainRepo subtree) cannot self-recover via cold-start enter_worktree (parent dir also missing).'
          : `Caller cwd "${finalCwd}" is not in mainRepo "${resolved.mainRepo}" subtree → cold-start enter_worktree cannot resolve mainRepo from caller cwd, will fail.`;
    return {
      result: err(
        `plan frontmatter worktree_path does not exist on disk: ${resolved.worktreePath}`,
        `worktree may have been archived (\`archive_plan\` removed it) / cross-device synced without working tree / manually removed. ` +
          `${reason} ` +
          `To resume, recreate worktree (\`git worktree add ${resolved.worktreePath} <branch>\`) and ensure plan frontmatter status=in_progress; or update plan frontmatter worktree_path to a valid path.`,
      ),
    };
  }
  // 此处: 约定 worktree (mainRepo subtree) + finalCwd 在 mainRepo subtree → 让 cold-start 自建。
  // 新 session 按 user CLAUDE.md §Step 3 cold-start 协议读 plan 后会调 enter_worktree
  // (mcp tool) 自建 worktree, 详 tools/index.ts:249-251 tool description。
  logger.warn(
    `[hand-off-session] conventional worktree missing on disk: ${resolved.worktreePath} — proceeding with cwd=${finalCwd}, new session expected to enter_worktree itself per cold-start protocol`,
  );
  return null;
}

/**
 * REVIEW_36 R2 MED-C：外置 worktree 场景下 finalCwd=worktreePath，
 * sandbox.allowWrite=[worktreePath, /tmp, cache] 不含 mainRepo → 接力 session
 * 写 mainRepo plan 文件被沙盒拦下（user CLAUDE.md §Step 4 完成时更新 frontmatter
 * status=completed 必写，不能拦）。修法：plan-driven + 外置 worktree → 自动加
 * mainRepo 进 extraAllowWrite。caller 显式传 args.extra_allow_write 优先（合并）。
 */
export function computeExtraAllowWrite(
  args: HandOffSessionArgs,
  resolved: ResolvedForCwd,
  finalCwd: string | undefined,
): readonly string[] | undefined {
  if (
    resolved.mode === 'plan' &&
    resolved.mainRepo &&
    resolved.worktreePath &&
    finalCwd === resolved.worktreePath
  ) {
    // 外置 worktree 路径已被 default cwd 推导降级到 worktreePath（HIGH-3 fix）→ 加 mainRepo 让 plan 文件可写
    const merged = new Set<string>(args.extra_allow_write ?? []);
    merged.add(resolved.mainRepo);
    return Array.from(merged);
  }
  // 约定 worktree（finalCwd=mainRepo 已含 mainRepo subtree 写权）/ generic 模式 → 仅 caller 显式
  return args.extra_allow_write;
}
