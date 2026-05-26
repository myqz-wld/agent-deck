---
plan_id: "summarizer-split-20260514"
created_at: "2026-05-14"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/summarizer-split-20260514"
status: "completed"
base_commit: "538e17b6c8ac225596c093f7059f79a659498f4e"
base_branch: "main"
final_commit: "2a7f9a2ebdc73cd63fae48a2a7c6201eae426627"
completed_at: "2026-05-14"
---
# summarizer.ts 625 LOC 拆分（档位 1：抽 module-level 纯函数）

## 总目标 & 不变量

- **目标**：把 `src/main/session/summarizer.ts` 从 625 LOC 拆到 ≤ 500 LOC（CLAUDE.md「单文件 ≤ 500 行」护栏）
- **不变量**：
  - 零业务行为变更（**纯物理拆分**，不动一行业务逻辑）
  - 现有 import 路径不变（外部 caller `from '@main/session/summarizer'` 仍工作）
  - typecheck + 现有 vitest 全过 0 失败
  - REVIEW_35 + Wave 1/2/R2 + follow-up 改动（commit cd1af8c / d2c9e68 / 4a85f68 / 914e33d）一字不改

## 设计决策（不再争论）

1. **拆分策略 = 档位 1（抽 module-level 纯函数到子目录）**
   - CLAUDE.md「单文件 ≤ 500 行」三档拆法：① module-level 纯函数 / 类型 / 常量 ② 目录化 sub-component ③ 拆 class
   - 档位 1 风险最低（纯物理 cut + import 调整，无 class state 边界改动）
   - summarizer 内的 `summariseViaLlm` / `summariseCodexSessionViaOneshot` (re-export) / `summariseSessionForHandOff` / `formatEventsForPrompt` / `summariseToolInput` / `truncate` / `localStatsFallback` 全是 module-level 纯函数 / helper —— 完美匹配档位 1
2. **目标结构**（建 `src/main/session/summarizer/` 子目录 + facade index.ts）：
   - `summarizer/index.ts` (~250 LOC) — Summarizer class + scanAll/summarize/getLastErrors/summarizeNow + start/stop/scheduleTimer 主类逻辑 + listener 注册（保留 `summarizer` 单例 export + 必要的 module-level helper re-export 给 codex runner / k3 hand-off）
   - `summarizer/llm-runners.ts` (~250 LOC) — `summariseViaLlm` + `summariseSessionForHandOff` 两个独立 oneshot helper（带各自 timeout race + interrupt 逻辑）
   - `summarizer/event-formatter.ts` (~115 LOC) — `formatEventsForPrompt` + `summariseToolInput` + `truncate` + `localStatsFallback` 4 个纯函数
3. **import 路径**：
   - 外部 caller `import { summarizer, summariseSessionForHandOff } from '@main/session/summarizer'` **保持不变**（TS module resolution 自动 fallback 到 `summarizer/index.ts`）
   - codex-cli/summarizer-runner.ts 仍 `from '@main/session/summarizer'` 拿 `formatEventsForPrompt`（如果它需要的话；当前是 caller 注入 fn，改动较小）
4. **不删任何注释 / docstring**：每段保留原 jsdoc 让新文件可读性同款
5. **REVIEW_35 R2 fix 优先保留**：
   - line 156 `summarize()` 的 codex Promise.race timeout 包装（HIGH-B1）
   - line 175 lastErrorBySession 在 LLM 真成功时才 delete（MED-B1）
   - line 30 + 47 session-renamed listener（MED-B2）
   - line 117 + 127 sessionRepo.get 预检防 rename FK race（HIGH-B1 R2）

## 步骤 checklist

- [x] Step 1 — EnterWorktree + ff-merge main + 写 plan
- [ ] Step 2 — 读全 `src/main/session/summarizer.ts` 625 行 + 列拆分点（哪些行进哪个文件）
- [ ] Step 3 — 建 `src/main/session/summarizer/` 子目录
- [ ] Step 4 — 抽 `summarizer/event-formatter.ts`（最纯，无依赖）
- [ ] Step 5 — 抽 `summarizer/llm-runners.ts`（依赖 event-formatter）
- [ ] Step 6 — 重写 `summarizer/index.ts` facade（Summarizer class + scanAll/summarize 主类 + 必要 re-export）
- [ ] Step 7 — 删原 `src/main/session/summarizer.ts`（git mv → 子目录 index.ts，保留历史）
- [ ] Step 8 — 跑 typecheck（首跑可能撞 import 路径调整）+ 修
- [ ] Step 9 — 跑 vitest（重点验证 hand-off.test.ts + summarizer 间接 test）+ 修
- [ ] Step 10 — wc -l 验证拆分后各文件 LOC：index.ts ≤ 250 / llm-runners.ts ≤ 280 / event-formatter.ts ≤ 130
- [ ] Step 11 — commit + 写 CHANGELOG_104 + INDEX 加行
- [ ] Step 12 — ExitWorktree(action: keep) + archive_plan 收尾

## 当前进度

Step 1 done。worktree HEAD = 538e17b6（main HEAD），pwd = `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/summarizer-split-20260514`。下一步 Step 2 读全 summarizer.ts 列拆分点。

## 下一会话第一步

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/summarizer-split-20260514.md` 读全 plan（**严禁用 Read tool**，详 user CLAUDE.md §Step 3 末 callout：跨会话 hand off cold start 第一次读 plan 必须用 Bash cat 防 SDK 缓存误用）
2. `EnterWorktree(path: '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/summarizer-split-20260514')` 进 worktree
3. `pwd` + `git log -1 --format='%H %s'` 确认 cwd + base commit = 538e17b6
4. `Bash: cat <worktree-abs-path>/src/main/session/summarizer.ts` 读全 625 行（同款 cat 防缓存）
5. 按 §设计决策 拆分到 `summarizer/` 子目录三文件（event-formatter → llm-runners → index facade 顺序）
6. 跑 typecheck + vitest 验证零业务行为变更
7. commit + CHANGELOG_104 + archive_plan

**所有指向代码资产的路径必须含 worktree 前缀** `<worktree-abs-path>/src/main/session/summarizer*`，绝不复用主仓库根级路径（详 user CLAUDE.md §Step 1 末 callout）

进度 / 决策变更必须先告诉用户征得确认。

## 已知踩坑

- **summarizer.ts 持续被 fix 增长**：原 546 → R2 fix 后 613 → follow-up commit 914e33d 后 625（rename listener / Promise.race / sessionRepo 预检 等修法都在原文件加注释）。拆分时**保留所有 REVIEW_35 注释**（HIGH-B1 / MED-B1 / MED-B2 / R2 HIGH-B1 等标记），让代码 archeology 可追溯
- **codex-cli/summarizer-runner.ts caller 注入**：`summariseCodexSessionViaOneshot` 在 codex-cli adapter 内单独定义，summarizer.ts 只是 caller 注入 `formatEventsForPrompt` fn —— 拆分时确认 `formatEventsForPrompt` export 路径还在（最简：从新 event-formatter.ts re-export 到 index.ts）
- **vitest 跑前 worktree 先 pnpm install**：worktree 缺 node_modules + electron binary 需单独 install.js（详 REVIEW_35 经验：`zsh -i -l -c "cd ...electron && node install.js"` + `pnpm install` 再跑 typecheck/test）
- **typecheck 0 错才能 commit**：拆分常见问题 = circular import（llm-runners 不要 import index）/ private state 误抽到 module level（需保留 class field）/ 注释错位
