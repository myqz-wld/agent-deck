/**
 * REVIEW_74 MED 回归测试（deep-review batch B2 reviewer-claude + reviewer-codex 双方独立 + lead
 * /tmp harness 实测复现 lost update）：INDEX 单飞锁并发正确性。
 *
 * **被测 bug**：旧实现把 `indexSyncFlight.set` 排在 `await previousFlight` 之后 → ≥3 caller
 * 并发 archive 不同 planId 到同一 INDEX.md 时，第 2/3 个等待者都只 await 第 1 个（A），A 完成后
 * 二者并发跑各自 RMW 同读 A 写后 snapshot → 丢一行（silent INDEX corruption）。附带 finally
 * 只判 `stored !== undefined` 不校验身份 → 误删后到 caller 的锁。
 *
 * **修法验证**：set-before-await 真链式（每个 caller chain 在前一个之上而非都 chain 在 A）+
 * identity-check delete。本测试驱动真实 `runArchiveFs` + 真实 `indexSyncFlight` singleton，3
 * 个并发 caller（不同 planId → 同一 indexPath）各带 write delay 强制 thundering-herd 窗口，
 * 断言 3 行全部保留、Map 最终清空。
 *
 * 直接 import submodule（impl-archive-fs / _impl-shared）而非走 facade：本测试专测子模块的
 * 并发契约，需要真实 indexSyncFlight Map 实例。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { runArchiveFs } from '../tools/handlers/archive-plan/impl-archive-fs';
import {
  DEFAULT_DEPS,
  indexSyncFlight,
} from '../tools/handlers/archive-plan/_impl-shared';
import type {
  ArchivePlanDeps,
  ArchivePlanError,
  ArchivePlanInput,
} from '../tools/handlers/archive-plan/_impl-shared';

const MAIN_REPO = '/Users/test/repo';
const INDEX_PATH = `${MAIN_REPO}/ref/plans/INDEX.md`;

/**
 * 共享 in-memory INDEX「文件」+ deps 工厂。所有 caller 共用同一 files Map（同一 indexPath）
 * 模拟真实并发 RMW。
 *
 * **关键**：write delay 仅作用于 INDEX_PATH 的 writeFile（lock 内 RMW 的 read→write 窗口），
 * archivedPath 等 lock 外 write 保持即时 → 3 个 caller 几乎同时抵达 INDEX 单飞锁，撑开
 * thundering-herd 窗口（旧 bug：B/C 都只 await A，A 完成后并发 RMW 丢行）。
 */
function makeConcurrentDeps(files: Map<string, string>, indexWriteDelayMs: number): Required<ArchivePlanDeps> {
  const deps: Partial<ArchivePlanDeps> = {
    exists: async (p: string) => files.has(p),
    readFile: async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT mock ${p}`);
      return c;
    },
    writeFile: async (p: string, content: string) => {
      // 仅 INDEX RMW 的 write 留 async gap（read 之后、write 之前）让未串行化的并发 RMW
      // 互相覆盖（旧 bug 触发窗口）；archivedPath 等 lock 外 write 即时完成，保证 3 caller
      // 几乎同时抵达 lock。
      if (p === INDEX_PATH) {
        await new Promise((r) => setTimeout(r, indexWriteDelayMs));
      }
      files.set(p, content);
    },
    mkdir: async () => {
      /* archivedDir mkdir no-op */
    },
    unlink: async () => {
      /* 原 plan 在 ref/plans/ 内 = archivedPath，path.resolve 相等 → 不 unlink；no-op 兜底 */
    },
  };
  return { ...DEFAULT_DEPS, ...deps } as Required<ArchivePlanDeps>;
}

/** 单个 caller 跑 runArchiveFs 的 archive-fs 阶段（含 INDEX 单飞锁 RMW）。 */
async function archiveOne(
  planId: string,
  files: Map<string, string>,
  indexWriteDelayMs: number,
): Promise<void> {
  const deps = makeConcurrentDeps(files, indexWriteDelayMs);
  // 原 plan 路径 = archivedPath（都在 ref/plans/<id>.md），让 step 10 / step 12 path.resolve
  // 相等分支命中 → 跳过 silent-override 检测 / 跳过 unlink，只聚焦 INDEX 单飞锁 RMW。
  const archivedPath = `${MAIN_REPO}/ref/plans/${planId}.md`;
  const input: ArchivePlanInput = { planId, worktreePath: `${MAIN_REPO}/.claude/worktrees/${planId}` };
  const warnings: string[] = [];
  const result = await runArchiveFs(input, deps, warnings, {
    mainRepo: MAIN_REPO,
    planFilePath: archivedPath,
    archivedDir: `${MAIN_REPO}/ref/plans`,
    archivedPath,
    indexPath: INDEX_PATH,
    freshFm: { plan_id: planId },
    freshContent: `---\nplan_id: ${planId}\n---\nbody ${planId}\n`,
    finalCommit: `commit-${planId}`,
  });
  if ((result as ArchivePlanError).error) {
    throw new Error(`archive ${planId} failed: ${(result as ArchivePlanError).error}`);
  }
}

describe('INDEX 单飞锁并发正确性 — REVIEW_74 MED', () => {
  beforeEach(() => {
    indexSyncFlight.clear();
  });
  afterEach(() => {
    indexSyncFlight.clear();
  });

  it('3 caller 并发 archive 不同 planId 到同一 INDEX → 3 行全部保留(无 lost update)', async () => {
    // 初始 INDEX 已有 header（4 列 canonical），3 个 caller append 各自行
    const files = new Map<string, string>([
      [
        INDEX_PATH,
        '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n',
      ],
    ]);

    // 同时发起 3 个 caller（同一 INDEX write delay 让三者几乎同时抵达 lock，撑开
    // thundering-herd 窗口）。旧 bug 下 B/C 都只 await A → A 完成后并发 RMW → 丢一行。
    await Promise.all([
      archiveOne('plan-aaa-20260531', files, 20),
      archiveOne('plan-bbb-20260531', files, 20),
      archiveOne('plan-ccc-20260531', files, 20),
    ]);

    const finalIndex = files.get(INDEX_PATH)!;
    // 3 行全部存在（旧 bug 会丢中间到达的等待者行）
    expect(finalIndex).toContain('[plan-aaa-20260531.md](plan-aaa-20260531.md)');
    expect(finalIndex).toContain('[plan-bbb-20260531.md](plan-bbb-20260531.md)');
    expect(finalIndex).toContain('[plan-ccc-20260531.md](plan-ccc-20260531.md)');
    // 行数：header(1) + separator(1) + 3 row = 表格区共 5 行含内容（用 row 计数更稳）
    const rowCount = (finalIndex.match(/^\| \[plan-/gm) ?? []).length;
    expect(rowCount).toBe(3);
  });

  it('并发结束后 indexSyncFlight Map 清空(identity-check delete 不残留 / 不误删)', async () => {
    const files = new Map<string, string>([
      [
        INDEX_PATH,
        '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n',
      ],
    ]);
    await Promise.all([
      archiveOne('plan-x-20260531', files, 20),
      archiveOne('plan-y-20260531', files, 20),
      archiveOne('plan-z-20260531', files, 20),
    ]);
    expect(indexSyncFlight.size).toBe(0);
  });
});
