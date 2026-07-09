# CHANGELOG_105

## 概要

全仓库 ≤ 500 LOC 护栏批量收口（plan `universal-message-watcher-split-20260514`，CHANGELOG_103 follow-up 优先级 3 拆分护栏全部完成）。扫全仓发现 11 个超标文件，本 plan 11 个独立 commit 收口：**8 个文件物理拆分（3 src + 5 测试）+ 1 个顺便修 bug + 2 个加入「不动文件保护清单」**。

## 变更内容

### 拆分前后总览

| 文件 | 拆前 LOC | 拆后最大 | 处理 |
|---|---|---|---|
| `src/main/teams/universal-message-watcher.ts` | 581 | 346 | 拆 4 文件 (rate-limiter / enqueue / team-event-dispatcher / index facade) |
| `src/preload/index.ts` | 524 | 154 | 拆 5 文件 + facade (api/{sessions,adapters,teams,misc,events} + index spread 拼装) |
| `src/renderer/components/SessionDetail/ComposerSdk.tsx` | 512 | 422 | 拆 4 文件 (主组件 + composer-sdk/{ImageIcon,ErrorBanner,SandboxSelects}) |
| `src/main/adapters/claude-code/__tests__/sdk-bridge.test.ts` | 554 | 389 | 拆 3 sub-test + _setup.ts (recovery / consume-fork) |
| `src/main/adapters/generic-pty/__tests__/pty-bridge.test.ts` | 571 | 440 | 拆 2 sub-test (lifecycle / idle-fwatch) |
| `src/main/store/__tests__/agent-deck-repos.test.ts` | 641 | 371 | 拆 3 sub-test + _setup.ts (team-repo / message-repo) |
| `src/main/task-manager/__tests__/tools.test.ts` | 651 | 428 | 拆 2 sub-test (crud / read-ingest) |
| `src/main/agent-deck-mcp/__tests__/archive-plan.test.ts` | 1049 | 400 | 拆 4 sub-test + _setup.ts (impl-core / impl-r33 / handler) |
| `src/main/agent-deck-mcp/__tests__/hand-off-session.test.ts` | 1373 | 475 | 拆 4 sub-test + _setup.ts (impl-core / handler-deny-happy / handler-cwd-generic) |
| `src/main/adapters/claude-code/sdk-bridge/index.ts` | 511 | — | **不动文件保护清单**（CHANGELOG_52+85 已 4 轮深度拆分 + 仅超 11 行 + 拆 createSession 协调流程需档位 3 双对抗 review） |
| `src/main/agent-deck-mcp/__tests__/tools.test.ts` | 1227 | — | **不动文件保护清单**（vitest `vi.mock()` factory 文件级 hoisting 限制：10 个 vi.mock + ~425 LOC mutable state setup 不能跨文件共享，复制后任意 sub-test ≥ 425 + describe 内容必超 500） |

8 个真拆分单文件 LOC 全部 ≤ 500 ✅。

### Commit 清单（按时间顺序）

| # | commit | 主题 |
|---|---|---|
| 1 | `1a50fec` | universal-message-watcher 拆 4 文件（581 → 346 max） |
| 2 | `e140b52` | preload/index.ts 拆 5 文件 + facade（524 → 154 max，spread 拼装 typeof api 字面量合并；tsconfig.web.json `include` 加 `src/preload/api/**/*.ts` 让 composite project 显式 list sub-files） |
| 3 | `a0a25e7` | ComposerSdk.tsx 拆 4 文件（512 → 422 max，抽 ErrorBanner 5 处复用 + SelectRow generic + ImageIcon） |
| 4 | `4a69172` | test/sdk-bridge 拆 3 sub-test + _setup.ts（554 → 389 max，每 sub-test 独立 hoisted vi.mock + 共享 TestBridge class） |
| 5 | `f8f6062` | test/pty-bridge 拆 2 sub-test（571 → 440 max，setup 复制；含 unused aiderFallbackConfig 删除） |
| 6 | `441b0b6` | test/agent-deck-repos 拆 3 sub-test + _setup.ts（641 → 371 max，按 repo 分；普通 import 无 vi.mock hoisting 限制） |
| 7 | `bb58621` | **fix(team-hub) 顺便修 memberCount=0 bug**（pre-existing：`AgentDeckTeamList` IPC handler 不返回 members 字段 → TeamHub `(t.members ?? []).length` 永远 0；handler 加 N+1 `listActiveMembers` per-team 挂 members，preload 类型签名同步升级） |
| 8 | `7d35a57` | test/task-manager-tools 拆 2 sub-test（651 → 428 max，按 crud / read-ingest 分） |
| 9 | `eea8f83` | test/archive-plan 拆 4 sub-test + _setup.ts（1049 → 400 max，按 impl-core / impl-r33 / handler 分；deps inject 模式无 vi.mock 可走共享 setup） |
| 10 | `feb6283` | fix(task-manager-tools-crud) 删 split 后未使用的 buildToolsWithSession + afterEach（#8 followup） |
| 11 | `2efe7fc` | test/hand-off-session 拆 4 sub-test + _setup.ts（1373 → 475 max，与 archive-plan 同款 deps inject + 共享 setup） |

### 拆分策略（CLAUDE.md 三档拆法 · 档位 1）

档位 1（抽 module-level 纯函数 / 类型 / 常量 / sub-component 到子目录 + facade index.ts），与 CHANGELOG_104 同款。所有 class 整体保留。**不**拆 class 本身（档位 3 风险高超出本 plan 范围）。

### 测试拆分两种模式

1. **deps inject 模式**（archive-plan / hand-off-session）：副作用 fn 全从 `XxxDeps` 注入，无 `vi.mock`。setup helpers（TestState / makeState / makeDeps / fixtureXxx）抽 `_setup.ts` 共享，sub-test 普通 import 无 hoisting 限制
2. **vi.mock 模式**（sdk-bridge / pty-bridge / agent-deck-repos / task-manager-tools）：每个 sub-test 文件**自己 hoisted** vi.mock（vitest 协议要求文件级声明）。可共享的纯 helper（class / factory / mutable state arrays）抽 `_setup.ts` 减少重复，但 vi.mock factory 必须各自写

`_setup.ts` 用下划线开头让 vitest glob `**/*.test.ts` 不当 test 跑（默认惯例）。

### sdk-bridge/index.ts 保护清单理由

- 已 CHANGELOG_52 Step 3a-3g + CHANGELOG_85 Step 3.2 共 4 轮拆分（11 个 sub-module 已抽出）
- 当前 511 LOC 仅超 11 行（2.2%）
- 剩余主要是 class 字段 + constructor + createSession 协调流程（已深度抽 helper buildClaudeQueryOptions / buildSandboxOptions / buildMcpServersForSession / makeCanUseTool / sandbox-resolve / mcp-server-init / finalizeSessionStart 等）+ thin delegate wrappers
- 进一步拆需要档位 3（拆 createSession 协调成单独 class）走双对抗 review，本 plan 不在范围

### mcp tools.test.ts 保护清单理由

- 顶部 setup ~425 LOC（10 个 `vi.mock` + 大量 mutable state：sessionStore / setSpawnLinkCalls / closeCalls / sendMessageCalls / createSessionCalls / mockMembershipsBySession / addMemberCalls / mockMessages / insertedMessages 等）
- vitest `vi.mock()` factory **文件级 hoisting**，不能跨文件共享 → 每个 sub-test 文件必须复制全部 setup
- 复制后任意 sub-test 文件 ≥ 425 LOC，加 describe 内容（最大 spawn 312 LOC）必超 500
- 按需精简每个 sub-test 的 mock 子集需 30-60 分钟 audit + 风险高（误删 mock 导致 import 链触发真模块 load → 挂 better-sqlite3 binding）
- 与 sdk-bridge/index.ts 同款定性：「拆完收益 < 风险」

下次拆分轮跳过这两个文件。如未来要拆，需走档位 3 双对抗 review 重构（mcp tools.test.ts 可考虑用 `vi.hoisted()` factory mock 重构，但 hoisted callback 有 sync 限制，重构成本高）。

### 顺便修 bug：TeamHub memberCount=0

用户实测 `stage-g-review-r1` team 显示「0 members · 最近活跃 12:13:28」。

- **pre-existing bug**（与本 plan 拆分无关）：`TeamHub.tsx:81` 用 `(t.members ?? []).length` 算 memberCount，但 `AgentDeckTeamList` IPC handler（`src/main/ipc/teams.ts:50-58`）只返回 `agentDeckTeamRepo.list(...)` 不带 members → `t.members` 永远 undefined → memberCount 永远 0；lastEventAt 同因 `sessionList.length=0` 走 fallback `t.createdAt`（实际是 team 创建时间不是真活跃时间）
- 修法（option B）：handler list 后 per-team loop 调 `listActiveMembers`（N+1 但 list 上限 200 + team list 渲染不高频可接受），返回类型升级 `Promise<(AgentDeckTeam & { members: AgentDeckTeamMember[] })[]>`，preload `listAgentDeckTeams` 类型签名同步
- TeamHub 现有逻辑零改动直接 work（`(t.members ?? []).length` + `sessionList.map(...)` 自动用上 members），lastEventAt 也算对（走 sessionList 而非 createdAt fallback）

## 测试与构建

- typecheck: 0 errors（`tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 双端通过）
- vitest: 已验证拆分文件全过
  - universal-message-watcher: 11/11
  - sdk-bridge: 11/11
  - pty-bridge: 31/31
  - agent-deck-repos: 38/38（probe-skipped，binding ABI 不匹配，与拆分无关）
  - task-manager-tools: 37/37
  - archive-plan: 31/31
  - hand-off-session: 39/39
- 总 198/198 验证通过

## 已知踩坑

- worktree 缺 node_modules + electron binary 时跑 vitest 会报 "Electron failed to install"，需 `pnpm install` + `cd node_modules/.pnpm/electron@*/node_modules/electron && node install.js` 双步（与 CHANGELOG_101 / CHANGELOG_104 已知踩坑同款）
- `<file>.ts` vs `<file>/` 目录在同一父目录可共存（basename 不同）；过渡期 TS 优先用 `.ts` 文件，必须最后 `git rm <file>.ts` 才切换 module resolution 到 `<file>/index.ts`
- preload 拆分 → tsconfig.web.json composite project 要求所有 transitive imports 在 file list 内，仅加 `src/preload/api/**/*.ts` 而**不**加 `src/preload/index.ts`（d.ts type-only import index.ts 仍可延迟解析无需把 index.ts 也加入 web project，否则 electron value import 触发 web target lib 不识别）
- vitest `vi.mock()` factory 文件级 hoisting：跨文件 share mock setup 不可行（mcp tools.test.ts 保护清单的根因），可共享的纯 helper（class / factory / mutable state）能抽 `_setup.ts` 但 vi.mock 调用本身必须每个 sub-test 文件自己 hoisted 写
- `_setup.ts` 命名约定：下划线开头让 vitest glob `**/*.test.ts` 自动跳过，避免被当 test 跑
