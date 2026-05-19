/**
 * archive-plan 单测共享 fixture（CHANGELOG_105 拆分自 archive-plan.test.ts）。
 *
 * 抽出 TestState / makeState / makeDeps / fixtureHappyPath，让 impl-core / impl-r33 /
 * handler 三组 sub-test 复用。
 *
 * 不依赖 vi.mock（archive-plan 用 deps inject 模式，副作用 fn 全部从 ArchivePlanDeps
 * 注入，setup helpers 是普通 export），所以可以放共享 module，无 vi.mock hoisting 限制。
 *
 * **plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 测试补全**(B-HIGH-4 mainRepo dirty
 * precheck 引入的 mock 队列偏移修法):makeDeps 增加可选 `mainRepoStatus` opts(默认 ''
 * = clean) + 透明拦截 `['status', '--porcelain']` 在 mainRepo cwd 下的调用,不消耗 gitMockPlan
 * 队列。让所有现有 test 的 gitMockPlan 数组结构不变(已经按 worktree-status 之后 = base_branch
 * verify 之后 ... 顺序写),只在测试故意要验 mainRepo dirty 时显式传 `mainRepoStatus`。
 *
 * **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 1.2a 升级**:Phase 1.2a 抽
 * `assertMainRepoCleanForArchive` lambda 后,mainRepo precheck 用新 args
 * `['status', '--porcelain=v1', '-z']`(NUL 分隔)替代老 `['status', '--porcelain']`。
 * 拦截条件同步扩展识别新 args,默认仍返回 `''`(空 string 在 NUL parser 下解出 0 entries =
 * clean,行为兼容)。test 想测 dirty 时仍传 mainRepoStatus,但需用 NUL 分隔格式
 * (`'M file.ts\0'`),老 newline 格式 lambda parser 找不到 NUL 会解出 0 entries 不触发 dirty。
 *
 * 区分 cwd 是 mainRepo 还是 worktreePath 用 `state.recognizedMainRepos: Set<string>`
 * (fixtureHappyPath 默认填 `/Users/test/repo`,test 自定义时手动加)。
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
  /**
   * mainRepo 路径白名单。makeDeps 内部 runGit 拦 mainRepo `status --porcelain*` 调用
   * (老 `--porcelain` / 新 `--porcelain=v1 -z` 都拦),不消耗 queue,默认返回
   * makeDeps opts.mainRepoStatus。fixtureHappyPath 默认填 `/Users/test/repo`;
   * test 自定义其他 mainRepo 路径时手动 add。
   */
  recognizedMainRepos: Set<string>;
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
    // B-HIGH-4 mainRepo dirty precheck 配套:默认填本测试套件的标准 mainRepo `/Users/test/repo`,
    // 让 makeDeps 自动透明 mock `git status --porcelain` 返 ''(clean) 避免所有 test 显式
    // recognizedMainRepos.add(...)。test 想测 dirty 时传 makeDeps opts.mainRepoStatus = 'M file'。
    recognizedMainRepos: new Set(['/Users/test/repo']),
    ...overrides,
  };
}

/**
 * 构造一份模拟 deps，按 state.files / fakeCwd / fakeHomedir 等驱动行为。
 *
 * gitMockPlan 是按调用顺序逐条返回的 stdout 队列（默认 trim）。
 *
 * **opts.mainRepoStatus** (B-HIGH-4 mainRepo dirty precheck 配套):cwd 在
 * `state.recognizedMainRepos` 内 + args 是 `status --porcelain` / `status --porcelain=v1 -z`
 * → 透明返回 opts.mainRepoStatus(默认 '' = clean),不消耗 gitMockPlan 队列。仍记 gitCalls
 * (assertion 可见此 call,但 index 偏移交由 caller 自检)。
 *
 * **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 1.2a 升级**:lambda 用
 * `--porcelain=v1 -z`(NUL 分隔),拦截识别新 args 同样透明返回。dirty test 需用 NUL 分隔
 * 格式 mainRepoStatus(老 newline 格式 lambda parser 找不到 NUL 会解出 0 entries)。
 */
export function makeDeps(
  state: TestState,
  gitMockPlan: Array<string | Error>,
  opts: { mainRepoStatus?: string | Error } = {},
): ArchivePlanDeps {
  const queue = [...gitMockPlan];
  const mainRepoStatus = opts.mainRepoStatus ?? '';
  return {
    runGit: async (args: string[], cwd: string) => {
      // Phase 1 B-HIGH-4 修法配套:mainRepo status precheck 透明 mock,**不消耗 queue 也不 push
      // gitCalls**(让所有现有 test 的 gitCalls[idx] 期望 / 队列结构都不偏移)。worktreePath
      // status precheck 仍走 queue + 计入 gitCalls(cwd 不在 recognizedMainRepos 内)。
      //
      // **Phase 1.2a 升级**:同时识别新 args `['status', '--porcelain=v1', '-z']`
      // (lambda assertMainRepoCleanForArchive 内部调用)。
      const isMainRepoStatusOld =
        args.length === 2 && args[0] === 'status' && args[1] === '--porcelain';
      const isMainRepoStatusNew =
        args.length === 3 &&
        args[0] === 'status' &&
        args[1] === '--porcelain=v1' &&
        args[2] === '-z';
      if (
        (isMainRepoStatusOld || isMainRepoStatusNew) &&
        state.recognizedMainRepos.has(cwd)
      ) {
        if (mainRepoStatus instanceof Error) throw mainRepoStatus;
        return mainRepoStatus;
      }
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
  // plan deep-review-batch-a1-b-fixes-20260519 B-HIGH-4 配套:把 mainRepo 加到识别集,
  // makeDeps 自动 mock mainRepo status precheck 返 ''(clean) 不消耗 gitMockPlan 队列。
  state.recognizedMainRepos.add(mainRepo);
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
