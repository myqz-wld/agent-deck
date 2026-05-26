---
plan_id: "universal-message-watcher-split-20260514"
created_at: "2026-05-14"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/universal-message-watcher-split-20260514"
status: "completed"
base_commit: "cc9111a"
base_branch: "main"
final_commit: "5e3e8ced1d581f86d14a6d9b7318ff94c2a57eb7"
completed_at: "2026-05-14"
---
# 全仓库 ≤ 500 LOC 护栏达标拆分（CHANGELOG_103 follow-up 优先级 3 拆分护栏批量收口）

## 总目标

扫全仓库（src/ 含 __tests__）发现 11 个文件超 500 LOC，本 plan 一次性收口：

| 文件 | LOC | 处理 |
|---|---|---|
| `src/main/teams/universal-message-watcher.ts` | 581 | 拆 4 文件 |
| `src/preload/index.ts` | 524 | 拆 5 文件 |
| `src/renderer/components/SessionDetail/ComposerSdk.tsx` | 512 | 拆 4 文件 |
| `src/main/adapters/claude-code/sdk-bridge/index.ts` | 511 | **不拆**：CHANGELOG_52+85 已 4 轮深度拆分 + 仅超 11 行 + 拆 createSession 协调流程需档位 3 双对抗 → 写「不动文件保护清单」 |
| `src/main/agent-deck-mcp/__tests__/hand-off-session.test.ts` | 1373 | 拆按 describe |
| `src/main/agent-deck-mcp/__tests__/tools.test.ts` | 1227 | 拆按 describe |
| `src/main/agent-deck-mcp/__tests__/archive-plan.test.ts` | 1049 | 拆按 describe |
| `src/main/task-manager/__tests__/tools.test.ts` | 651 | 拆按 describe |
| `src/main/store/__tests__/agent-deck-repos.test.ts` | 641 | 拆按 repo |
| `src/main/adapters/generic-pty/__tests__/pty-bridge.test.ts` | 571 | 拆按 describe |
| `src/main/adapters/claude-code/__tests__/sdk-bridge.test.ts` | 554 | 拆按 describe |

每个文件**单独 commit**，最后一次写 CHANGELOG_105 + INDEX + sdk-bridge 保护清单 + archive_plan 收口。

## 不变量

1. **零业务行为变更**：纯物理拆分，不改一行业务逻辑
2. **外部 import 路径不变**：所有 `from '@main/...'` / `from '@renderer/...'` 调用方零改动（TS module resolution 自动 fallback 到 `<dir>/index.ts`）
3. **所有加固注释**（REVIEW_35 HIGH/MED/LOW、CHANGELOG_99/100/101/102/103 修复、reviewer 加固标记等）一字不改迁移
4. **测试零行为变更**：拆分后 vitest 全过；test setup/teardown / mock instance / shared state 完整迁移

## 设计决策（不再争论）

### 决策 1：拆分档位

档位 1（抽 module-level 纯函数 / 类型 / 常量），与 CHANGELOG_104 同款。所有 class 整体保留。**不**拆 class 本身（档位 3 风险高）。

### 决策 2：sdk-bridge/index.ts 不拆

写「不动文件保护清单」+ 注明理由，下次拆分轮跳过。

### 决策 3：测试文件按 describe 顶级拆

每个 `describe(...)` 顶级 block 抽到独立子文件 + 公共 setup/teardown / mock factory 抽到 `<test-file>/_setup.ts` 共用。

### 决策 4：每个文件单独 commit

11 个文件 → 10 个独立 commit（sdk-bridge 保护清单合到 CHANGELOG_105 commit），最后 1 个 commit 写 CHANGELOG_105 + INDEX。

### 决策 5：worktree 路径前缀

所有 Edit/Write/Read/Grep 操作用 `<worktree-abs-path>/<rel>`：
`/Users/apple/Repository/personal/agent-deck/.claude/worktrees/universal-message-watcher-split-20260514/...`

## 各文件拆分方案

### 1. universal-message-watcher.ts (581) → 4 文件 (~70 + 80 + 155 + 325 LOC)

```
universal-message-watcher/
  ├── rate-limiter.ts                ~70 LOC   PerKeyRateLimiter class + messageRateLimiter 单例
  ├── enqueue.ts                     ~80 LOC   EnqueueMessageInput + enqueueAgentDeckMessage
  ├── team-event-dispatcher.ts      ~155 LOC   TeamEventDispatcher class + 单例
  └── index.ts                      ~325 LOC   UniversalMessageWatcher 主类 + buildWireBody + resolveFromDisplayName + 常量 + 单例 + facade re-export
```

### 2. preload/index.ts (524) → 5 文件 + facade

```
preload/
  ├── index.ts                  ~30 LOC    spread 拼装 + contextBridge.expose + typeof 导出
  └── api/
      ├── sessions.ts           ~80 LOC    sessions + listEvents + listFileChanges + summaries + handOff
      ├── adapters.ts           ~150 LOC   adapters + permissions + askUserQuestion + exitPlanMode + sandbox restart
      ├── teams.ts              ~140 LOC   agent-deck teams + messages + tasks
      ├── misc.ts               ~140 LOC   window + hook + settings + dialog + claude-md + assets + summarizer + image
      └── events.ts             ~50 LOC    onAgentEvent / onSessionUpserted / onSessionRemoved / ...
```

### 3. ComposerSdk.tsx (512) → 4 文件

```
SessionDetail/
  ├── ComposerSdk.tsx              ~340 LOC  主组件 (hooks + handlers + JSX 主结构)
  └── composer-sdk/
      ├── ImageIcon.tsx            ~20 LOC   inline SVG icon
      ├── ErrorBanner.tsx          ~30 LOC   通用错误条 (5 处复用)
      └── SandboxSelects.tsx       ~120 LOC  PermissionModeSelect + CodexSandboxSelect + ClaudeCodeSandboxSelect (3 select rows)
```

### 4-10. 测试文件按 describe 拆

每个文件先读结构（顶级 describe 数 + 公共 setup/teardown）→ 抽公共到 `_setup.ts` → 每个 describe 一个 sub-file → 留 facade index.test.ts re-export 或全部转为独立 .test.ts。
注：vitest 默认 glob 匹配 `**/*.test.ts`，所以多个独立 .test.ts 文件即可，不需要 facade。

## 步骤 checklist

- [x] Step 1 — EnterWorktree + rebase 到 main HEAD（cc9111a）
- [x] Step 2 — 读 4 个源文件主体 + 列拆分点 + 写 plan
- [x] Step 3 — 报告 11 文件全方案 + 用户确认 B
- [x] Step 4 — 拆 universal-message-watcher.ts → commit 1a50fec
- [x] Step 5 — 拆 preload/index.ts → commit e140b52
- [x] Step 6 — 拆 ComposerSdk.tsx → commit a0a25e7
- [x] Step 7 — 拆 sdk-bridge.test.ts (554) → commit 4a69172
- [x] Step 8 — 拆 pty-bridge.test.ts (571) → commit f8f6062
- [x] Step 9 — 拆 agent-deck-repos.test.ts (641) → commit 441b0b6
- [x] Bug fix — TeamHub memberCount=0 顺便修 → commit bb58621
- [x] Step 10 — 拆 task-manager/tools.test.ts (651) → commit 7d35a57
- [x] Step 11 — 拆 archive-plan.test.ts (1049) → commit eea8f83
- [x] Followup — task-manager-tools-crud unused fix → commit feb6283
- [x] Step 12 — agent-deck-mcp/tools.test.ts (1227) **加入保护清单**（vi.mock factory 文件级 hoisting 限制 / setup ~425 LOC 不可分摊）
- [x] Step 13 — 拆 hand-off-session.test.ts (1373) → commit 2efe7fc
- [x] Step 14 — 写 CHANGELOG_105 + 同步 INDEX + sdk-bridge + mcp tools.test 保护清单 → commit 5e3e8ce
- [ ] Step 15 — ExitWorktree(action: keep) + archive_plan

## 当前进度

全部拆分完成：8 个文件物理拆分（3 src + 5 测试，198/198 vitest 验证通过）+ 1 个 bug fix（TeamHub memberCount=0 pre-existing 顺便修，handler N+1 listActiveMembers）+ 2 个保护清单（sdk-bridge/index.ts CHANGELOG_52+85 已 4 轮拆分仅超 11 行 + mcp tools.test.ts vitest vi.mock 文件级 hoisting 限制）。CHANGELOG_105 + INDEX 已 commit。

最大单文件 LOC：universal-message-watcher/index.ts 346 / preload/api/misc.ts 154 / ComposerSdk.tsx 422 / hand-off-session.handler-cwd-generic.test.ts 475。全部 ≤ 500 ✅。

剩 ExitWorktree(keep) + archive_plan 收口。

## 下一会话第一步

如本会话中断,新会话跑 Step 15:

1. `ExitWorktree(action: 'keep')` 让 cwd 出 worktree
2. `mcp__agent-deck__archive_plan({ plan_id: 'universal-message-watcher-split-20260514', worktree_path: '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/universal-message-watcher-split-20260514', base_branch: 'main' })`
3. archive_plan 自动:ff-merge 到 main / 更新 plan frontmatter status=completed + final_commit + completed_at / mv plan 到 `<main-repo>/plans/` + 同步 INDEX / git commit / worktree remove + branch -D / 默认归档 caller session

## 已知踩坑

1. **路径前缀**（user CLAUDE.md §Step 1 末 callout）：所有 Edit/Write/Read/Grep 的 path 必须落 `<worktree>/<rel>`，**严禁**误用主仓库根级绝对路径
2. **vitest 前必须 install electron binary**（与 CHANGELOG_101 / CHANGELOG_104 同款）：
   ```bash
   zsh -i -l -c "pnpm install"
   zsh -i -l -c "cd node_modules/.pnpm/electron@*/node_modules/electron && node install.js"
   ```
3. **文件 vs 目录共存**：拆分阶段 `<file>.ts` 和 `<file>/` 同时存在时 TS 优先 `.ts`；必须 `git rm` 原文件才切换到 `index.ts`
4. **archive_plan 不能在 worktree 内调用**：必须先 `ExitWorktree(action: 'keep')` 让 cwd 出 worktree
5. **preload `typeof api` 类型推导**：拆 const object 后 spread 合并 + `typeof api` 类型推导依然 work，但要 typecheck 双端验证
6. **测试文件 setup/teardown 共享**：拆 describe 时 beforeAll / afterAll / mock instance 必须按 describe 边界正确分配；公共 fixture 抽 `_setup.ts` 各 describe import
</content>
</invoke>