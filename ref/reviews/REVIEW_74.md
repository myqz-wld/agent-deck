# REVIEW_74 — 全项目 deep review 批 B2：archive_plan helper 层（_impl-shared / archive-fs / cleanup / precheck-helpers / index-sync-helpers）

> plan deep-review-project-20260531 Batch B2。承接 B1（REVIEW_73 facade+precheck+ff-merge），本批审 archive-plan 收口事务的 5 个 helper 文件（~1306 LOC）。
> 复用 §决策对抗 多轮异构对抗：reviewer-claude（claude-code adapter, Opus 4.7）+ reviewer-codex（codex-cli adapter, gpt-5.5）in-process SDK teammate + 三态裁决 + lead node/git/harness 实测取证。

## Scope

| 文件 | LOC | 职责 |
|---|---|---|
| `archive-plan/_impl-shared.ts` | 377 | 共享 types / helpers（isError / postFfMergeErr / isPostCommitArchiveError / formatLocalDate / stripFrontmatter）/ DEFAULT_DEPS / indexSyncFlight singleton |
| `archive-plan/impl-archive-fs.ts` | 282 | Step 9-12.5 mv plan + INDEX 同步（单飞锁 RMW）+ spike-reports/ 归档 |
| `archive-plan/impl-cleanup.ts` | 255 | Step 13-14 git add+commit（pathspec 隔离）+ marker release + worktree remove + branch -D |
| `archive-plan/precheck-helpers.ts` | 218 | mainRepo dirty precheck（porcelain -z NUL parser）+ baseBranch named-branch 校验 |
| `archive-plan/index-sync-helpers.ts` | 174 | INDEX 4 列 cell escape / changelog link / 行级 smart update / 2→4 列 header 升级 |

skip（B1 已审收口 commit ba0b609 / REVIEW_73）：`archive-plan.ts` / `archive-plan-impl.ts`（facade）/ `impl-precheck.ts` / `impl-ff-merge.ts`。

## 结论

**3 finding：1 HIGH ✅ + 1 MED ✅ + 1 INFO ✅，全部 fix + 回归 test**。双方 reviewer 在各自 scope 高度收敛（HIGH 双方独立 + MED 双方独立），无需交叉反驳轮。

---

### [HIGH] `_impl-shared.ts:333` — `isPostCommitArchiveError` regex `[a-z-]+` 漏判含大写字母的 post-commit phase（双方独立 + lead node 实测三重确认 ✅）

- **reviewer 来源**：reviewer-claude HIGH + reviewer-codex MED（双方独立提出 → ✅）。lead node 脚本实测复现（三重确认）。
- **问题**：`POST_COMMIT_PHASES` 3 个枚举里有 2 个含大写字母（`archive-rev-parse-HEAD` 的 `HEAD` / `git-branch-D` 的 `D`），但 regex `/^\[post-ff-merge:([a-z-]+)\]/` charset 只匹配 `[a-z-]+` → 遇大写 `H`/`D` 提前终止 → 后续 `\]` 匹配失败 → 整个 `match` 返回 `null` → 函数误判 `false`。只有全小写的 `git-worktree-remove` 能命中。
- **代码片段（修前）**：
  ```ts
  const POST_COMMIT_PHASES = new Set([
    'archive-rev-parse-HEAD', 'git-worktree-remove', 'git-branch-D',  // 后两者含大写
  ]);
  export function isPostCommitArchiveError(errorText: string): boolean {
    const m = errorText.match(/^\[post-ff-merge:([a-z-]+)\]/);  // ❌ [a-z-] 不含大写
    if (!m) return false;
    return POST_COMMIT_PHASES.has(m[1] as PostFfMergePhase);
  }
  ```
- **验证手段**：lead node 脚本对 3 phase 实测 `match`，铁证：
  - `archive-rev-parse-HEAD` → captured=**null** → result=**false** ❌
  - `git-worktree-remove` → captured=`git-worktree-remove` → result=true ✅
  - `git-branch-D` → captured=**null** → result=**false** ❌
- **影响面**：`archive-plan.ts:237` 用此函数决定「post-ff-merge late phase 失败时是否仍跑 `runBatonCleanup` 收口 team」。archive commit 已成功（plan 实质归档完成）但紧接 `git rev-parse HEAD`（拿 archive hash）或 `git branch -D` 失败时 → 本应识别为 post-commit → 跑 baton cleanup shutdown teammates。bug 导致这 2 phase 被误判为非 post-commit → **不跑 baton cleanup → teammate 成孤儿 dormant 未 closed**（正是 `_impl-shared.ts` POST_COMMIT_PHASES jsdoc 自承「本项目反复踩的残留场景」，也正是 B1/REVIEW_73 刚 land 的 late-phase baton 修法想覆盖的 3 phase 里漏了 2 个）。**bug 确定性触发非概率**。
- **B1 为何漏网**：REVIEW_73 的 late-phase 回归 test 只覆盖了唯一全小写的 `git-worktree-remove`，恰好绕过 bug；且 `isPostCommitArchiveError` 此前**无任何直接 unit test**。
- **修法**：改用 `startsWith` 遍历 `POST_COMMIT_PHASES` Set 做前缀匹配（闭合 `]` 纳入匹配保 prefix-safe），**彻底绕开 charset 维护负担**（未来 phase 名含数字/任意字符都不再 silent 漏判）。
  ```ts
  export function isPostCommitArchiveError(errorText: string): boolean {
    for (const phase of POST_COMMIT_PHASES) {
      if (errorText.startsWith(`[post-ff-merge:${phase}]`)) return true;
    }
    return false;
  }
  ```
- **回归 test**：`archive-plan.impl-r33.test.ts` 新增 describe 块穷举全部 11 phase（3 post-commit 全识别为 true + 8 early phase 全识别为 false + prefix-safe + 无 prefix）。**非空验证**：temp-revert 回 `[a-z-]+` → 2 case fail（`archive-rev-parse-HEAD` / `git-branch-D`）。

---

### [MED] `impl-archive-fs.ts:156-196` — INDEX 单飞锁 ≥3 并发退化 RMW race（丢行）+ finally delete 无身份校验（双方独立 + lead harness 实测复现 ✅）

- **reviewer 来源**：reviewer-claude MED + reviewer-codex MED（双方独立提出 → ✅）。lead `/tmp` node harness 实测复现 lost update。
- **问题**：单飞锁 `indexSyncFlight.set` 排在 `await previousFlight` **之后**。caller A 持锁期间 B、C 都到达 → 二者 `get` 到的 `previousFlight` 都是 A（各自都没先 set 自己）→ 都只 await A → A 完成后 B、C **并发**执行各自 RMW（互不 await）同读 A 写后 snapshot → 丢一行（silent INDEX corruption）。退化为「只串行化最后一个 set 者」。附带 finally 只判 `stored !== undefined` 不校验身份 → B 完成时误删 C 刚 set 的锁（注释自承「仅删自己设的那把锁」与实现不符）。
- **代码片段（修前）**：
  ```ts
  const previousFlight = indexSyncFlight.get(indexPath);
  if (previousFlight) { try { await previousFlight; } catch {} }  // B/C 都 await A
  const flightPromise = (async () => { /* read INDEX → await → write INDEX */ })();
  indexSyncFlight.set(indexPath, flightPromise.then(()=>undefined, ()=>undefined));  // set 太晚
  // finally: if (stored !== undefined) delete  // ❌ 无 identity check
  ```
- **验证手段**：lead `/tmp` node harness 1:1 抄此 pattern，3 路并发（A/B/C 同 INDEX delay）实测：`expected=3 actual=2 lost=B`。修法 harness 同款 3 路并发 → `lost=none + Map cleaned up`。
- **影响面**：触发需 ≥2 caller 并发 archive 同 repo 不同 plan 到同一 INDEX.md（多 hand-off session 并行收口）→ INDEX 丢一行（plan.md 本身已归档不丢，仅索引缺行，可手工补）。降 MED（非 HIGH）：触发罕见 + 后果限索引 + 锁注释已自承 best-effort in-process。
- **修法**：set-before-await 真链式（`myFlight` 内部先 await predecessor 再跑 RMW，把链 chain 在前一个之上而非都 chain 在 A；`indexSyncFlight.set` 提到 await **之前** → 下个 caller `get` 到本次 flight 当 predecessor → 真正串行）+ identity-check delete（`if (indexSyncFlight.get(indexPath) === myFlightTail) delete`）。同步修注释措辞。
- **回归 test**：新增 `archive-plan.impl-index-lock.test.ts`（驱动真实 `runArchiveFs` + 真实 `indexSyncFlight` singleton，3 caller 并发同一 INDEX，断言 3 行全保留 + Map 清空）。**非空验证**：temp-revert 回 set-after-await → `plan-bbb` 行丢失，test fail。

---

### [INFO] `precheck-helpers.ts:138` — rename/copy conflict 显示方向与人类 git 相反（codex + lead git 实测 ✅）

- **reviewer 来源**：reviewer-codex INFO（单方 + lead git 实测，cosmetic → ✅ 廉价 fix）。
- **问题**：`git status --porcelain=v1 -z` 的 rename/copy 字节顺序是 `new\0old`（filename=new, 第二段=old），但人类版 `git status` 显示 `old -> new`。旧实现 `paths.join(' -> ')` = `[new, old].join(' -> ')` = `new -> old`，方向与人类 git 相反，caller 看 conflict/hint 误读 rename 方向。
- **验证手段**：lead 临时 git repo 实测 `git mv old.txt new.txt` 后：人类版 porcelain `R old.txt -> new.txt`，`-z` 字节 `R  new.txt\0old.txt\0`。
- **影响面**：纯 display（commit message 注脚 + conflict hint）。path **匹配**逻辑走独立的 `paths` 数组检查 new/old 两段，不受 display 顺序影响 → 改 display 安全无功能影响。
- **修法**：`displayPath = paths.length > 1 ? \`${paths[1]} -> ${paths[0]}\` : paths[0]`（display 用 `old -> new` 与人类 git 一致）。同步修正 `archive-plan.mainrepo-clean.test.ts` 6 处 rename/copy display 期望（malformed single-path case 不受影响）。

---

## Follow-up（留用户回来决策，勿在 review 流程中自动改）

8. **[INFO] `impl-archive-fs.ts:148` INDEX 概要列 fallback 到 plan_id**（reviewer-claude INFO）：`rawSummary = freshFm.description ?? freshFm.plan_id ?? input.planId`，plan frontmatter 通常无 `description` 字段（注释自承「恒 fallback」）→ INDEX 第 4 列「概要」恒显示 planId 字符串无实际概要价值。功能无害属设计选择。如想让概要列有意义，可考虑读 plan §总目标首行 / frontmatter 加 `title` 字段 — 属功能增强非 bug，留用户决策。

## 未发现新问题的维度

git 命令注入（args 全数组传参无 shell 拼接）/ path 拼接（全 `path.join`/`path.relative`）/ precheck porcelain NUL parser 边角（R3 修法已覆盖 rename 双段 / 空格 path / untracked-all）/ spike-reports F8 同路径 guard / marker release F10 时序 / index-sync `upgradeIndexHeader` idempotent / commit pathspec 隔离 / source tracked precheck — 本轮均未发现新问题。

## 验证

- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）✅
- agent-deck-mcp 全套 **581 passed / 3 skipped**（36 test files，+15 新回归 test：13 phase 穷举 + 2 INDEX 锁并发）✅
- 3 finding fix 全部 temp-revert 验证非空（regex revert → 2 fail / lock revert → bbb 丢行 fail）
