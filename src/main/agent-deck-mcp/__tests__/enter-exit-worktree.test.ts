/**
 * enter_worktree / exit_worktree impl 单测（plan codex-handoff-team-alignment-20260518 P1 Step 1.5）。
 *
 * 范围:
 * - enterWorktreeImpl: happy path + 路径冲突 + branch 冲突 + base 优先级链 5 态
 * - exitWorktreeImpl: action='keep' + action='remove' clean + dirty reject + branch -D 保护 +
 *   worktree 已被手工删 idempotent + 跨 worktree marker reject
 * - setCwdReleaseMarker / clearCwdReleaseMarker seam 通过 deps inject mock(不真依赖 sessionRepo)
 *
 * 不真起 git / 不真碰 fs / 不真碰 DB: deps inject 替换全部副作用(与 archive-plan.impl-core.test.ts
 * 同款 deps inject 模式)。
 */

import { describe, expect, it } from 'vitest';
import {
  enterWorktreeImpl,
  _internalIsError as enterIsError,
  type EnterWorktreeDeps,
} from '../tools/handlers/enter-worktree-impl';
import {
  exitWorktreeImpl,
  _internalIsError as exitIsError,
  type ExitWorktreeDeps,
} from '../tools/handlers/exit-worktree-impl';

// ─── enter-worktree test helpers ──────────────────────────────────────────

interface EnterTestState {
  files: Map<string, string>;
  existingPaths: Set<string>;
  gitCalls: Array<{ args: string[]; cwd: string }>;
  markerWrites: Array<{ sid: string; marker: string }>;
  fakeCallerCwd: Map<string, string | null>;
  fakeHomedir: string;
}

function makeEnterState(overrides: Partial<EnterTestState> = {}): EnterTestState {
  return {
    files: new Map(),
    existingPaths: new Set(),
    gitCalls: [],
    markerWrites: [],
    fakeCallerCwd: new Map([['caller-sid', '/Users/test/repo/src']]),
    fakeHomedir: '/Users/test',
    ...overrides,
  };
}

function makeEnterDeps(
  state: EnterTestState,
  gitMockPlan: Array<string | Error>,
): EnterWorktreeDeps {
  const queue = [...gitMockPlan];
  return {
    runGit: async (args, cwd) => {
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
    exists: async (p) => state.existingPaths.has(p) || state.files.has(p),
    homedir: () => state.fakeHomedir,
    callerCwd: (sid) => state.fakeCallerCwd.get(sid) ?? null,
    setCwdReleaseMarker: (sid, marker) => {
      state.markerWrites.push({ sid, marker });
    },
  };
}

// ─── enterWorktreeImpl tests ──────────────────────────────────────────────

describe('enterWorktreeImpl — happy path + 路径冲突 + base 优先级', () => {
  // ─── TC3 happy path ────────────────────────────────────────────────────
  it('TC3 happy path: caller cwd 在 git repo 内 → 派生 worktree_path + branch + base=HEAD + setMarker', async () => {
    const state = makeEnterState();
    const deps = makeEnterDeps(state, [
      '/Users/test/repo',         // git rev-parse --show-toplevel
      '',                          // for-each-ref refs/heads/worktree-plan1 (branch 不存在)
      'headhash',                  // git rev-parse HEAD (base=head)
      '',                          // git worktree add
    ]);

    const result = await enterWorktreeImpl(
      { planId: 'plan1', callerSessionId: 'caller-sid' },
      deps,
    );

    expect(enterIsError(result)).toBe(false);
    if (enterIsError(result)) return;
    expect(result.worktreePath).toBe('/Users/test/repo/.claude/worktrees/plan1');
    expect(result.branchName).toBe('worktree-plan1');
    expect(result.baseCommit).toBe('headhash');
    expect(result.baseSource).toBe('head');
    expect(result.markerSet).toBe(true);

    // setMarker 被调用了一次,sid + marker 正确
    expect(state.markerWrites).toEqual([
      { sid: 'caller-sid', marker: '/Users/test/repo/.claude/worktrees/plan1' },
    ]);

    // git worktree add 命令格式正确
    const worktreeAddCall = state.gitCalls.find((c) => c.args[0] === 'worktree');
    expect(worktreeAddCall).toBeDefined();
    expect(worktreeAddCall?.args).toEqual([
      'worktree', 'add', '-b', 'worktree-plan1',
      '/Users/test/repo/.claude/worktrees/plan1', 'headhash',
    ]);
    expect(worktreeAddCall?.cwd).toBe('/Users/test/repo');
  });

  // ─── TC4 路径冲突 ──────────────────────────────────────────────────────
  it('TC4 路径冲突: worktree_path 已存在 → reject + marker 不写', async () => {
    const state = makeEnterState();
    state.existingPaths.add('/Users/test/repo/.claude/worktrees/plan1'); // worktree 路径已存在
    const deps = makeEnterDeps(state, [
      '/Users/test/repo', // git rev-parse --show-toplevel
      // 不会调到 for-each-ref,因为 worktree path 存在就 short-circuit
    ]);

    const result = await enterWorktreeImpl(
      { planId: 'plan1', callerSessionId: 'caller-sid' },
      deps,
    );

    expect(enterIsError(result)).toBe(true);
    if (!enterIsError(result)) return;
    expect(result.error).toContain('worktree path already exists');
    expect(result.hint).toContain('different worktree_path');
    // marker 没被写
    expect(state.markerWrites).toEqual([]);
  });

  it('TC4b branch 冲突: worktree path 不存在但 branch 已存在 → reject + marker 不写', async () => {
    const state = makeEnterState();
    const deps = makeEnterDeps(state, [
      '/Users/test/repo',          // git rev-parse --show-toplevel
      'worktree-plan1',             // for-each-ref → branch 已存在
    ]);

    const result = await enterWorktreeImpl(
      { planId: 'plan1', callerSessionId: 'caller-sid' },
      deps,
    );

    expect(enterIsError(result)).toBe(true);
    if (!enterIsError(result)) return;
    expect(result.error).toContain('branch already exists');
    expect(state.markerWrites).toEqual([]);
  });

  // ─── TC5 base 优先级 ───────────────────────────────────────────────────
  it('TC5a base=arg-base-commit (highest priority)', async () => {
    const state = makeEnterState();
    const deps = makeEnterDeps(state, [
      '/Users/test/repo',
      '',                      // for-each-ref branch 不存在
      // 不调 rev-parse HEAD/branch,因为有 base_commit
      '',                      // git worktree add
    ]);
    const result = await enterWorktreeImpl(
      {
        planId: 'plan1',
        callerSessionId: 'caller-sid',
        baseCommitOverride: 'aabbccdd',
      },
      deps,
    );
    expect(enterIsError(result)).toBe(false);
    if (enterIsError(result)) return;
    expect(result.baseCommit).toBe('aabbccdd');
    expect(result.baseSource).toBe('arg-base-commit');
  });

  it('TC5b base=arg-base-branch (resolve to branch HEAD)', async () => {
    const state = makeEnterState();
    const deps = makeEnterDeps(state, [
      '/Users/test/repo',
      '',                      // for-each-ref branch 不存在
      'branchhash',            // rev-parse <branch>
      '',                      // git worktree add
    ]);
    const result = await enterWorktreeImpl(
      {
        planId: 'plan1',
        callerSessionId: 'caller-sid',
        baseBranchOverride: 'develop',
      },
      deps,
    );
    expect(enterIsError(result)).toBe(false);
    if (enterIsError(result)) return;
    expect(result.baseCommit).toBe('branchhash');
    expect(result.baseSource).toBe('arg-base-branch');
  });

  it('TC5c base=frontmatter-base-commit (plan file 有 base_commit)', async () => {
    const state = makeEnterState();
    state.files.set('/Users/test/repo/.claude/plans/plan1.md', [
      '---',
      'plan_id: plan1',
      'base_commit: feedbeef',
      'base_branch: feature-x',
      '---',
      'body',
    ].join('\n'));
    const deps = makeEnterDeps(state, [
      '/Users/test/repo',
      '',                      // for-each-ref branch 不存在
      // 不调 rev-parse HEAD,因为 frontmatter.base_commit 命中
      '',                      // git worktree add
    ]);
    const result = await enterWorktreeImpl(
      { planId: 'plan1', callerSessionId: 'caller-sid' },
      deps,
    );
    expect(enterIsError(result)).toBe(false);
    if (enterIsError(result)) return;
    expect(result.baseCommit).toBe('feedbeef');
    expect(result.baseSource).toBe('frontmatter-base-commit');
  });

  it('TC5d base=frontmatter-base-branch (plan 仅有 base_branch)', async () => {
    const state = makeEnterState();
    state.files.set('/Users/test/repo/.claude/plans/plan1.md', [
      '---',
      'plan_id: plan1',
      'base_branch: feature-y',
      '---',
      'body',
    ].join('\n'));
    const deps = makeEnterDeps(state, [
      '/Users/test/repo',
      '',                      // for-each-ref branch 不存在
      'featurehash',           // rev-parse feature-y
      '',                      // git worktree add
    ]);
    const result = await enterWorktreeImpl(
      { planId: 'plan1', callerSessionId: 'caller-sid' },
      deps,
    );
    expect(enterIsError(result)).toBe(false);
    if (enterIsError(result)) return;
    expect(result.baseCommit).toBe('featurehash');
    expect(result.baseSource).toBe('frontmatter-base-branch');
  });

  // ─── TC5e arg-base-branch fail-fast(args 是 caller 显式传必须 valid) ─────
  it('TC5e args.base_branch resolve 失败 → reject (不 fallback HEAD)', async () => {
    const state = makeEnterState();
    const deps = makeEnterDeps(state, [
      '/Users/test/repo',
      '',                                            // for-each-ref branch 不存在
      new Error('fatal: ambiguous argument bad-br'), // rev-parse bad-br 失败
    ]);
    const result = await enterWorktreeImpl(
      {
        planId: 'plan1',
        callerSessionId: 'caller-sid',
        baseBranchOverride: 'bad-br',
      },
      deps,
    );
    expect(enterIsError(result)).toBe(true);
    if (!enterIsError(result)) return;
    expect(result.error).toContain('git rev-parse bad-br failed');
    expect(state.markerWrites).toEqual([]);
  });

  // ─── caller cwd 缺失 ───────────────────────────────────────────────────
  it('caller sessionId 不在 sessionRepo (callerCwd 返 null) → reject', async () => {
    const state = makeEnterState();
    state.fakeCallerCwd = new Map(); // 全空
    const deps = makeEnterDeps(state, []);
    const result = await enterWorktreeImpl(
      { planId: 'plan1', callerSessionId: 'missing-sid' },
      deps,
    );
    expect(enterIsError(result)).toBe(true);
    if (!enterIsError(result)) return;
    expect(result.error).toContain('has no cwd');
    expect(state.gitCalls).toEqual([]); // 没调 git,short-circuit
  });
});

// ─── exit-worktree test helpers ───────────────────────────────────────────

interface ExitTestState {
  gitCalls: Array<{ args: string[]; cwd: string }>;
  existingPaths: Set<string>;
  markerStore: Map<string, string | null>;
  markerClears: string[];
}

function makeExitState(overrides: Partial<ExitTestState> = {}): ExitTestState {
  return {
    gitCalls: [],
    existingPaths: new Set(),
    markerStore: new Map(),
    markerClears: [],
    ...overrides,
  };
}

function makeExitDeps(state: ExitTestState, gitMockPlan: Array<string | Error>): ExitWorktreeDeps {
  const queue = [...gitMockPlan];
  return {
    runGit: async (args, cwd) => {
      state.gitCalls.push({ args, cwd });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`runGit mock exhausted at call ${state.gitCalls.length}: ${args.join(' ')}`);
      }
      if (next instanceof Error) throw next;
      return next;
    },
    exists: async (p) => state.existingPaths.has(p),
    callerMarker: (sid) => state.markerStore.get(sid) ?? null,
    clearCwdReleaseMarker: (sid) => {
      state.markerClears.push(sid);
      state.markerStore.delete(sid);
    },
  };
}

// ─── exitWorktreeImpl tests ──────────────────────────────────────────────

describe('exitWorktreeImpl — keep / remove / 边角', () => {
  const WT = '/Users/test/repo/.claude/worktrees/plan1';

  it('action=keep + marker 持 worktree → 仅清 marker, 不删 worktree/branch', async () => {
    const state = makeExitState();
    state.existingPaths.add(WT);
    state.markerStore.set('caller-sid', WT);
    const deps = makeExitDeps(state, [
      `${WT.replace('/.claude/worktrees/plan1', '')}/.git`, // git-common-dir
    ]);

    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid', action: 'keep' },
      deps,
    );

    expect(exitIsError(result)).toBe(false);
    if (exitIsError(result)) return;
    expect(result.action).toBe('keep');
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.markerCleared).toBe(true);
    expect(state.markerClears).toEqual(['caller-sid']);
    // 仅 git-common-dir 调用,无 worktree remove / branch -D
    expect(state.gitCalls.length).toBe(1);
    expect(state.gitCalls[0].args).toEqual(['rev-parse', '--git-common-dir']);
  });

  it('action=remove + clean + branch 非保护 → worktree remove + branch -D + clear marker', async () => {
    const state = makeExitState();
    state.existingPaths.add(WT);
    state.markerStore.set('caller-sid', WT);
    const deps = makeExitDeps(state, [
      `/Users/test/repo/.git`, // git-common-dir
      '',                       // status --porcelain clean
      'worktree-plan1',         // branch --show-current
      '',                       // worktree remove
      '',                       // branch -D worktree-plan1
    ]);

    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid', action: 'remove' },
      deps,
    );

    expect(exitIsError(result)).toBe(false);
    if (exitIsError(result)) return;
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(state.markerClears).toEqual(['caller-sid']);
    // git 命令顺序: common-dir, status, branch --show-current, worktree remove, branch -d/-D
    expect(state.gitCalls.map((c) => c.args[0])).toEqual([
      'rev-parse', 'status', 'branch', 'worktree', 'branch',
    ]);
    expect(state.gitCalls[3].args).toEqual(['worktree', 'remove', WT]);
    // P5 Round 1 reviewer-codex M4 修法 (discard_changes 也保护未合并 commit):
    // 默认 discard_changes=false → 用 `branch -d` (lowercase) 只删已合并 branch (不丢未合并 commit);
    // 测试场景 mock branch 已合并(runGit mock 默认成功),`-d` 删除成功,branchDeleted=true。
    expect(state.gitCalls[4].args).toEqual(['branch', '-d', 'worktree-plan1']);
  });

  it('action=remove + worktree dirty + !discard_changes → reject + marker 不清', async () => {
    const state = makeExitState();
    state.existingPaths.add(WT);
    state.markerStore.set('caller-sid', WT);
    const deps = makeExitDeps(state, [
      `/Users/test/repo/.git`,
      ' M src/main/foo.ts', // dirty
    ]);

    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid', action: 'remove' },
      deps,
    );

    expect(exitIsError(result)).toBe(true);
    if (!exitIsError(result)) return;
    expect(result.error).toContain('uncommitted changes');
    expect(result.hint).toContain('discard_changes=true');
    // marker 没清
    expect(state.markerClears).toEqual([]);
    // 仅 git-common-dir + status 调用,无 worktree remove
    expect(state.gitCalls.length).toBe(2);
  });

  it('action=remove + dirty + discard_changes=true → --force + 通过', async () => {
    const state = makeExitState();
    state.existingPaths.add(WT);
    state.markerStore.set('caller-sid', WT);
    const deps = makeExitDeps(state, [
      `/Users/test/repo/.git`,
      // status 不被调用(discard_changes=true 跳过 clean 预检)
      'worktree-plan1',         // branch --show-current
      '',                       // worktree remove --force
      '',                       // branch -D
    ]);

    const result = await exitWorktreeImpl(
      {
        callerSessionId: 'caller-sid',
        action: 'remove',
        discardChanges: true,
      },
      deps,
    );

    expect(exitIsError(result)).toBe(false);
    if (exitIsError(result)) return;
    expect(result.worktreeRemoved).toBe(true);
    // worktree remove 带 --force
    const removeCall = state.gitCalls.find((c) => c.args[1] === 'remove');
    expect(removeCall?.args).toEqual(['worktree', 'remove', '--force', WT]);
  });

  it('branch 是保护清单 main → 不调 branch -D 但 worktree 仍删', async () => {
    const state = makeExitState();
    state.existingPaths.add(WT);
    state.markerStore.set('caller-sid', WT);
    const deps = makeExitDeps(state, [
      `/Users/test/repo/.git`,
      '',                  // status clean
      'main',              // branch --show-current = main (保护清单)
      '',                  // worktree remove (不调 branch -D)
    ]);

    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid', action: 'remove' },
      deps,
    );

    expect(exitIsError(result)).toBe(false);
    if (exitIsError(result)) return;
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(false); // main 保护不删
    // 验证没调 branch -D
    expect(state.gitCalls.find((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBeUndefined();
  });

  it('worktree 已被手工删 (path 不存在) → idempotent 清 marker 不视为 error', async () => {
    const state = makeExitState();
    // 不加入 existingPaths
    state.markerStore.set('caller-sid', WT);
    const deps = makeExitDeps(state, []); // 无 git 调用

    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid', action: 'remove' },
      deps,
    );

    expect(exitIsError(result)).toBe(false);
    if (exitIsError(result)) return;
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.markerCleared).toBe(true);
    expect(state.markerClears).toEqual(['caller-sid']);
    expect(state.gitCalls).toEqual([]); // 没调 git
  });

  // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.8 测试 (B-MED-2 claude):
  // worktree 已删 + clearCwdReleaseMarker 抛错 → 旧版默默吞错仍 markerCleared:true (脏状态),
  // 修后 catch return error + hint(partial-success 显式报告给 caller)。
  it('Step 3.8: worktree 已删 + clearCwdReleaseMarker throw → return error (不吞静默)', async () => {
    const state = makeExitState();
    state.markerStore.set('caller-sid', WT);
    const deps = makeExitDeps(state, []);
    // mock clearCwdReleaseMarker 抛错 (典型 DB lock / fs perm denied)
    deps.clearCwdReleaseMarker = () => {
      throw new Error('DB write failed: SQLITE_LOCKED');
    };

    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid', action: 'remove' },
      deps,
    );

    expect(exitIsError(result)).toBe(true);
    if (!exitIsError(result)) return;
    expect(result.error).toContain('worktree was already removed');
    expect(result.error).toContain('clearCwdReleaseMarker failed');
    expect(result.error).toContain('SQLITE_LOCKED');
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain('partial-success');
    expect(result.hint).toContain('Manual recovery');
  });

  it('caller marker 与 args.worktree_path 不一致 → reject 跨 worktree 操作', async () => {
    const state = makeExitState();
    const otherWt = '/Users/test/repo/.claude/worktrees/other-plan';
    state.markerStore.set('caller-sid', otherWt); // marker 指向 other-plan
    const deps = makeExitDeps(state, []);

    const result = await exitWorktreeImpl(
      {
        callerSessionId: 'caller-sid',
        action: 'remove',
        worktreePathOverride: WT, // arg 传 plan1 不匹配 marker
      },
      deps,
    );

    expect(exitIsError(result)).toBe(true);
    if (!exitIsError(result)) return;
    expect(result.error).toContain('does not match caller marker');
    expect(state.markerClears).toEqual([]); // 没清 marker
  });

  it('caller 既无 marker 又无 args.worktree_path → reject 无法解析', async () => {
    const state = makeExitState();
    const deps = makeExitDeps(state, []);

    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid', action: 'remove' },
      deps,
    );

    expect(exitIsError(result)).toBe(true);
    if (!exitIsError(result)) return;
    expect(result.error).toContain('cannot resolve worktree_path');
    expect(result.hint).toContain('enter_worktree first to set the marker');
  });
});
