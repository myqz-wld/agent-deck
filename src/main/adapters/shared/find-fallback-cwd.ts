import { homedir } from 'node:os';
import { dirname } from 'node:path';

/**
 * **REVIEW_49 R1 follow-up MED-G**: 抽 `findFallbackCwd` 为 cross-adapter shared helper。
 *
 * 原 claude/recoverer.ts:637 + codex/recoverer.ts:430 两端 1:1 复制粘贴(逻辑全等仅注释
 * 措辞略不同 — claude 端有 CHANGELOG_99 R1 fix MED-3/LOW-2 详细溯源,codex 端注释精简)。
 * 抽 helper 后两端 protected method 改为调本 helper,SSOT 单源不再需双端同步;test 仍可
 * 通过 facade extend override class 内 protected method 定制启发式行为。
 *
 * **算法两阶启发式**:
 * 1. **路径含 `.claude/worktrees/<plan-id>(/.+)?` 段** → 取段之前部分(K2 老 session
 *    cwd=worktree 场景,worktree 删了 main repo 仍在);regex 允许 worktree 子目录命中
 *    main repo(CHANGELOG_99 R1 fix MED-3 修订)
 * 2. **父目录 walk** → 沿 dirname 链往上找第一个还存在的目录(覆盖手动 git worktree
 *    remove / 误删 / 跨设备同步丢目录等场景)。**安全边界**(CHANGELOG_99 R1 fix LOW-2):
 *    p 不能是 `/` / home 本身 / home 的祖先(`/Users` / `/`)/ 长度 ≤ 1 → 边界拒绝返回 null
 *
 * 找不到 → null(handler 上层 emit error + throw,不进 placeholder 路径)。
 *
 * **不持久化 fallback cwd**:本 helper 是纯函数 + best-effort + 不写库;sessionRepo.cwd
 * 不被本 helper 改写。理由:fallback 是 best-effort 不动持久 state,下次发消息再次 detect
 * → fallback,不贵(existsSync + regex)。让用户看 SessionDetail 还是认识"原本是哪个
 * worktree 的"history。caller 链路视角的最终持久化结果由 caller 调 createSession
 * + emit session-start + rename 决定,详 claude/recoverer.ts findFallbackCwd jsdoc。
 *
 * @param badCwd 已不存在的 cwd 字符串
 * @param cwdExistsThunk 注入点:测试可 mock 不依赖真 fs;生产用 `existsSync`
 * @returns fallback cwd(还存在的祖先目录或 main repo)或 null
 */
export function findFallbackCwd(
  badCwd: string,
  cwdExistsThunk: (p: string) => boolean,
): string | null {
  // 启发式 1:K2 老 session 模式(`<main-repo>/.claude/worktrees/<plan-id>(/.+)?` → 取 <main-repo>)
  const m = badCwd.match(/^(.+)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/);
  if (m && cwdExistsThunk(m[1]!)) {
    return m[1]!;
  }
  // 启发式 2:父目录 walk(不超过 home,避免 fallback 到 `/` / `/Users/<user>`)
  const home = homedir();
  let p = dirname(badCwd);
  for (let i = 0; i < 32; i++) {
    // p 是 `/` / home 本身 / home 的祖先(`/Users` / `/`)/ 长度 ≤ 1 → 边界拒绝
    const isAncestorOfHome = home === p || home.startsWith(p + '/');
    if (p === '/' || isAncestorOfHome || p.length <= 1) return null;
    if (cwdExistsThunk(p)) return p;
    const next = dirname(p);
    if (next === p) return null; // 已到根
    p = next;
  }
  return null;
}
