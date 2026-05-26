---
review_id: 20
reviewed_at: 2026-05-01
expired: false
heterogeneous_dual_completed: true
skipped_expired:
  # 本轮 review 是新增 sub-module + facade 改名，未触发文件级过期复审
---

# REVIEW_20: 第三轮大文件拆分 (Step 1-4c) 落地校验

## 触发场景

CHANGELOG_52 第三轮大文件拆分落地后周期性验证：4 个 >500 行文件（claude sdk-bridge 1972 / manager.test 561 / codex sdk-bridge 559 / session-store 534）拆为 13 个 sub-module + facade 模式（CHANGELOG_50/51 之后用户明确「激进拆 class」决策落地）。前两轮落地校验（REVIEW_18 / REVIEW_19）的拆分都没动 class state ownership，本轮第一次真正动了 sub-class 边界（PermissionResponder / SessionRecoverer / StreamProcessor / makeCanUseTool / ThreadLoop），需要严格字节级校验 + race 护栏完整性核对。

## 方法

**双对抗配对**（teammate 模式 + lead 手动 Bash 调 codex 兜底）：

- **reviewer-claude** (Opus 4.7 xhigh, teammate)：完整跑 6 项 focus，184k tokens / 68 tool uses / 8 分钟。grep + 对照 origin/main 字节级 diff + 读 sdk-bridge.test.ts 验证测试范式。
- **reviewer-codex** (gpt-5.5 xhigh, **lead 手动 Bash 调外部 codex CLI**)：teammate wrapper 两次失败（subagent Bash 权限被 Claude Code 层 deny，没触发 PendingTab）→ 用户决策走 ~/.claude/CLAUDE.md「手动并发」Fallback 模板，lead 直接 zsh -i -l -c "codex exec --sandbox read-only ..." 拿独立结论。1.75M tokens / 8 分钟 reasoning。**异构对抗原则保留**：lead 是 Opus 4.7 / codex 是 gpt-5.5 仍异源，仅 teammate 通道被权限拿住。

**范围**：origin/main..HEAD 12 atomic commits（11 拆分 + 1 audio 资源），22 文件，+3885/-3164。

```text
src/main/adapters/claude-code/sdk-bridge/{index,constants,types,sdk-message-translate,permission-responder,can-use-tool,recoverer,stream-processor}.ts (8 新)
src/main/adapters/codex-cli/sdk-bridge/{index,constants,types,codex-binary,thread-loop}.ts (5 新)
src/renderer/stores/event-type-guards.ts (1 新) + session-store.ts (改)
src/main/session/__tests__/{manager-test-setup,manager-ingest,manager-public-api,manager-delete}.test.ts (4 新)
CLAUDE.md (新增「单文件 ≤ 500 行 — 超了必须试拆」节)
+ feat(sounds) 4db39cc (resources/sounds/ + sound.ts + package.json extraResources)
```

**机器可读范围**：

```review-scope
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/constants.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts
src/main/adapters/claude-code/sdk-bridge/permission-responder.ts
src/main/adapters/claude-code/sdk-bridge/can-use-tool.ts
src/main/adapters/claude-code/sdk-bridge/recoverer.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/constants.ts
src/main/adapters/codex-cli/sdk-bridge/types.ts
src/main/adapters/codex-cli/sdk-bridge/codex-binary.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/renderer/stores/event-type-guards.ts
src/renderer/stores/session-store.ts
src/main/session/__tests__/manager-test-setup.ts
src/main/session/__tests__/manager-ingest.test.ts
src/main/session/__tests__/manager-public-api.test.ts
src/main/session/__tests__/manager-delete.test.ts
src/main/notify/sound.ts
```

**约束**：6 项 focus（F1 修法落地 / F2 修法落地 / 5 sub-class 字节级一致 / 12+ race 护栏完整 / test 范式不破 / import 站点零变更）+ audio commit 兼容性 校验。

## 三态裁决结果

> 双方一致结论，0 HIGH/MED/LOW + 1 INFO。**单轮收口**（沿用 REVIEW_19 拆分类 review 范式：refactor 不引新 lifecycle / race / 架构耦合，6 项 focus 全过即可）。

### ✅ 真问题（无）

无 HIGH / MED / LOW 真问题。两路 reviewer 在 6 项 focus 上完全一致：

| # | Focus | reviewer-claude | reviewer-codex | 裁决 |
|---|---|---|---|---|
| F1 | restartThunk 落地（responder→lifecycle 第二条循环依赖修法） | ✅ index.ts:119 ctor 传 thunk + permission-responder.ts:160 调 this.restartThunk | ✅ 同 | ✅ |
| F2 | recovering Map 共享（facade-owned + ctx 注入） | ✅ index.ts:81 facade 持 + recoverer.ts:87 通过 ctx.recovering 读写 + index.ts restartWithPermissionMode 仍 this.recovering（同一 Map ref） | ✅ 同 | ✅ |
| F3 | 5 sub-class 字节级行为一致 | ✅ canUseTool 5 分支 / consume fork rename + expectedClose skip / recoverer jsonl 预检 + post-fallback rename / thread-loop 30s fallback 序列 与原版字节级等价 | ✅ git show origin/main 对照确认 | ✅ |
| F4 | 12+ race 护栏完整 | ✅ REVIEW_5 H4 / REVIEW_11 Bug 4 / CHANGELOG_27/28/31/34/42/43/46/47 / REVIEW_13 / REVIEW_17 R3 全部就位 | ✅ 同 | ✅ |
| F5 | test 范式不破 | ✅ TestBridge subclass override resumeJsonlExists 通过 facade arrow thunk lazy 解析仍生效 + cast 调 consume 通过 facade protected wrapper 转发 + manager-test-setup vi.mock factory lazy execution hoist-safe | ✅ 同 | ✅ |
| F6 | import 站点零变更 | ✅ moduleResolution: node「文件优先于目录」实测：删 sdk-bridge.ts 后 6 处 import 自动 fallback 到目录 index.ts | ✅ 同 | ✅ |
| 7 | audio commit (4db39cc) 兼容性 | n/a | ✅ sound.ts 路径与 codex binary ENOTDIR 修法对齐 + extraResources 已加 sounds entry | ✅ |

### ❌ 反驳（无）

无被对抗或现场核实证伪的 finding。

### ❓ 部分 / 未验证

无。两路 reviewer 都用实践验证（grep / git show origin/main 字节级 diff / 读真实文件）支撑结论，未出现「未验证」或弱断言项。

### INFO（独立合并）

#### INFO #1 — 注释「9 个 isXxx」实际 8 个

- 文件：`src/renderer/stores/event-type-guards.ts:12,16` + `src/renderer/stores/session-store.ts:94`
- 问题：3 处注释写「9 个 isXxx」，实际 export / import / 原 session-store.ts 都是 8 个 `function isXxx`（PermissionRequest / TeamPermissionRequest / TeamPermissionCancelled / AskUserQuestion / ExitPlanMode / PermissionCancelled / AskQuestionCancelled / ExitPlanCancelled）。原版数字「9」就是错的，拆分时机械迁移没复核。
- 验证：`git show origin/main:src/renderer/stores/session-store.ts | grep -c "^function is"` → 8；`grep -c "^export function is" src/renderer/stores/event-type-guards.ts` → 8；session-store.ts import 8 行；三者吻合。
- 修复方向：3 处「9 个」改成「8 个」（**已在本轮 review 同 commit 修掉**）。

#### Codex 「未完成验证」

reviewer-codex 报告 `vitest run` 在 read-only sandbox 下失败于创建临时目录和 `node_modules/.vite/vitest/results.json`，**没有跑到测试本体**；失败原因是环境写权限，不是被测代码断言失败。**无影响**：lead 在拆分 Step 1-4c 主路径已经跑过 `pnpm exec vitest run` 76 passed (6 files)，每个 atomic commit 之后都跑过 typecheck，最后 build 通过。codex 沙盒 vitest 失败属于审计环境隔离副产品。

## 修复

### INFO（已落地）

1. `src/renderer/stores/event-type-guards.ts:12,16` + `src/renderer/stores/session-store.ts:94` — 3 处「9 个 isXxx」改「8 个」

## 关联 changelog

- [CHANGELOG_52.md](../changelog/CHANGELOG_52.md)：第三轮大文件拆分主体（11 atomic commits + 1 INFO 收口）
- 独立 commit `4db39cc` (feat(sounds))：内置默认提示音不属于 CHANGELOG_52 拆分 scope，本 review 顺手 audit

## Plan agent 5 finding 跟踪

REVIEW_20 验证 plan 阶段 Plan agent 给的 5 条 finding 在落地中的处理状态：

| # | Plan agent 严重度 | 落地状态 | 验证 |
|---|---|---|---|
| F1 | HIGH | ✅ 完整修：facade ctor 传 restartThunk → responder.respondExitPlanMode 调 this.restartThunk | reviewer-claude / reviewer-codex 双方独立确认 |
| F2 | HIGH | ✅ 完整修：recovering Map 提到 facade，与 sessions Map 同级 SHARED；ctx 暴露 readonly Map ref；recoverer 只独占 placeholderEmittedAt | reviewer-claude / reviewer-codex 双方独立确认 |
| F3 | MED | ✅ 完整修：3b commit 同 commit 改 createSession 内 3 处 setTimeout 引用 + 临时 restartWithPermissionMode wrapper；3f 删 wrapper 改 ctx thunk | 中间态每步 typecheck 通过 |
| F4 | MED | ✅ 部分修：ResponderCtx / RecovererCtx / StreamProcessorCtx 都 readonly；**但** ctx.findInternal 单一查找入口未实施（实际只有 closeSession 一处需要按 realSessionId 兜底查找，其他方法直接 sessions.get(sid) 即可，不构成新风险——直接保留原 closeSession entries() 扫描） | reviewer-claude 独立确认 |
| F5 | LOW | ✅ 完整修：保留 sdk-bridge.ts 文件直到 3g/4c 删除；index.ts 顶部加 module resolution 假设说明；3g + 4c commit 跑 typecheck + vitest 验证切换；reviewer-codex 独立确认 import 站点全部解析 OK | reviewer-claude / reviewer-codex 双方独立确认 |

## Agent 踩坑沉淀（如有）

无新增 agent-pitfall 候选。本轮 review 流程上的踩坑（teammate Bash 权限两次被 Claude Code 层拒，需要走 lead 手动 Bash Fallback）属于环境配置问题，不是模式化代码问题。
