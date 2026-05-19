/**
 * hand_off_session handler 的实现层 — plan 文件路径 resolve + frontmatter parse +
 * status 校验 + cold-start prompt 构造（plan mcp-bug-and-feature-batch-20260513
 * Phase 4b Step 4b.2;CHANGELOG_99 双模式改造)。
 *
 * **抽 impl 子模块的动机**：与 archive-plan-impl 同款 — handler 入口（hand-off-session.ts）
 * 只做 deny external + caller 反查 + 调本 impl 拿到 resolved 上下文 + 调 spawnSessionHandler
 * 完成 spawn + 包 ok/err。fs / git / frontmatter 解析逻辑在这里，可单测时 inject deps mock
 * 走纯 in-memory，不需 vi.mock node 内置。
 *
 * **业务流程**(双模式分流):
 *
 * 0. 反查 mainRepo(caller cwd → `git rev-parse --git-common-dir`,两种模式共用)
 *
 * **plan-driven 模式**(input.planId 传):
 * 1. 解析 plan 文件路径：显式 planFilePathOverride > caller cwd 反查 main-repo →
 *    `<main-repo>/.claude/plans/<plan_id>.md` > `~/.claude/plans/<plan_id>.md`
 * 2. 读 plan + parseFrontmatter，校验 frontmatter 含 `worktree_path`
 * 3. 校验 plan status === 'in_progress'（拒 completed / abandoned / 缺 status）
 * 4. mainRepo 启发式 fallback(caller cwd 反查失败时从 worktreePath 反推)
 * 5. 构造 cold-start prompt：基础形式 `按 <plan-abs-path> 接力`；含 phase_label 时附
 *    `（Phase: <label>）` 后缀
 * 6. 返回 resolved 上下文 mode='plan'
 *
 * **generic 模式**(input.planId 不传,CHANGELOG_99):
 * 1. 不读 plan 文件 / 不要 worktree_path
 * 2. coldStartPrompt = input.prompt ?? '从上一个会话接力继续工作'
 * 3. planFilePath / worktreePath / baseBranch 全 null
 * 4. mainRepo 仍是 caller cwd 反查的结果(没 worktreePath 启发式 fallback)
 * 5. caller 在 generic 模式下传了 plan-only 字段(phaseLabel / planFilePathOverride)→
 *    返回 ignoredFields 警告(handler 透传给 ok return,caller 可见)
 * 6. 返回 resolved 上下文 mode='generic'
 *
 * **deps inject 模式**：默认实现走 Node 内置（child_process.execFile + fs/promises +
 * os.homedir + process.cwd），test 通过传 `deps` 参数完全替换为 in-memory mock。
 * 与 archive-plan-impl 完全同款。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { parseFrontmatter } from '@main/utils/frontmatter';
import { resolvePlanFilePath } from './plan-path-helpers';

const execFileAsync = promisify(execFile);

/** CHANGELOG_99：generic 模式默认 cold-start prompt(caller 不传 args.prompt 时用) */
export const DEFAULT_GENERIC_COLD_START_PROMPT = '从上一个会话接力继续工作';

export interface HandOffSessionInput {
  /**
   * 可选 plan id。**双模式分流锚点(CHANGELOG_99)**:
   * - 传 → plan-driven 模式(读 plan 文件 + 校验 frontmatter)
   * - 不传 → generic 模式(不读 plan,coldStartPrompt 来自 input.prompt 或默认)
   */
  planId?: string;
  /**
   * generic 模式 cold-start prompt(CHANGELOG_99)。plan-driven 模式忽略此字段
   * (cold-start prompt 自动构造为 `按 <plan-abs-path> 接力`)。
   * generic 模式不传 → 用 DEFAULT_GENERIC_COLD_START_PROMPT。
   */
  prompt?: string;
  /** 可选 phase_label，含值时附 prompt 后缀 `（Phase: <label>）`。**仅 plan-driven 模式有效**(CHANGELOG_99) */
  phaseLabel?: string;
  /** 显式 plan 文件路径，覆盖 fallback。**仅 plan-driven 模式有效**(CHANGELOG_99) */
  planFilePathOverride?: string;
}

/**
 * impl 解析后返回的「准备好可以 spawn」上下文。handler 拿这个 + 用户传的
 * adapter/team_name/permission_mode/cwd_override 等组装 spawn_session args。
 */
export interface HandOffSessionResolved {
  /** CHANGELOG_99：'plan' = plan-driven 模式 / 'generic' = 通用 hand-off(无 plan 前提) */
  mode: 'plan' | 'generic';
  /** plan-driven 模式:实际命中的 plan 文件绝对路径。generic 模式:null */
  planFilePath: string | null;
  /** plan-driven 模式:plan frontmatter 里的 worktree_path(绝对路径)。generic 模式:null */
  worktreePath: string | null;
  /** 构造好的 cold-start prompt(两种模式都有值;plan: 自动构造 / generic: input.prompt 或默认) */
  coldStartPrompt: string;
  /** plan frontmatter 里的 base_branch(plan 模式;generic 模式:null) */
  baseBranch: string | null;
  /**
   * caller cwd 反查 git common-dir 得到的 main repo 绝对路径，**handler 用作 K2 spawn 默认 cwd**
   * （CHANGELOG_99 cwd 失效根治）。优先级：
   * 1. caller cwd → `git rev-parse --git-common-dir` 反查（impl 现有机制）
   * 2. plan 模式下 反查失败 → 从 worktreePath 启发式反推 `^(.+)/\.claude/worktrees/[^/]+/?$` 取捕获组 1
   * 3. 全失败 → null（handler 兜底降级到 worktreePath / caller cwd 保持原行为）
   *
   * 为什么需要这个？历史上 K2 default cwd = worktreePath 让新 session 的 sessionRepo.cwd
   * 一开始就是 worktree 路径；archive_plan / git worktree remove 删 worktree 后 sessionRepo.cwd
   * 指向已删目录，recoverer 重启 SDK 撞「Path does not exist」弯绕错误链。改 default = mainRepo
   * 后新 session 行为与 EnterWorktree 模式对齐：sessionRepo.cwd 永远是 main repo，process.cwd
   * 经 cold-start prompt 的 EnterWorktree(path: ...) 进 worktree 干活；worktree 删了 sessionRepo
   * cwd 仍 valid。
   */
  mainRepo: string | null;
  /**
   * CHANGELOG_99:generic 模式下 caller 传了 plan-only 字段时记录被忽略的字段名(空数组 = 无警告)。
   * handler 透传到 ok return.ignoredFields,caller 可见。plan-driven 模式始终空数组。
   */
  ignoredFields: string[];
}

export type HandOffSessionError = { error: string; hint?: string };

export interface HandOffSessionDeps {
  /** 跑 git 子命令；返回 stdout（trim）。失败抛 error。仅用于反查 main-repo。 */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  /** 读文件 utf8。失败抛（典型 ENOENT）。 */
  readFile?: (filePath: string) => Promise<string>;
  /** 文件 / 目录是否存在（true / false，不抛）。 */
  exists?: (p: string) => Promise<boolean>;
  /** 当前进程 cwd。 */
  cwd?: () => string;
  /** $HOME 路径。 */
  homedir?: () => string;
}

const DEFAULT_DEPS: Required<HandOffSessionDeps> = {
  runGit: async (args, cwd) => {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 });
    return stdout.toString().trim();
  },
  readFile: async (p) => fs.readFile(p, 'utf8'),
  exists: async (p) => {
    try {
      const _: Stats = await fs.stat(p);
      void _;
      return true;
    } catch {
      return false;
    }
  },
  cwd: () => process.cwd(),
  homedir: () => os.homedir(),
};

function isError(x: HandOffSessionResolved | HandOffSessionError): x is HandOffSessionError {
  return (x as HandOffSessionError).error !== undefined;
}

export async function handOffSessionImpl(
  input: HandOffSessionInput,
  depsOverride?: HandOffSessionDeps,
): Promise<HandOffSessionResolved | HandOffSessionError> {
  const deps: Required<HandOffSessionDeps> = { ...DEFAULT_DEPS, ...depsOverride };

  // 0. 反查 mainRepo（CHANGELOG_99 cwd 失效根治 + 通用 hand-off）：单次 git rev-parse,
  // plan-driven 模式给 plan 文件 fallback + handler default cwd 共享;generic 模式给
  // handler default cwd 兜底用(caller cwd 偶尔为 main process cwd `/` 时反查必失败)。
  const callerCwd = deps.cwd();
  let mainRepo: string | null = null;
  try {
    const gitCommonDir = await deps.runGit(['rev-parse', '--git-common-dir'], callerCwd);
    const commonDirAbs = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(callerCwd, gitCommonDir);
    mainRepo = path.dirname(commonDirAbs);
  } catch {
    // caller cwd 不是 git repo（如 Electron main process cwd = `/`）→ 留 null，等校验完
    // worktreePath 再启发式反推(plan 模式 only)
    mainRepo = null;
  }

  // CHANGELOG_99:generic 模式分支(无 plan_id) — 早返回,不走 plan 文件解析路径
  if (input.planId === undefined) {
    // generic 模式:caller 在此模式下传 phaseLabel / planFilePathOverride 是无效的(语义不通)
    // —— 不报错(handler 透传 ok),仅记录 ignoredFields 警告字段
    const ignoredFields: string[] = [];
    if (input.phaseLabel !== undefined) ignoredFields.push('phase_label');
    if (input.planFilePathOverride !== undefined) ignoredFields.push('plan_file_path');

    return {
      mode: 'generic',
      planFilePath: null,
      worktreePath: null,
      coldStartPrompt: input.prompt ?? DEFAULT_GENERIC_COLD_START_PROMPT,
      baseBranch: null,
      mainRepo,
      ignoredFields,
    };
  }

  // CHANGELOG_99:以下为 plan-driven 模式(input.planId 已确认非 undefined)。
  const planId: string = input.planId;

  // 1. 解析 plan 文件路径：显式 > main-repo 反查 > user-global
  // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.9 修法 (B-MED-3 双方独立强冗余):
  // 抽 resolvePlanFilePath helper 共享 archive-plan-impl 同款 3 档 fallback (projectLocal >
  // projectArchived > userGlobal),修前漏中间档 `<main-repo>/plans/<id>.md` 导致已归档
  // plan 无法 hand-off。
  let planFilePath: string;
  if (input.planFilePathOverride) {
    if (!(await deps.exists(input.planFilePathOverride))) {
      return {
        error: `plan_file_path override does not exist: ${input.planFilePathOverride}`,
      };
    }
    // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.11 修法 (B-MED-2 codex):
    // plan_file_path 文件名 stem 必须等于 plan_id。否则 cold-start prompt `按 <plan-abs-path>
    // 接力` 中的 abs-path 是 caller 给的 plan_file_path 文件,但新 SDK session 走 user CLAUDE.md
    // §Step 3 cold-start 流程会从 frontmatter.worktree_path 自己 EnterWorktree,worktree 路径
    // 与 plan_id 关联(本 plan worktree-deep-review-batch-a1-b-fixes-20260519,plan_id 派生)。
    // stem != plan_id 时 caller 实际指向另一个 plan 的文件,新 session 路径混乱。impl 层
    // 校验给清晰 hint(schema 是 record shape 不支持 cross-field refine,故落 impl 与
    // archive-plan-impl L386-392 同款治法)。
    const overrideStem = path.basename(input.planFilePathOverride, '.md');
    if (overrideStem !== planId) {
      return {
        error: `plan_file_path stem "${overrideStem}" does not match plan_id "${planId}"`,
        hint: `worktree_path / plan-driven cold-start prompt are derived from plan_id. Mismatched stem would lead the new SDK session to the wrong plan. Either rename plan_file_path to "${planId}.md" or change plan_id to "${overrideStem}". 修法 plan §Phase 3 Step 3.11 (B-MED-2 codex)。`,
      };
    }
    planFilePath = input.planFilePathOverride;
  } else {
    const resolved = await resolvePlanFilePath(mainRepo, planId, {
      exists: deps.exists,
      homedir: deps.homedir,
    });
    if ('error' in resolved) {
      return resolved;
    }
    planFilePath = resolved.path;
  }

  // 2. 读 plan + parseFrontmatter
  let planContent: string;
  try {
    planContent = await deps.readFile(planFilePath);
  } catch (e) {
    return { error: `read plan file failed: ${(e as Error).message}` };
  }
  const fm = parseFrontmatter(planContent);
  if (Object.keys(fm).length === 0) {
    return {
      error: `plan file has no parseable frontmatter: ${planFilePath}`,
      hint: 'plan file must start with `---\\n<key>: <value>\\n---\\n` block (e.g. `worktree_path: /...` and `status: in_progress`).',
    };
  }

  // 3. 校验 worktree_path 字段
  const worktreePath = fm.worktree_path;
  if (!worktreePath || worktreePath.length === 0) {
    return {
      error: `plan frontmatter missing required field: worktree_path`,
      hint: `hand_off_session (plan-driven mode) needs worktree_path to set cwd for the new SDK session. Edit ${planFilePath} frontmatter to include \`worktree_path: <abs-path>\`.`,
    };
  }
  if (!path.isAbsolute(worktreePath)) {
    return {
      error: `plan frontmatter worktree_path must be absolute: ${worktreePath}`,
    };
  }
  // REVIEW_33 H10：worktreePath 存在性预检（absolute 校验之后）。
  // 旧实现只校 absolute 不查目录存在 → worktree 已被 archive_plan / 手工 git worktree
  // remove / 跨设备同步未带 working tree 时，spawn_session 拿这个 cwd 起新 SDK 会
  // ENOENT 一片（且 process.cwd() 在 main process 默认路径，调试线索断）。修法：先
  // exists 一次，缺失立即返结构化 error 提示「重建 worktree / 修正 plan frontmatter」。
  if (!(await deps.exists(worktreePath))) {
    return {
      error: `plan frontmatter worktree_path does not exist on disk: ${worktreePath}`,
      hint: `worktree may have been archived (\`archive_plan\` removed it) / cross-device synced without working tree / manually removed. To resume, recreate worktree (\`git worktree add ${worktreePath} <branch>\`) and ensure plan frontmatter status=in_progress; or update plan frontmatter worktree_path to a valid path.`,
    };
  }

  // 4. 校验 status === 'in_progress'
  const status = fm.status;
  if (status !== 'in_progress') {
    if (status === 'completed') {
      return {
        error: `plan status is "completed" — cannot start next session for archived plan`,
        hint: `Use hand_off_session (plan-driven mode) only for in-progress plans. If you need to resume work on this plan, manually edit frontmatter status back to in_progress.`,
      };
    }
    if (status === 'abandoned') {
      return {
        error: `plan status is "abandoned" — cannot start next session`,
        hint: `Abandoned plans are not meant to be resumed. Create a new plan if you want to restart this work.`,
      };
    }
    return {
      error: `plan status must be "in_progress" but got "${status ?? '<missing>'}"`,
      hint: `Edit ${planFilePath} frontmatter to set \`status: in_progress\` before calling hand_off_session (plan-driven mode).`,
    };
  }

  // 5. mainRepo 启发式 fallback（CHANGELOG_99）：caller cwd 反查 git common-dir 失败时
  // （如 Electron main process cwd = `/`），从 worktreePath 启发式反推。
  // 约定路径：`<main-repo>/.claude/worktrees/<plan-id>` → 取 .claude/worktrees/ 之前部分。
  // 用户用了非约定路径时启发式 miss → 仍 null → handler 兜底降级到 worktreePath（保持
  // 原行为，保证不崩）。
  if (mainRepo === null) {
    const m = worktreePath.match(/^(.+)\/\.claude\/worktrees\/[^/]+\/?$/);
    if (m) mainRepo = m[1];
  }

  // 6. 构造 cold-start prompt
  const baseBranch = fm.base_branch ?? null;
  const baseLine = `按 ${planFilePath} 接力`;
  const coldStartPrompt = input.phaseLabel
    ? `${baseLine}（Phase: ${input.phaseLabel}）`
    : baseLine;

  return {
    mode: 'plan',
    planFilePath,
    worktreePath,
    coldStartPrompt,
    baseBranch,
    mainRepo,
    ignoredFields: [], // plan 模式不会忽略字段
  };
}

// 测试 helper export
export { isError as _isHandOffSessionError };
