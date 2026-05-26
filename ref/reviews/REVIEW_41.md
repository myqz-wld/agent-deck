---
review_id: REVIEW_41
title: cross-adapter-parity 单轮异构对抗 review × 3 MED fix(reviewer-claude sandbox 失败 + reviewer-codex gpt-5.5 xhigh 单方实证)
created_at: 2026-05-15
plan_id: cross-adapter-parity-20260515
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/cross-adapter-parity-20260515
base_commit: d635dad
final_commit: 779a050
parent_review_id: REVIEW_40
heterogeneous_dual_completed: false
---

# REVIEW_41 — cross-adapter-parity 单轮异构对抗 review × 3 MED fix

## 触发场景

REVIEW_40 R1 reviewer-codex MED-F 指出 `adapters/types.ts:78-95` jsdoc 承诺 `sessions.extra_allow_write` 持久化但实际未实现(commit 8b607a1 已 jsdoc reflect reality 标 FUTURE 5 步路线);R40 R2 reviewer-codex MED parity 限制指出 claude / codex `recoverer.recoverAndSend` Promise<void> 等待者用 OLD sessionId 调 sendThunk → 撞 not found。

两个 follow-up 由独立 plan `cross-adapter-parity-20260515` 收口(scope 较窄,trivial fix-to-fix 主路径修;不走 R2/R3 多轮)。本 REVIEW 是 plan §C.2 单轮异构对抗 review 收口阶段,**走 user CLAUDE.md §决策对抗主路径**(双 Bash 起异构外部 CLI),非应用环境多轮 SKILL teammate 模式。

## 方法

### Scope = plan 6+1 commit / 15 文件 / +585/-44 LOC

**主线 6 commit (Phase A + Phase B)**:
- `21cead1` Phase A.1: migration v019_sessions_extra_allow_write.sql 加 TEXT JSON 列
- `d24a19b` Phase A.2+A.3: SessionRecord.extraAllowWrite + repo crud + rename 列扩 17→19(顺手补 v018 model 在 rename.ts 漏列 latent bug)
- `4c06008` Phase A.4+A.5+A.6: claude session-finalize / createSession / recoverer 全链路持久化 spawn → recover
- `200cebd` Phase A.7: codex 端同款(parity 对称写库,SDK runtime 不消费,与 model 同款语义)
- `5a545e1` Phase A.8+A.9: adapters/types.ts jsdoc 反映现实 + extraAllowWrite regression test 3 case
- `f95e09d` Phase B.1+B.2+B.3+B.4: claude/codex recoverer.recoverAndSend signature 改 Promise<string> + 等待者拿 finalId + waiter regression test 1 case

**review fix 1 commit (Phase C 异构 review fix)**:
- `779a050` REVIEW_41 MED-1 codex facade 透传 + MED-2 resume implicit fork + MED-3 restart-controller

### 异构对抗 reviewer

| Reviewer | 方法 | 模型 | 结果 |
|---|---|---|---|
| **reviewer-claude** | 双 Bash 外部 CLI(`zsh -i -l -c "claude -p ..."`)| Opus 4.7 | ❌ **失败 — sandbox 锁 cwd** |
| **reviewer-codex** | 双 Bash 外部 CLI(`zsh -i -l -c "codex exec --sandbox read-only --skip-git-repo-check -C <worktree> -o ..."`)| gpt-5.5 xhigh | ✅ 4 finding(0 HIGH / 3 MED / 1 LOW)|

### reviewer-claude 失败处理(关键经验)

reviewer-claude 启动后 cwd 被沙箱锁在 `node_modules/.pnpm/electron@33.4.11/node_modules/electron`(应用 SDK 子进程沙箱 default deny 写;reviewer-claude **没读到任何一行**新建 / 改动文件源码,仅 Glob 能确认路径存在。

reviewer-claude **自检诚实**: 输出 6 条 *未验证* MED 全部自标为「不是 finding,是受限条件下的抽查方向清单」+ 主动建议主 agent 按 user CLAUDE.md「reviewer-codex 失败兜底」反向应用:**严禁自动降级到同源双 Claude / 同源 reviewer-codex 单方**,应:(a) 重启 reviewer 放开沙箱;(b) 单方采纳 reviewer-codex 但需 lead grep 实证;(c) abort 由用户决策。

**lead 决策**: 走选项 (b) — 严守 user CLAUDE.md §三态裁决「单方独有 + HIGH」需反驳轮 / 「单方独有 + MED」主 agent 自己验证 规则,reviewer-codex 4 条 finding 全部由 lead 自己 grep 现场实证后才计入。reviewer-claude 6 条 *未验证* MED 全部 ❌ 不计入(纯文本推理无验证 → 自降级为非 HIGH → 单方独有 + 没有现场验证 → 不构成 ✅ 真问题)。

## R1 三态裁决(reviewer-codex 4 finding: 3 ✅ MED + 1 ❓ LOW)

### 真问题(必修)

| ID | 严重度 | 内容 | 出处 + 验证 | 落地 commit |
|---|---|---|---|---|
| **MED-1** | MED | codex `CodexCliAdapterImpl.createSession` opts 完全没接 `extraAllowWrite` 字段 → spawn handler / hand_off_session 透传给 codex adapter 的 extraAllowWrite **完全断档** → bridge 永远收 undefined → setExtraAllowWrite 永远 skip → codex 端 parity 完全没生效(plan §A.7 实施漏洞)| reviewer-codex 单方 + lead grep `extraAllowWrite\|createSession` 实证 codex-cli/index.ts:90 7 字段透传清单不含 extraAllowWrite | 779a050 |
| **MED-2** | MED | claude / codex recoverer resume path 固定 `return sessionId`,但 stream-processor `consume` `if (resumeId !== realId)` 触发 renameSdkSession (CLI implicit fork) 时 createSession 返 NEW realId,等待者拿 OLD sessionId 仍撞 not found(plan §B 主路径只覆盖 50%)| reviewer-codex 单方 + lead grep recoverer.ts L500-503 + stream-processor.ts L245 实证 | 779a050 |
| **MED-3** | MED | claude `restart-controller` `restartWithPermissionMode` + `restartWithClaudeCodeSandbox` 冷重启路径调 createSession 时不带 `extraAllowWrite` → 用户切 acceptEdits/bypass / 切 OS sandbox 档冷重启后 SDK 子进程 sandbox.allowWrite 不含原 mainRepo 写 plan 文件静默失败(与 plan 主旨 app 重启同款 bug,触发条件不同)| reviewer-codex 单方 + lead grep `extraAllowWrite` restart-controller.ts → 0 匹配实证 | 779a050 |

### ❓ 不修(留 follow-up)

| ID | 严重度 | 内容 | 出处 + 判定 |
|---|---|---|---|
| **LOW-1** | LOW | `extra_allow_write` 「绝对路径数组」契约只在 jsdoc/description,无 runtime `path.isAbsolute` 校验。schema 已 `z.array(z.string().min(1).max(4096)).max(16)` 限大小,非空相对路径会被持久化并塞 `allowWrite` | reviewer-codex 单方 + 实证 schemas.ts:83 + parseExtraAllowWriteJson L117。**判定 ❓ LOW**:caller(spawn_session/hand_off_session MCP handler)是 spawn handler 自己处理路径转换,信任边界内,risk 有限。留 follow-up plan 加 `path.isAbsolute` 校验 + 同步 reject 非绝对路径 |

### reviewer-claude 6 条 *未验证* MED ❌ 全部不计入

按 user CLAUDE.md §三态裁决 + Finding 输出契约 + reviewer-claude 自检建议:

| 条目 | 判定 | 理由 |
|---|---|---|
| MED-1 migration v019 INSERT 路径全数列扩 | ❌ 不计入 | reviewer-claude 自标 *未验证*,主 agent 已 lead grep 实证 rename.ts INSERT 17→19 列 + core-crud.ts upsert 同步 (commit d24a19b 透明注明「顺手补 v018 model 漏列 latent bug」) |
| MED-2 recoverer Promise<string> 等待者错误传播 | ❌ 不计入 | reviewer-claude 自标 *未验证*。lead 已确认 `try/catch finalId fallback to sessionId` (plan §B.5 设计 + 注释明示) |
| MED-3 codex 端 setExtraAllowWrite 与 SDK runtime 不消费的语义一致性 | ❌ 不计入 | reviewer-claude 自标 *未验证*。lead 已确认 codex bridge createSession opts 不消费 extraAllowWrite (注释明示 parity 对称写库 / runtime 不生效 / 与 model 字段同款语义) |
| MED-4 parseExtraAllowWriteJson defense-in-depth | ❌ 不计入 | reviewer-claude 自标 *未验证*。lead 已确认 JSON.parse try/catch + Array.isArray + filter typeof 'string' && length > 0 + 空数组 → null + 与 parseGenericPtyConfigJson 同款防脏 |
| MED-5 rename.ts 列扩对子表 / 反向 rename 影响 | ❌ 不计入 | reviewer-claude 自标 *未验证*。lead 已确认 toExists 分支补 model + extra_allow_write 覆盖 (commit d24a19b 透明注明) + REVIEW_36 R2 H1-R2 教训配套 |
| MED-6 _setup.ts intercept 对现有 case 的副作用 | ✅ 部分采纳 | reviewer-claude 自标 *未验证* 但实际是 `interceptSidSet` opt-in seam — 仅显式加入 Set 的 sid 触发 capture,默认空 Set 不破现有 case (现有 18 case 全过 + B.4 case 走 fork case 单独验证)。MED-2 fix regression case (REVIEW_41 779a050) 也走同款 seam (`forkOnResumeOverride`) 验证 resume implicit fork |

## 修复条目(详 commit 779a050)

### MED-1 fix — codex CodexCliAdapterImpl.createSession 透传 extraAllowWrite
- `src/main/adapters/codex-cli/index.ts:88` createSession opts 加 `extraAllowWrite?: readonly string[]` + jsdoc 说明 codex SDK runtime 不消费 + parity 对称写库
- `src/main/adapters/codex-cli/index.ts:90-99` 透传给 `this.bridge.createSession({..., extraAllowWrite: opts.extraAllowWrite})`

### MED-2 fix — claude / codex recoverer resume path 拿 handle.sessionId
- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:478-510`: `const handle = await this.createThunk({...resume...}); return handle.sessionId;`
- `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts:316-341`: 同款(codex 实测不 fork 但写法对称 future-proof)
- regression test: `_setup.ts` 加 `forkOnResumeOverride` seam + 新 case「REVIEW_41 MED-2 fix:resume implicit fork → 第二条 waiter 拿 forked-id 不撞 not found」

### MED-3 fix — claude restart-controller 透传 extraAllowWrite
- `src/main/adapters/claude-code/sdk-bridge/restart-controller.ts:19-32` `RestartCreateOpts` 加 `extraAllowWrite?: readonly string[]` + jsdoc
- `restartWithPermissionMode` L118-128 调 createSession 加 `claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined` + `extraAllowWrite: rec.extraAllowWrite ?? undefined`(顺手补 restartWithPermissionMode 漏传 claudeCodeSandbox 也修上)
- `restartWithClaudeCodeSandbox` L235-249 调 createSession 加 `extraAllowWrite: rec.extraAllowWrite ?? undefined`(同款治法)

## 验收

- typecheck: claude + codex 双 tsconfig 全过
- vitest: 531 passed / 64 skipped(better-sqlite3 ABI 环境问题与本 plan 无关)
- regression test: sdk-bridge.recovery.test.ts 20 cases 全过(15 原有 + 3 A.9 + 1 B.4 + 1 REVIEW_41 MED-2 fix)
- 异构对抗强度: ⚠ **降级**(reviewer-claude sandbox 失败 → 仅 reviewer-codex 单方 + lead grep 实证;`heterogeneous_dual_completed: false`)— follow-up plan 应修 reviewer-claude 启动 sandbox 配置

## 已知 follow-up(本 plan 不做)

- **LOW-1 path.isAbsolute runtime 校验**: 加 zod refine + reject 非绝对路径(信任边界内 risk 有限,trivial fix 留单独 follow-up plan)
- **reviewer-claude sandbox 锁 cwd 修复**: 调研 `claude -p` 启动时为何 cwd 被锁到 node_modules/.pnpm/electron — 环境配置 / wrapper 问题应单独定位(影响所有 claude reviewer 用本模板的场景)
- **R40 follow-up #1 P4 BaseAdapter / #3 跨 adapter sandbox 继承 / #2 scheduler 命名**: 留 plan `adapter-architecture-design-20260515`(后续 P2 design hand-off)
- **R40 follow-up #5 double rename cleanup + #6 codex sdk-bridge tests**: 留 plan `codex-sdk-bridge-tests-20260515`(独立 hand-off P0)
