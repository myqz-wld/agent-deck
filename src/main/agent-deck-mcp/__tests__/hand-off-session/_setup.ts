/**
 * hand-off-session 单测共享 fixture（CHANGELOG_105 拆分自 hand-off-session.test.ts）。
 *
 * 抽出 TestState / makeState / makeDeps / planContent helper，让 impl-core / handler-deny-happy
 * / handler-cwd-generic 三组 sub-test 复用。
 *
 * 不依赖 vi.mock（hand-off-session 用 deps inject 模式，副作用 fn 全部从 HandOffSessionDeps
 * 注入；handler 只在 sub-test 内部 vi.fn / vi.spyOn 局部 spy，无文件级 vi.mock），所以
 * setup helpers 可以放共享 module，无 hoisting 限制（与 archive-plan/_setup.ts 同款）。
 */

import type { HandOffSessionDeps } from '../../tools/handlers/hand-off-session-impl';

export interface TestState {
  files: Map<string, string>;
  gitCalls: Array<{ args: string[]; cwd: string }>;
  fakeCwd: string;
  fakeHomedir: string;
  /** 设为 true 时 runGit 抛 error（模拟 caller cwd 非 git repo） */
  gitFails: boolean;
  /** runGit 返回的 git common dir（默认 `<mainRepo>/.git`） */
  gitCommonDir: string;
  /** REVIEW_33 H10：设为 true 时 exists() 对 `.claude/worktrees/` 路径返 false，模拟 worktree 已删 */
  missingWorktree?: boolean;
}

export function makeState(overrides: Partial<TestState> = {}): TestState {
  return {
    files: new Map(),
    gitCalls: [],
    fakeCwd: '/Users/test/repo',
    fakeHomedir: '/Users/test',
    gitFails: false,
    gitCommonDir: '/Users/test/repo/.git',
    ...overrides,
  };
}

export function makeDeps(state: TestState): HandOffSessionDeps {
  return {
    runGit: async (args: string[], cwd: string) => {
      state.gitCalls.push({ args, cwd });
      if (state.gitFails) {
        throw new Error('not a git repository');
      }
      // 仅支持 rev-parse --git-common-dir（impl 只调这一个 git 子命令）
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return state.gitCommonDir;
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
    readFile: async (p) => {
      const c = state.files.get(p);
      if (c === undefined) throw new Error(`ENOENT: no mock file at ${p}`);
      return c;
    },
    exists: async (p) => {
      if (state.files.has(p)) return true;
      // REVIEW_33 H10：worktree dir 占位 fallback。impl 加了 worktreePath 存在性预检
      // (deps.exists(worktreePath))，但绝大多数测试 fixture 只在 state.files 里塞 plan
      // 文件、没塞 worktree dir。让 exists 对路径形态 `.claude/worktrees/<x>` 默认返 true
      // 模拟 worktree 总存在；想测「worktreePath 不存在」case 时 set state.missingWorktree=true。
      if (p.includes('/.claude/worktrees/') && !state.missingWorktree) return true;
      return false;
    },
    cwd: () => state.fakeCwd,
    homedir: () => state.fakeHomedir,
  };
}

/** 构造一个标准 plan 文件 fixture（in_progress + worktreePath + baseBranch） */
export function planContent(opts: {
  planId?: string;
  worktreePath?: string;
  status?: string;
  baseBranch?: string;
  omitWorktreePath?: boolean;
  worktreePathRelative?: boolean;
}): string {
  const lines = ['---', `plan_id: ${opts.planId ?? 'test-plan'}`];
  if (!opts.omitWorktreePath) {
    const wp = opts.worktreePathRelative
      ? '.claude/worktrees/test-plan'
      : opts.worktreePath ?? '/Users/test/repo/.claude/worktrees/test-plan';
    lines.push(`worktree_path: ${wp}`);
  }
  if (opts.status !== undefined) {
    lines.push(`status: ${opts.status}`);
  }
  if (opts.baseBranch !== undefined) {
    lines.push(`base_branch: ${opts.baseBranch}`);
  }
  lines.push('---', '', '# Plan body', '');
  return lines.join('\n');
}
