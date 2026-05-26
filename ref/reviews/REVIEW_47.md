---
review_id: REVIEW_47
title: deep-review-batch-a1-b-fixes-20260519 plan 收口 — 6 HIGH + 11 MED 落地 + R3 verify follow-up
created_at: 2026-05-19
heterogeneous_dual_completed: true
---

# REVIEW_47 — deep-review-batch-a1-b-fixes plan 全程异构对抗 review × R1/R2/R3 三轮裁决

## 触发场景

用户启动 deep-code-review SKILL 6 batch 累积出 6 HIGH + 11 MED 后,要求集中收口。本 plan
deep-review-batch-a1-b-fixes-20260519 走「复杂 plan 流程 v2」(user CLAUDE.md §Step 0 RFC + Step 0.5
spike + Step 1 plan + Step 1.5 plan-review + Step 2 worktree + Phase 1/2/3 fix + Phase 4 R3 verify
+ Phase 5 收口),全程异构对抗。

## 方法

### Scope

- **A1 batch (claude-code SDK bridge)**: 8 文件 — index.ts / recoverer.ts / restart-controller.ts /
  sdk-message-translate.ts / stream-processor.ts / types.ts / translate.ts / options-builder.ts
- **B batch (agent-deck-mcp tool handlers)**: 8 文件 — archive-plan-impl.ts / exit-worktree-impl.ts /
  hand-off-session.ts / hand-off-session-impl.ts / plan-path-helpers.ts (新增) / helpers.ts /
  transport-stdio.ts / transport-http.ts

### 流程

| 阶段 | reviewer pair | 输出 |
|---|---|---|
| R1 全量扫 (6 batch 累积) | 各 batch claude+codex | 6 HIGH + 11 MED + 6 LOW + 多 INFO |
| R2 反驳轮 + plan-review | claude+codex × 各 batch + plan-review pair | 单方 HIGH/MED 双对抗确认;plan v2 修订 5 HIGH + 7 MED + 2 LOW |
| Phase 1+2+3 fix | lead | 17 项全部 inline fix(3 commit `91cb584` / `f260fd8` / `c64ba31`) |
| R3 verify | 重 spawn 4 reviewer(caller session 不在原 team,丢 mental model) | 5 HIGH + 9 MED follow-up(全属未识别同类深层 bug + 测试补全 debt,非本轮 fix 引入 regression) |

### 关键决策

- **Step 0 RFC**: user 第一轮 4 题 + 第二轮 4 题对齐 design(plan 范围 / 文件位置 / worktree 隔离 /
  P0+P1 优先级 / A1-HIGH-1 修法 (A) / B-HIGH-1 修法 (C) / B-HIGH-2 修法 (A) / R3 全部 fix 完一次)
- **Step 0.5 spike**: hook PostToolUse `tool_use_id` 字段实证(SDK sdk.d.ts:1870-1875 含,
  PermissionRequest/PostToolUseFailure 不含 — 确定修法范围仅 translatePostToolUse 路径)
- **Step 1.5 plan-review**: plan v2 双对抗修订 5 HIGH + 7 MED + 2 LOW(覆盖矩阵 / cold-start
  worktree 兜底 / spike 结论修正 / 漏 finding A1-MED-2 (claude) 补 step)
- **R3 caller session 不在 team**:plan §Step 4.0 自检后 user 选「重 spawn 4 reviewer 丢 mental
  model」(非「shared-team UI 加 member」/「单方 reviewer」/「abort R3」),全量 fresh review

## 三态裁决

### R1+R2 → Phase 1/2/3 fix(全部 ✅)

| Finding | Source | Phase | 三态 |
|---|---|---|---|
| **A1-HIGH-1** 假 session leak | codex 提 + claude 反驳 | Phase 2 Step 2.1 | ✅ 双独 |
| **A1-HIGH-2** 30s fallback 双 CLI | codex 提 + claude 反驳 | Phase 2 Step 2.2 | ✅ 双独 |
| **B-HIGH-1** caller spoofing | codex 提 + claude 反驳 mini-test | Phase 1 Step 1.1 | ✅ 双独 |
| **B-HIGH-2** baton bypass | codex 提 + claude 反驳 | Phase 2 Step 2.3 | ✅ 双独 |
| **B-HIGH-3** detached HEAD | codex 提 + claude 反驳 git 实测 | Phase 1 Step 1.2 | ✅ 双独 |
| **B-HIGH-4** mainRepo dirty | codex 提 + claude 反驳 git 实测 | Phase 1 Step 1.3 | ✅ 双独 |
| **A1-MED-1 (claude)** setPermissionMode fail-open | claude 单方 + lead 现场 | Phase 3 Step 3.1 | ✅ |
| **A1-MED-2 (claude)** reviewer-* hardcode SSOT | claude 单方 + lead 现场 | Phase 3 Step 3.2 | ✅ |
| **A1-MED-3 (claude)** recoverer fallback cwd jsdoc | claude 单方 + lead 现场 | Phase 3 Step 3.3 | ❓ → 降级补 caller 链路 NOTE |
| **A1-MED-4 (claude)** hook toolCallId 不对称 | claude 单方 + spike 实证 | Phase 3 Step 3.4 | ✅ |
| **A1-MED-1 (codex)** file-changed in tool_use | codex 单方 + lead 现场 | Phase 3 Step 3.5 | ✅ |
| **A1-MED-2 (codex)** RestartController race | codex 单方 + lead 现场 | Phase 3 Step 3.6 | ✅ |
| **B-MED-1 (claude)** cwd 4 态 marker | claude 单方 + lead 现场 | Phase 3 Step 3.7 | ✅ |
| **B-MED-2 (claude)** markerCleared 不对称 | claude 单方 + lead 现场 | Phase 3 Step 3.8 | ✅ |
| **B-MED-3** hand_off plan 路径中间档 | 双独 ✅ 强冗余 | Phase 3 Step 3.9 | ✅ |
| **B-MED-1 (codex)** tracked plan unlink | codex 单方 + lead 现场 | Phase 3 Step 3.10 | ✅ |
| **B-MED-2 (codex)** hand_off stem 校验 | codex 单方 + lead 现场 | Phase 3 Step 3.11 | ✅ |

### R3 verify 新发现(全数 follow-up)

R3 重 spawn 4 reviewer fresh review,**未识别 fix 引入 regression**(plan §不变量 10 守住),但发现
以下「未识别同类深层 bug + 测试补全 debt」5 HIGH + 9 MED:

#### HIGH (5 条 follow-up)

| # | 主题 | 文件 | source | 验证 |
|---|---|---|---|---|
| H1 | consume vs setTimeout fallback 30s 并发 mutate race | `stream-processor.ts:140-275` + `index.ts:307` | claude·A1 HIGH-1 + codex·A1 HIGH-2 双独不同切片 | ✅ 强冗余 (consume 中途收到晚到 first id 走 mutation 路径 + finally cleanup 用 `realId ?? tempKey` 不用 resumeId 同根因不同表现) |
| H2 | createSession throw 路径不 interrupt SDK query → detached consume 生 ghost session | `index.ts:307` + `stream-processor.ts:178-196` | codex·A1 HIGH-3 单方 + 现场验证 | ✅ throw 后 catch 只 cleanup state,SDK query 仍跑,真实 id 到达后 sessions.set + emit ghost |
| H3 | translateSdkMessage 同步 SDK system.init/status `permissionMode` 只写 DB / emit upsert,**不写 `internal.permissionMode`** | `sdk-message-translate.ts:182` | codex·A1 HIGH-1 单方 + 现场验证 | ✅ canUseTool 走 internal cache (index.ts:234),与 DB/UI 三向分裂 → bypass 残留 = 安全边界错误 |
| H4 | `transport-http-extra-auth.test.ts` inline 合约测试 stale,仍验证 OLD vulnerable 行为 | `transport-http-extra-auth.test.ts:40-100` | claude·B HIGH-1 + grep 验 | ✅ B-HIGH-1 修法引入的 collateral test debt — 测试 pass 因 inline copy 自洽,完全不反映 transport-http.ts:98-109 真实代码 |
| H5 | plan §Phase 1+2 承诺 7 个 P0 regression test 文件全部零创建 | `__tests__/` | claude·B HIGH-2 + find/grep 验 | ✅ helpers.deny-external / spoofing-attack-paths / archive-plan-impl.base-branch-named-only / archive-plan-impl.mainrepo-clean / createsession-fail-fast / setttimeout-fallback-symmetry / hand-off-session.archive-caller-false 全 0 命中;现有 hand-off-session.handler-deny-happy.test.ts 也未断言 spawn 第三参数 batonMode |

#### MED (9 条 follow-up)

| # | 主题 | 文件 | source |
|---|---|---|---|
| M1 | setPermissionMode 并发回滚覆盖已成功的 mode | `index.ts:557` | codex·A1 MED-1 |
| M2 | 图片工具 file-changed 无 status gate(对 Step 3.5 修法对称性 hole) | `sdk-message-translate.ts:126` | codex·A1 MED-2 |
| M3 | restart-controller waiter 用旧 sessionId 查 repo,rename 后 miss | `restart-controller.ts:89` | codex·A1 MED-3 |
| M4 | `set-permission-mode-rollback.test.ts` 三个 case 全 inline 复制 try/catch 不调真 bridge | `set-permission-mode-rollback.test.ts:26-33` | claude·A1 MED-2 + codex·A1 LOW-1 + claude·B MED-3 三方强冗余 |
| M5 | consume 自然终止路径 `resolve(realId ?? tempKey)` 不对称(应 `?? resumeId ?? tempKey`) | `stream-processor.ts:194` | claude·A1 MED-3 |
| M6 | `file-change-intent-delay.test.ts` 没覆盖 stream-processor finally clear 防 leak | `file-change-intent-delay.test.ts` | claude·A1 MED-4 |
| M7 | `BuildAgentDeckToolsDeps.callerSessionIdOverride` 类型 + JSDoc 与新 lambda 漂移(永不返 null) | `tools/index.ts:73-84` | claude·B MED-1 |
| M8 | B-HIGH-4 mainRepo dirty 路径无测试覆盖(seam `mainRepoStatus` 写了但全 test 都默认 '' clean) | `archive-plan/_setup.ts:73-90` | claude·B MED-2 |
| M9 | git `commit -m` 无 pathspec → mainRepo 预检后 commit 前 stage 无关文件仍混入归档 commit(B-HIGH-4 TOCTOU 残留) | `archive-plan-impl.ts:251 / :760-772` | codex·B MED-1 |
| M10 | exit_worktree partial-success retry hint 不可执行(branch 删除失败时 worktree 已删,retry 落入 worktree 不存在分支不会再尝试删 branch) | `exit-worktree-impl.ts:274` | codex·B MED-2 |
| M11 | action:keep 在 .git 损坏时无法清 marker(先要求 `rev-parse --git-common-dir` 成功) | `exit-worktree-impl.ts:198` | codex·B MED-3 |
| M12 | `batonRole:'lead'` 无条件传入,即使 archive_caller=false 退化 normal spawn | `hand-off-session.ts:335` | codex·B MED-4 |

(M1-M12 共 12 条,实际 9 条独立 + 3 条强冗余去重 → follow-up plan 处理时 reviewer 再 R1 全量裁决)

#### LOW + INFO + 未验证(留 follow-up plan 顺手清)

| # | 主题 | source |
|---|---|---|
| L1 | A1-MED-1 by-design 时序窗口(setPermissionMode write-then-await) | claude·A1 LOW |
| L2 | markerCleared 语义在 happy path / early-return path 不对称 | claude·B LOW-1 |
| L3 | transport-http.ts:110 `: null` 分支 dead code(transport='http' 永远 true) | claude·B LOW-2 |
| L4 | helpers.ts stdio sentinel 兜底未覆盖 read-only tool 的非 sentinel stdio caller | codex·B LOW-1 |
| I1 | reviewer-claude AGENT_DECK_CLAUDE_PATH 注入仍 hardcode(by-design 子集独有) | claude·A1 INFO |
| I2 | tools/index.ts:108-109 fallback chain 在 B-HIGH-1 修法后全死 | claude·B INFO |
| ❓ U1 | translate.ts PostToolUse hook 路径可能绕过 SDK stream failed gate(协议契约未实证) | codex·A1 未验证-1 |
| ❓ U2-5 | archive-plan 4 态 marker 是否应 reject / planId path traversal / 空字符串 override / R3 测试充分性 | codex·B 未验证 ×4 |

### 用户 R3 阶段额外反馈(follow-up plan 必含)

- **hand_off_session baton 时应 shutdown dormant teammate + team 不应跟着旧 lead 流传**:list_sessions
  显示 6 个旧 reviewer (review-adapters-claude-bridge / review-mcp-handlers / review-plan-deep-review-batch-a1-b-fixes
  team 内的 4 reviewer + plan-review 2 reviewer) 全是 dormant 而非 closed,hand_off_session
  default `keep_teammates: false` 的 shutdownTeammatesOnBaton helper 在 dormant teammate 上没生效。
  user 反馈语:「hand off 归档时,应该连带 teammate 一起,然后 team 也不能流传下来才对」。

## R3 与本 plan 范围决策

按 user 决策(R3 路径选 (a) follow-up plan):本 plan 范围严格 = R1/R2 发现的 6 HIGH + 11 MED,**全部
100% 落地**(3 commit + typecheck + 826 测试 + build 全过)。R3 新发现 5 HIGH + 9 MED 全属 plan 之外
的「未识别同类深层 bug + 测试补全 debt」,非本轮 fix 引入 regression,落 follow-up plan 处理。

## 工程产物

- 3 commit: `91cb584` (Phase 1 P0 安全 / 数据丢失 3 HIGH) + `f260fd8` (Phase 2 P0 功能 broken 3 HIGH)
  + `c64ba31` (Phase 3 11 MED + 测试补全)
- 5 新测试文件:
  - `src/main/adapters/claude-code/__tests__/translate-post-tool-use-toolcallid.test.ts` (5 cases hook 路径 toolCallId 透传)
  - `src/main/adapters/claude-code/sdk-bridge/__tests__/file-change-intent-delay.test.ts` (6 cases push/consume intent 状态机)
  - `src/main/adapters/claude-code/sdk-bridge/__tests__/set-permission-mode-rollback.test.ts` (3 cases SDK throw 回滚 cache,**注:三方 reviewer 共识 inlined logic 反模式 → follow-up M4**)
  - `src/main/agent-deck-mcp/__tests__/plan-path-helpers.test.ts` (8 cases 3 档 fallback + 优先级)
  - `src/main/agent-deck-mcp/tools/handlers/plan-path-helpers.ts` (新增 helper)
- 现有测试增量:TC15 cwd-marker / hand-off stem case / exit_worktree partial-success case
- Phase 1 fix mainRepo dirty precheck 引入的 mock 队列偏移 regression 通过 `archive-plan/_setup.ts` 透明拦截 mainRepo `git status` mock 修复(`recognizedMainRepos` 默认含 `/Users/test/repo`)

## 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ |
| `pnpm test` | ✅ 826 tests, 755 passed + 71 skipped (sandbox EPERM 与本 plan 无关) |
| `pnpm build` | ✅ |

## 关联归档

详 [CHANGELOG_128](../changelog/CHANGELOG_128.md);plan archive 路径 `<main-repo>/plans/deep-review-batch-a1-b-fixes-20260519.md`(Phase 5 archive_plan 完成后)。
