/**
 * archive-plan 单测共享 fixture（CHANGELOG_105 拆分自 archive-plan.test.ts）。
 *
 * 抽出 TestState / makeState / makeDeps / fixtureHappyPath，让 impl-core / impl-r33 /
 * handler 三组 sub-test 复用。
 *
 * 不依赖 vi.mock（archive-plan 用 deps inject 模式，副作用 fn 全部从 ArchivePlanDeps
 * 注入，setup helpers 是普通 export），所以可以放共享 module，无 vi.mock hoisting 限制。
 */

import * as path from 'node:path';
import type { ArchivePlanDeps } from '../../tools/handlers/archive-plan-impl';

// ─── Test fixture: in-memory deps ────────────────────────────────────────

export interface TestState {
  files: Map<string, string>;
  gitCalls: Array<{ args: string[]; cwd: string }>;
  unlinks: string[];
  mkdirs: string[];
  writes: Array<{ path: string; content: string }>;
  fakeCwd: string;
  fakeHomedir: string;
  realpathMap: Map<string, string>;
}

export function makeState(overrides: Partial<TestState> = {}): TestState {
  return {
    files: new Map(),
    gitCalls: [],
    unlinks: [],
    mkdirs: [],
    writes: [],
    fakeCwd: '/Users/test/some-other-cwd',
    fakeHomedir: '/Users/test',
    realpathMap: new Map(), // canonical mapping; if missing, identity
    ...overrides,
  };
}

/**
 * 构造一份模拟 deps，按 state.files / fakeCwd / fakeHomedir 等驱动行为。
 *
 * gitMockPlan 是按调用顺序逐条返回的 stdout 队列（默认 trim）。
 */
export function makeDeps(
  state: TestState,
  gitMockPlan: Array<string | Error>,
): ArchivePlanDeps {
  const queue = [...gitMockPlan];
  return {
    runGit: async (args: string[], cwd: string) => {
      state.gitCalls.push({ args, cwd });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`runGit mock exhausted at call ${state.gitCalls.length}: ${args.join(' ')}`);
      }
      if (next instanceof Error) throw next;
      return next;
    },
    readFile: async (p) => {
      const c = state.files.get(p);
      if (c === undefined) throw new Error(`ENOENT: no mock file at ${p}`);
      return c;
    },
    writeFile: async (p, content) => {
      state.writes.push({ path: p, content });
      state.files.set(p, content);
    },
    unlink: async (p) => {
      state.unlinks.push(p);
      state.files.delete(p);
    },
    mkdir: async (p) => {
      state.mkdirs.push(p);
    },
    exists: async (p) => state.files.has(p),
    realpath: async (p) => state.realpathMap.get(p) ?? p,
    cwd: () => state.fakeCwd,
    homedir: () => state.fakeHomedir,
  };
}

// 标准 fixture：worktree clean + plan in_progress + cwd 在 worktree 外
export function fixtureHappyPath(): {
  state: TestState;
  input: {
    planId: string;
    worktreePath: string;
    baseBranch: string;
  };
  expectedMainRepo: string;
  expectedArchivedPath: string;
} {
  const state = makeState();
  const planId = 'mcp-bug-fix-20260513';
  const worktreePath = '/Users/test/repo/.claude/worktrees/mcp-bug-fix-20260513';
  const mainRepo = '/Users/test/repo';
  // REVIEW_33 H10：worktreePath 必须在 fixture 里标记存在（用空字符串占位标记目录），
  // 否则 archivePlanImpl step 0 的 deps.exists(worktreePath) 预检会拦在最前面。
  state.files.set(worktreePath, '__worktree_dir_placeholder__');
  // plan 文件在默认 main-repo/.claude/plans/ 路径
  const planFilePath = `${mainRepo}/.claude/plans/${planId}.md`;
  state.files.set(
    planFilePath,
    [
      '---',
      `plan_id: ${planId}`,
      'created_at: 2026-05-13',
      `worktree_path: ${worktreePath}`,
      'status: in_progress',
      'base_commit: abc123',
      '---',
      '',
      '# Plan body content',
      '',
      'Some details.',
    ].join('\n'),
  );
  return {
    state,
    input: { planId, worktreePath, baseBranch: 'main' },
    expectedMainRepo: mainRepo,
    expectedArchivedPath: path.join(mainRepo, 'plans', `${planId}.md`),
  };
}
