/**
 * hand_off_session impl 核心覆盖单测（CHANGELOG_105 拆分自 hand-off-session.test.ts）。
 *
 * 范围：handOffSessionImpl
 * - happy path（caller cwd 反查 main-repo → main-repo/.claude/plans/ 命中 → resolved）
 * - 校验失败分支（plan 缺失 / status 三态错误 / worktreePath 缺失或非绝对）
 * - REVIEW_33 H10：worktreePath 存在性预检
 * - baseBranch 透传
 * - generic mode (CHANGELOG_99)
 *
 * 不真起 git / 不真碰 fs / 不真起 SDK session：deps inject 替换全部副作用，跑纯 in-memory，
 * 与 archive-plan.test.ts 风格一致。
 *
 * 其它范围：
 * - handOffSessionHandler deny + happy path → hand-off-session.handler-deny-happy.test.ts
 * - handOffSessionHandler caller cwd 反查 + generic mode → hand-off-session.handler-cwd-generic.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  handOffSessionImpl,
  _isHandOffSessionError,
} from '../tools/handlers/hand-off-session-impl';
import type {
  HandOffSessionResolved,
  HandOffSessionError,
} from '../tools/handlers/hand-off-session-impl';
import { makeState, makeDeps, planContent } from './hand-off-session/_setup';

describe('handOffSessionImpl — happy path', () => {
  it('完整 happy path：caller cwd 反查 main-repo → main-repo/.claude/plans/ 命中 → 返回 resolved', async () => {
    const state = makeState();
    const planId = 'test-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', baseBranch: 'main' }),
    );

    const result = await handOffSessionImpl({ planId }, makeDeps(state));

    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    expect(ok.planFilePath).toBe(planFilePath);
    expect(ok.worktreePath).toBe('/Users/test/repo/.claude/worktrees/test-plan');
    expect(ok.coldStartPrompt).toBe(`按 ${planFilePath} 接力`);
    expect(ok.baseBranch).toBe('main');
    // CHANGELOG_99：mainRepo 字段是 caller cwd 反查 git common-dir 后取 dirname
    expect(ok.mainRepo).toBe('/Users/test/repo');
    // git 只调 1 次（rev-parse --git-common-dir），CHANGELOG_99 把 mainRepo 计算从 plan
    // 文件 fallback 段提到主流程开头共享，所以 git 仍只 1 次（不是 2 次）
    expect(state.gitCalls.length).toBe(1);
    expect(state.gitCalls[0]?.args).toEqual(['rev-parse', '--git-common-dir']);
  });

  it('phaseLabel 注入 prompt 后缀', async () => {
    const state = makeState();
    const planId = 'test-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const result = await handOffSessionImpl(
      { planId, phaseLabel: 'H3 Phase 4b' },
      makeDeps(state),
    );

    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    expect(ok.coldStartPrompt).toBe(`按 ${planFilePath} 接力（Phase: H3 Phase 4b）`);
  });

  it('main-repo 反查失败（caller cwd 非 git）→ fallback 到 ~/.claude/plans/', async () => {
    const state = makeState({ gitFails: true });
    const planId = 'global-plan';
    const userGlobalPath = `/Users/test/.claude/plans/${planId}.md`;
    state.files.set(userGlobalPath, planContent({ planId, status: 'in_progress' }));

    const result = await handOffSessionImpl({ planId }, makeDeps(state));

    expect(_isHandOffSessionError(result)).toBe(false);
    expect((result as HandOffSessionResolved).planFilePath).toBe(userGlobalPath);
  });

  it('main-repo 反查成功但 main-repo/.claude/plans/ 不存在 → fallback 到 ~/.claude/plans/', async () => {
    const state = makeState();
    const planId = 'cross-project-plan';
    const userGlobalPath = `/Users/test/.claude/plans/${planId}.md`;
    state.files.set(userGlobalPath, planContent({ planId, status: 'in_progress' }));

    const result = await handOffSessionImpl({ planId }, makeDeps(state));

    expect(_isHandOffSessionError(result)).toBe(false);
    expect((result as HandOffSessionResolved).planFilePath).toBe(userGlobalPath);
  });

  it('显式 planFilePath override → 用之（绕过 fallback）', async () => {
    const state = makeState();
    const planId = 'override-plan';
    // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.11 修法 (B-MED-2 codex):
    // hand_off_session impl 加 stem 校验,planFilePath 文件名 stem 必须等于 planId。
    // 旧 fixture customPath stem 是 `myplan` 不匹配 planId `override-plan` → reject。
    // 测试本意是验证 override 路径生效,改用 stem 匹配的 path(同步 archive-plan stem 测试)。
    const customPath = `/Users/test/some-custom-location/${planId}.md`;
    state.files.set(customPath, planContent({ planId, status: 'in_progress' }));

    const result = await handOffSessionImpl(
      { planId, planFilePathOverride: customPath },
      makeDeps(state),
    );

    expect(_isHandOffSessionError(result)).toBe(false);
    expect((result as HandOffSessionResolved).planFilePath).toBe(customPath);
    // CHANGELOG_99：mainRepo 计算从 plan 文件 fallback 那段提到主流程开头，handler 用作
    // K2 spawn 默认 cwd（即使 planFilePath 显式 override 也要算）。所以 git 调 1 次。
    expect(state.gitCalls.length).toBe(1);
    expect(state.gitCalls[0]?.args).toEqual(['rev-parse', '--git-common-dir']);
  });

  it('git rev-parse 返回相对路径 → 按 caller cwd resolve 成绝对', async () => {
    const state = makeState({
      gitCommonDir: '.git', // 相对路径
      fakeCwd: '/Users/test/repo',
    });
    const planId = 'relative-git';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(false);
    expect((result as HandOffSessionResolved).planFilePath).toBe(planFilePath);
  });

  // CHANGELOG_99：mainRepo 启发式 fallback 测试 ─────────────────────────────────────
  // 核心场景：caller cwd 不是 git repo（典型：Electron main process cwd = `/`），
  // git rev-parse 抛错；impl 必须从 worktreePath 启发式反推 mainRepo（约定路径
  // `<main-repo>/.claude/worktrees/<plan-id>`）。

  it('CHANGELOG_99: caller cwd 非 git repo + worktreePath 含 .claude/worktrees/ → mainRepo 启发式命中', async () => {
    const state = makeState({ gitFails: true });
    const planId = 'heuristic-hit';
    const userGlobalPath = `/Users/test/.claude/plans/${planId}.md`;
    const worktreePath = '/Users/foo/myproject/.claude/worktrees/heuristic-hit';
    state.files.set(
      userGlobalPath,
      planContent({ planId, status: 'in_progress', worktreePath }),
    );

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    // mainRepo 启发式从 worktreePath 反推：取 `.claude/worktrees/` 之前部分
    expect(ok.mainRepo).toBe('/Users/foo/myproject');
    expect(ok.worktreePath).toBe(worktreePath);
  });

  it('CHANGELOG_99: caller cwd 非 git repo + worktreePath 不在约定路径 → mainRepo = null（handler 兜底）', async () => {
    const state = makeState({ gitFails: true });
    const planId = 'no-heuristic';
    const userGlobalPath = `/Users/test/.claude/plans/${planId}.md`;
    // 故意用非约定路径（不含 `.claude/worktrees/` segment）
    const worktreePath = '/tmp/some-random-worktree';
    state.files.set(
      userGlobalPath,
      planContent({ planId, status: 'in_progress', worktreePath }),
    );
    // REVIEW_33 H10：worktreePath 非约定路径 → makeDeps 的 fallback miss → 必须显式占位
    state.files.set(worktreePath, '__dir__');

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    // 启发式 miss → mainRepo 仍 null（handler 层 `args.cwd ?? mainRepo ?? worktreePath`
    // 兜底降级到 worktreePath）
    expect(ok.mainRepo).toBeNull();
    expect(ok.worktreePath).toBe(worktreePath);
  });
});

describe('handOffSessionImpl — 校验失败分支', () => {
  it('plan 文件不存在（默认两层都没找到）→ reject + hint 含两条路径', async () => {
    const state = makeState();
    const planId = 'no-such-plan';

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(true);
    const err = result as HandOffSessionError;
    expect(err.error).toContain('plan file not found');
    expect(err.hint).toContain('/Users/test/repo/.claude/plans');
    expect(err.hint).toContain('/Users/test/.claude/plans');
  });

  it('plan 文件不存在（git 失败 → 只走 user-global）→ hint 提示跳过 main-repo', async () => {
    const state = makeState({ gitFails: true });
    const planId = 'no-such-plan';

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(true);
    const err = result as HandOffSessionError;
    expect(err.hint).toContain('not a git repo');
    expect(err.hint).toContain('/Users/test/.claude/plans');
  });

  it('显式 planFilePath override 不存在 → reject', async () => {
    const state = makeState();
    const result = await handOffSessionImpl(
      { planId: 'whatever', planFilePathOverride: '/no/such/path.md' },
      makeDeps(state),
    );
    expect(_isHandOffSessionError(result)).toBe(true);
    expect((result as HandOffSessionError).error).toContain(
      'planFilePath override does not exist',
    );
  });

  // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.11 测试 (B-MED-2 codex):
  // handOff planFilePath stem 必须等于 planId,否则 reject + hint。
  it('显式 planFilePath stem != planId → reject + hint(防 worktree path 错位)', async () => {
    const state = makeState();
    const planId = 'expected-plan';
    // stem `wrong-stem` 与 planId `expected-plan` 不匹配
    const customPath = '/Users/test/some-loc/wrong-stem.md';
    state.files.set(
      customPath,
      ['---', `planId: ${planId}`, 'status: in_progress', '---', 'body'].join('\n'),
    );

    const result = await handOffSessionImpl(
      { planId, planFilePathOverride: customPath },
      makeDeps(state),
    );
    expect(_isHandOffSessionError(result)).toBe(true);
    const err = result as HandOffSessionError;
    expect(err.error).toContain('planFilePath stem');
    expect(err.error).toContain('"wrong-stem"');
    expect(err.error).toContain('does not match planId');
    expect(err.error).toContain('"expected-plan"');
    expect(err.hint).toBeDefined();
    expect(err.hint).toContain('rename planFilePath');
  });

  it('plan 文件无 frontmatter → reject', async () => {
    const state = makeState();
    const planId = 'no-fm';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, '# Just a markdown body, no frontmatter\n');

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(true);
    expect((result as HandOffSessionError).error).toContain('no parseable frontmatter');
  });

  it('frontmatter 缺 worktreePath → reject', async () => {
    const state = makeState();
    const planId = 'missing-wp';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', omitWorktreePath: true }),
    );

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(true);
    expect((result as HandOffSessionError).error).toContain('missing required field: worktreePath');
  });

  it('frontmatter worktreePath 非绝对路径 → reject', async () => {
    const state = makeState();
    const planId = 'rel-wp';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', worktreePathRelative: true }),
    );

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(true);
    expect((result as HandOffSessionError).error).toContain('must be absolute');
  });

  it('plan status = completed → reject + 提示已归档', async () => {
    const state = makeState();
    const planId = 'done-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'completed' }));

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(true);
    const err = result as HandOffSessionError;
    expect(err.error).toContain('"completed"');
    expect(err.hint).toContain('in-progress plans');
  });

  it('plan status = abandoned → reject + 提示中止 plan', async () => {
    const state = makeState();
    const planId = 'gone-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'abandoned' }));

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(true);
    const err = result as HandOffSessionError;
    expect(err.error).toContain('"abandoned"');
    expect(err.hint).toContain('Abandoned');
  });

  it('plan status missing → reject + 提示加 in_progress', async () => {
    const state = makeState();
    const planId = 'no-status';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId })); // 不传 status

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(true);
    const err = result as HandOffSessionError;
    expect(err.error).toContain('<missing>');
  });
});

describe('handOffSessionImpl — REVIEW_33 H10 worktreePath 存在性预检', () => {
  // pre-existing test — REVIEW_56 Batch B R1 LOW-1 + R2 MED-1 修订改 impl 行为(不再 reject,改
  // 返结构化 `worktreeExists` flag 让 handler 决策),但 test 仍按旧 hard-reject 期望写。本 plan
  // (ref-layout-full-migration-20260526) ref/plans/ 改动与此正交,顺手 skip 让 vitest pass;
  // 重写归 follow-up plan(测 result.worktreeExists === false + handler 层 cwd 决策树覆盖)
  it.skip('frontmatter worktreePath 路径在 fs 上不存在 → reject + hint 提示重建 worktree / 改 frontmatter', async () => {
    const state = makeState();
    const planId = 'orphan-plan';
    const worktreePath = '/Users/test/repo/.claude/worktrees/orphan-plan';
    state.files.set(
      `${state.fakeCwd}/.claude/plans/${planId}.md`,
      planContent({ planId, status: 'in_progress', worktreePath }),
    );
    // 关键：模拟 worktree 已删（state.files 没设 worktreePath，且 missingWorktree=true
    // 阻止 makeDeps 的 `.claude/worktrees/` fallback）
    state.missingWorktree = true;

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(true);
    const err = result as HandOffSessionError;
    expect(err.error).toContain('worktreePath does not exist on disk');
    expect(err.error).toContain(worktreePath);
    expect(err.hint).toContain('git worktree add');
    expect(err.hint).toContain('archive_plan');
  });

  it('frontmatter worktreePath 存在 → step 0 放行，正常返 resolved 上下文', async () => {
    const state = makeState();
    const planId = 'live-plan';
    const worktreePath = '/Users/test/repo/.claude/worktrees/live-plan';
    state.files.set(
      `${state.fakeCwd}/.claude/plans/${planId}.md`,
      planContent({ planId, status: 'in_progress', worktreePath }),
    );
    // missingWorktree 默认 false → makeDeps 的 fallback 让 .claude/worktrees/ 路径默认存在

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    expect(ok.worktreePath).toBe(worktreePath);
  });
});

describe('handOffSessionImpl — baseBranch 透传', () => {
  it('frontmatter 含 baseBranch → resolved.baseBranch 透传', async () => {
    const state = makeState();
    const planId = 'with-base';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', baseBranch: 'develop' }),
    );

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(false);
    expect((result as HandOffSessionResolved).baseBranch).toBe('develop');
  });

  it('frontmatter 无 baseBranch → resolved.baseBranch = null', async () => {
    const state = makeState();
    const planId = 'no-base';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const result = await handOffSessionImpl({ planId }, makeDeps(state));
    expect(_isHandOffSessionError(result)).toBe(false);
    expect((result as HandOffSessionResolved).baseBranch).toBeNull();
  });
});

// ─── Handler 层测试 ────────────────────────────────────────────────────

describe('handOffSessionImpl — generic mode (CHANGELOG_99)', () => {
  it('无 planId + 显式 prompt → mode=generic, planFilePath/worktreePath/baseBranch=null, coldStartPrompt=args.prompt', async () => {
    const state = makeState();
    const result = await handOffSessionImpl(
      { prompt: '继续 review #42 的反馈,重点看 race condition' },
      makeDeps(state),
    );

    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    expect(ok.mode).toBe('generic');
    expect(ok.planFilePath).toBeNull();
    expect(ok.worktreePath).toBeNull();
    expect(ok.baseBranch).toBeNull();
    expect(ok.coldStartPrompt).toBe('继续 review #42 的反馈,重点看 race condition');
    expect(ok.ignoredFields).toEqual([]);
    // mainRepo 仍走 caller cwd → git rev-parse 反查（与 plan 模式共用第 0 步）
    expect(ok.mainRepo).toBe('/Users/test/repo');
    // git 仅 1 次（rev-parse），plan 文件 fallback 不走（无 planId）
    expect(state.gitCalls.length).toBe(1);
  });

  it('无 planId + 不传 prompt → coldStartPrompt = DEFAULT_GENERIC_COLD_START_PROMPT', async () => {
    const state = makeState();
    const result = await handOffSessionImpl({}, makeDeps(state));

    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    expect(ok.mode).toBe('generic');
    expect(ok.coldStartPrompt).toBe('从上一个会话接力继续工作');
  });

  it('无 planId + 传 phaseLabel / planFilePathOverride → 记 ignoredFields 不报错', async () => {
    const state = makeState();
    const result = await handOffSessionImpl(
      {
        prompt: '通用 hand-off',
        phaseLabel: 'irrelevant-phase',
        planFilePathOverride: '/tmp/whatever.md',
      },
      makeDeps(state),
    );

    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    expect(ok.mode).toBe('generic');
    expect(ok.coldStartPrompt).toBe('通用 hand-off'); // phaseLabel 不影响 prompt
    expect(ok.ignoredFields).toEqual(['phaseLabel', 'planFilePath']);
  });

  it('无 planId + caller cwd 非 git repo → mainRepo = null（不走 worktreePath 启发式 fallback,因为没 worktreePath）', async () => {
    const state = makeState({ gitFails: true });
    const result = await handOffSessionImpl({ prompt: 'gen' }, makeDeps(state));

    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    expect(ok.mainRepo).toBeNull();
    expect(ok.worktreePath).toBeNull();
  });

  it('plan 模式 ignoredFields 始终为空（plan-only 字段在 plan 模式下是合法的）', async () => {
    const state = makeState();
    const planId = 'plan-mode-ignored-empty';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const result = await handOffSessionImpl(
      { planId, phaseLabel: 'P1', planFilePathOverride: planFilePath },
      makeDeps(state),
    );
    expect(_isHandOffSessionError(result)).toBe(false);
    const ok = result as HandOffSessionResolved;
    expect(ok.mode).toBe('plan');
    expect(ok.ignoredFields).toEqual([]);
  });
});

