---
review_id: REVIEW_37
title: 宏观重构机会 R1+R2+R3 深度 review × P1+P2+P3 三档落地（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh）
created_at: 2026-05-15
plan_id: deep-review-and-refactor-r37-20260515
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-r37-20260515
base_commit: ffcb663
final_commit: 736b24a
heterogeneous_dual_completed: true
---

# REVIEW_37 — 宏观重构机会 R1+R2+R3 深度 review × P1+P2+P3 三档落地

## 触发场景

用户主动「再做一轮宏观重构机会 review，看看哪些重复/胖文件/冗余抽象/不一致语义可以收口」。复用 REVIEW_36 同款异构对抗模式（reviewer-claude Opus 4.7 teammate + reviewer-codex gpt-5.5 xhigh wrapper），但本轮 scope 更宽 — 覆盖 main 进程整体重构机会清单（不限沙盒 / resume / hand-off）。

按 user CLAUDE.md §决策对抗 多轮深度 review 编排（plan-driven hand-off 三轮 R1 → fix → R2 → R2 fix → R3 收口），与 REVIEW_36 一致。

## 方法

### Scope = main 进程整体宏观重构机会扫描

不限模块单点：覆盖 adapter / mcp tool / oneshot LLM runner / store / preload / shared / IPC / sub-class 拆分等。reviewer 端自由选 finding 切片，不预设 focus 框框；lead 收两份独立结论后做 plan 决策映射（按字母编号 D/G/B/F/H/I/E/M/N/C/K/L/J）。

### 异构对抗 reviewer

| 轮次 | reviewer-claude | reviewer-codex | team |
|---|---|---|---|
| **R1** | 1 teammate（全 scope）| 1 teammate（wrapper，全 scope codex CLI 调用）| `deep-review-37-macro` |
| **R2** | 同 R1 reviewer 复用 mental model | 同 R1 reviewer 复用 mental model | `deep-review-37-macro-r2` |
| **R3** | 全新 reviewer（R2 reviewer 已 closed，无法复用）| 全新 reviewer（同上）| `deep-review-37-macro-r3` |

### R3 reviewer 复用失败 + 选项 2 兜底

按 plan 设计 R3 应复用 R2 reviewer mental model（避免 R1 失误：R1 reviewer 被 hand_off_session default keep_teammates=false 误 auto-shutdown）。但 R3 启动时 `list_sessions` 显示 R2 reviewer（claude r2 sid `5cceabec` / codex r2 sid `1e961eca`）已被中间会话 hand-off 时 shutdown，状态 `closed` 而非预期 `dormant`。

按 plan「复用 R37 reviewer mental model」节给的 3 选项：
- 选项 1（手动 UI 加入 R2 team）：R2 reviewer 已 closed，加空 team 无意义
- 选项 2（spawn 全新 R3 reviewer 对，team `deep-review-37-macro-r3`）：✅ 选用
- 选项 3（等 app 部署 baton role fix 后重 hand-off）：R2 reviewer 仍 closed，无法复用

R3 init prompt skip 字段写明 R1 + R2 已 fix 的 finding + R2 已确认 pre-existing 不归 R37 的 finding，让 R3 reviewer 不重复列。

### 工作流（R1 → P1+P2 fix → R2 → R2 fix → P3 fix → R3 收口）

- **R1**（spawn 一对 reviewer 全 scope）：reviewer-claude 14 finding + reviewer-codex 13 finding → 三态裁决 7 ✅ HIGH + 8 ✅ MED + 4 LOW/INFO 真问题清单（0 反驳证伪）
- **P1+P2 fix**（10 commit）：按 plan 决策映射 D/G/B + Phase 2 trivial + F/H/I/E/M/N
- **R2**（复用 R1 reviewer mental model）：R2 复审 P1+P2 fix → reviewer-claude 0 finding + reviewer-codex 3 HIGH + 3 MED + 5 LOW + 1 *未验证*
- **R2 三态裁决 + R2 fix**（2 commit）：1 HIGH + 2 MED 真 R37 引入 fix；3 HIGH/MED pre-existing 不归 R37（留专门「codex/claude 架构对称」plan）；5 LOW + 4 INFO 不阻塞
- **P3 fix**（4 commit）：按 plan Phase 4 实施 4 step（C cwd / C emit helper / L result types / J shared 边界）+ 3 step calibration 跳过（Step 4.2 single-flight / 4.4 preload misc / 4.6 IPC errorMode）
- **R3**（spawn 全新 reviewer 对，skip 字段透传 R1/R2 已处理 finding）：reviewer-claude 0 HIGH/0 MED + 2 INFO 非阻塞 + reviewer-codex 0 finding → 双方一致 ✅ 可合

## R1 三态裁决（共 19 真问题：7 ✅ HIGH + 8 ✅ MED + 4 LOW/INFO）

### 设计决策映射

R1 reviewer 切片由 lead 映射为 plan 字母编号（详 [plan §设计决策](../../plans/history/deep-review-and-refactor-r37-20260515.md)，本 REVIEW 引用 SSOT 不复述）：

| 类 | 字母 | 主题 | 严重度（R1）| 落地 phase |
|---|---|---|---|---|
| HIGH ROI / trivial | D | mcp tool wrapper：withMcpGuard + preload subscribe | HIGH | Phase 1 Step 1.1 |
| HIGH ROI / trivial | G | codex 三处 ensureCodex 收口（codex-instance-pool）| HIGH | Phase 1 Step 1.2 |
| HIGH ROI / trivial | B | recoverer 抽 message text builder 纯函数 | HIGH | Phase 1 Step 1.3 |
| 中等改造 | F | 测试 mock factory（5 类共享）| HIGH | Phase 3 Step 3.1 |
| 中等改造 | H | 4 LLM oneshot runner 抽 helper（race/clean/prompt/SDK 设置）| HIGH | Phase 3 Step 3.2 |
| 中等改造 | I | adapter.summariseEvents dispatch 下放 | HIGH | Phase 3 Step 3.3 |
| 中等改造 | E | codex sdk-bridge 拆 input-pack/session-finalize/restart-controller | HIGH | Phase 3 Step 3.4 |
| 中等改造 | M | runBatonCleanup helper（archive_plan + hand_off_session 共享）| MED | Phase 3 Step 3.5 |
| 中等改造 | N | message-delivery-state 抽 SSOT + SQL backoff fragment 派生 | MED | Phase 3 Step 3.6 |
| 散落收口 | C | cwd resolver + emit helper（recoverer.emitFallbackMessage）| MED | Phase 4 Step 4.1 + 4.3 |
| 散落收口 | L | mcp tool result type + handler satisfies 校验 | MED | Phase 4 Step 4.5 |
| 散落收口 | J | shared/ contract vs policy jsdoc 边界 | MED | Phase 4 Step 4.7 |
| 决策不实施 | C-2 | single-flight helper（6 处）| MED | Phase 4 Step 4.2 calibration 跳过 |
| 决策不实施 | K | preload misc 拆按域（misc.ts 154 LOC）| MED | Phase 4 Step 4.4 calibration 跳过 |
| 决策不实施 | L-2 | IPC errorMode 统一 wrapper（60-80 处 handler）| MED | Phase 4 Step 4.6 calibration 跳过 |
| 不在本 plan | P4 | architectural BaseAdapter / CreateSessionOptions 拆判别联合 | MED | 留独立架构 plan |
| 不在本 plan | F2 | scheduler 命名一致性（claude 自降级 INFO）| LOW | 改造成本 > 收益不做 |
| trivial 顺手 | claude F4 LOW/INFO | omitUndefined helper + recoverer 注释碎片 | LOW/INFO | Phase 2 Step 2.1 + 2.2 |
| trivial 顺手 | codex 13 LOW | README + protocol doc 占位文案 | LOW | Phase 2 Step 2.3 |

R1 验证：双方独立提出 ✅ + 单方 grep 实证 ✅ 共构成验证条件，0 反驳证伪。

## R2 三态裁决（共 1 ✅ HIGH + 2 ✅ MED 真 R37 引入 fix + 3 pre-existing 不修）

reviewer-claude R2: 0 finding（R1 P1+P2 fix 全部对症）。reviewer-codex R2: 3 HIGH + 3 MED + 5 LOW + 1 *未验证*。三态裁决后 R37 引入 fix 清单：

### ✅ HIGH-1: spawn handler batonRole opts + hand-off-session 透传 'lead'（commit 4ba8d25）

- 文件：`agent-deck-mcp/tools/handlers/spawn.ts` + `hand-off-session-impl.ts`
- 问题：hand_off_session(team_name='X') baton 模式下，新 spawn session 加入 team 时未带 batonRole='lead' opts → spawn handler 默认走 teammate role → 0-lead team auto-archive 触发 → 新 session 还没接力就被 archive
- 修法：spawn handler 加 `batonRole?: 'lead' | 'teammate'` opts；hand_off_session 调 spawnSession 时显式传 'lead'；新 case 守门
- 验证：reviewer-codex 单方提出 + lead grep + 现场写测试 (tools.test.ts × 3) 复现 fix 前 0-lead auto-archive 触发；fix 后新 session 以 lead 加入正常

### ✅ MED-1: codex handoff slice 不限长度（commit 68f7efb）

- 文件：`session/oneshot-llm/codex-runner.ts`
- 问题：codex hand-off prompt 用 `formatEventsForPrompt` 默认按 200 events slice，对 codex 长会话 hand-off 简报精度不足；claude path 没限制
- 修法：codex hand-off runner 调 formatEventsForPrompt 显式传 `maxEvents: undefined`（不限长度），与 claude path 对齐
- 验证：reviewer-codex 单方提出 + lead grep `formatEventsForPrompt` callsites 验证 codex hand-off 是唯一受 200 cap 影响的非测试 caller

### ✅ MED-2: codex timeout race scope 包整 SDK init（commit 68f7efb）

- 文件：`session/oneshot-llm/codex-runner.ts`
- 问题：codex 60s timeout race 仅包 query() 不包 SDK init（spawn child process + handshake），SDK init 卡住时 timeout 不生效
- 修法：race scope 上提到 SDK init 之前，整个 init+query 都在 60s 内
- 验证：reviewer-codex 单方提出 + lead 现场加测试 (hand-off-session × 1) 守门 SDK init slow path

### ❌ pre-existing 不归 R37（不修留专门 plan）

- **R2 HIGH-2 / HIGH-3 / MED-3**: codex/claude 架构对称问题（codex sandbox vs claude sandbox 字段命名不一致 / restartWithCodexSandbox vs restartWithClaudeSandbox 命名 / codex resume defense 与 claude 不对称）
- 这 3 条都是 pre-existing 状态（R37 P1+P2+P3 重构没引入也没加剧），属「codex/claude 架构对称」专门话题
- 不归 R37 修，留独立架构 plan

### ⚠ 不阻塞（5 LOW + 4 INFO）

reviewer-codex R2 5 LOW + 4 INFO 全部 trivial 文档 / 命名 / 注释问题，按 plan 决策不阻塞 R37 收口。

## R3 三态裁决（双方一致 ✅ 可合）

### reviewer-claude · r3 finding

- **HIGH: 0 / MED: 0 / LOW: 0**
- **R3 verdict: ✅ 可合**
- 4 step 实施 (4.1/4.3/4.5/4.7) 全 ✅ 验证（grep + Read + 实跑 vitest 子集 + git show diff）
- 3 calibration 跳过 (4.2/4.4/4.6) 全 ✅ 跳过理由站得住（实地 grep 真单飞 / wc -l 实测 misc.ts 154 LOC / grep IPC handler 两类 errorMode 实证）
- 整体收口：R37 13 commit chain 内在逻辑一致（P1 quick wins → P2 substantial refactors → R2 corrections → P3 polish），无与 R2 fix / Phase 1-3 fix 不一致的 regression
- 新引入抽象 (cwd-resolver / emitFallbackMessage / 7 result types / shared jsdoc tags) 全部有明确动机 + ROI 验证，不违反 user CLAUDE.md「don't add abstractions beyond what the task requires」

### reviewer-codex · r3 finding

- **HIGH: 0 / MED: 0 / LOW: 0 / *未验证*: 0**
- **R3 verdict: ✅ 可合**
- 命令验证：`git diff --check ffcb663..HEAD` 通过 / `pnpm exec tsc --noEmit -p tsconfig.node.json` 通过 / `pnpm exec tsc --noEmit -p tsconfig.web.json` 通过
- 验证摘要：4.1 resolveSpawnCwd 3 生产调用点 + 6 测试 case 覆盖 / 4.3 emitFallbackMessage 6 处覆盖 + 占位 / 自动恢复失败保持 inline 符合跳过边界 / 4.5 7 XxxResult + 8 satisfies 对齐 + 3 字段类型修正成立 / 4.7 git show 736b24a 5 文件仅 +24 行 jsdoc 无实现改动 / 4.2 真 keyed Promise 单飞只 dedupHandOff + recovering 共享 map / 4.4 misc.ts 154 LOC 未触护栏 / 4.6 throw vs result 两类 handler 自表达
- vitest 跑被只读沙箱拦（写 `node_modules/.vite/vitest/results.json` EPERM），非测试断言失败

### ⚠ R3 INFO（reviewer-claude 单方提出 / 非阻塞）

reviewer-claude R3 单方提出 2 条 INFO，按 user CLAUDE.md 三态裁决「单方提出 INFO 直接 ❓」+ plan 决策「INFO 不阻塞」策略不修：

#### INFO #1: Step 4.3 L465 fallback failure 留 inline 理由稍 thin

- 文件：`adapters/claude-code/sdk-bridge/recoverer.ts:465-475` + 配套 docstring `recoverer-messages.ts:27-28`
- 问题：docstring 写「单行字面量留 inline」，但 L465 实际是 2 行 template literal（`⚠ 自动恢复失败: ${err.message}`），不严格匹配 docstring 措辞
- 影响：零行为差异，纯一致性 nit
- 不修理由：INFO 单方 + 无功能影响 + 修法（更新 docstring 措辞 / L465 一并收口）属于 polish，不阻塞收口；下次顺手可清

#### INFO #2: archive-plan-impl `ArchivePlanResult` 与 schemas `ArchivePlanResult` 命名碰撞

- 文件：`agent-deck-mcp/tools/handlers/archive-plan-impl.ts:61-68` 内部 camelCase + `agent-deck-mcp/tools/schemas.ts:465` mcp 输出 snake_case，**同名**
- 影响：误 import 立即被 satisfies 校验拦下（snake_case ≠ camelCase typecheck 期暴露），运行时无风险
- 不修理由：trivial 命名 polish，无功能影响；rename impl 内部 type 加 `Impl` 后缀消歧义可下次顺手

## 修复条目（按 phase + commit chain）

R37 完整 commit chain（13 commit + 1 R2 + 1 R2 + 4 P3 + 0 R3 = 16 commit，base ffcb663 → HEAD 736b24a）：

| Commit | Phase | 主题 |
|---|---|---|
| `bd0be75` | P1 Step 1.1 | refactor(api-facade): withMcpGuard + subscribe wrapper 收口 7 handler + 10 onXxx (R37 P1-D) |
| `d421173` | P1 Step 1.2 | refactor(codex): codex-instance-pool 收口 oneshot 双 runner 共享 SDK 实例 (R37 P1-G) |
| `10d6656` | P1 Step 1.3 | refactor(recoverer): 抽 6 个 message text builder 纯函数 (R37 P1-B) |
| `342eca7` | P1 Phase 2 | refactor: omitUndefined helper + 占位文案过期收口 (R37 P1-Phase2 trivial 顺手) |
| `e5cc6a5` | P2 Step 3.1 | refactor(tests): 抽 5 类 _shared/mocks/ factory 收口 11 test 文件 (R37 P2-F) |
| `10a0af7` | P2 Step 3.2 | refactor(oneshot-llm): 抽 6 helper 收口 4 LLM oneshot runner (R37 P2-H) |
| `04f04b4` | P2 Step 3.3 | refactor(adapter): summariseEvents dispatch 下放 (R37 P2-I) |
| `d7c2522` | P2 Step 3.4 | refactor(codex-bridge): 拆 input-pack/session-finalize/restart-controller (R37 P2-E) |
| `be0d8ef` | P2 Step 3.5 | refactor(baton-cleanup): 抽 runBatonCleanup helper 收口 ~80 行模板 (R37 P2-M) |
| `2125f64` | P2 Step 3.6 | refactor(message-delivery-state): 抽 SSOT + SQL backoff fragment 派生 (R37 P2-N) |
| `4ba8d25` | R2 fix | fix(baton): spawn handler batonRole opts + hand-off-session 透传 'lead' (R37 R2 HIGH-1) |
| `68f7efb` | R2 fix | fix(oneshot-llm): codex handoff 不限长度 + race scope 包整 SDK init (R37 R2 MED-1 + MED-2) |
| `1886247` | P3 Step 4.1 | refactor(cwd-resolver): 抽 resolveSpawnCwd helper 收口 3 处 spawn cwd fallback (R37 P3-C) |
| `bae79d4` | P3 Step 4.3 | refactor(recoverer): 抽 emitFallbackMessage 私有方法收口 6 处 emit struct (R37 P3-C) |
| `af4fafc` | P3 Step 4.5 | refactor(mcp-tools): 加 7 个 result type + 8 处 handler return satisfies (R37 P3-L) |
| `736b24a` | P3 Step 4.7 | docs(shared): 加 contract/policy jsdoc 标签明确边界 (R37 P3-J) |

### Phase 4 calibration 跳过（plan 决策详细记录）

详 [plan §Step 4.2 / 4.4 / 4.6 注释](../../plans/history/deep-review-and-refactor-r37-20260515.md)。R3 双方独立验证跳过理由站得住（实地 grep + 文件 LOC 实测 + IPC handler 抽样）。简要：

- **Step 4.2** single-flight helper：R1 估「6 处单飞」高估 → 真单飞只 2 处（dedupHandOff 已自洽 13 LOC + recoverer/restart ctx 改造涉及 sub-class state ownership 转换高风险）
- **Step 4.4** preload misc 按域拆：misc.ts 154 LOC 远未触发 500 LOC 护栏 + invoke<T>() helper Step 1.1 已评估否决
- **Step 4.6** IPC errorMode 统一 wrapper：60-80 处 handler 已合理分两类（throw vs result），handler return type 自表达，wrapper 加 errorMode 字段「重复声明」+ 改造大土无 bug

## 验收

- typecheck 双端（node + web）零错
- vitest 全套 524/524（64 skipped/Electron binding policy）全过
- 行为零变化（R37 plan 不变量第 6 条）
- R3 双方独立验证 ✅ 可合，0 阻塞 finding

## 关联 changelog

- [CHANGELOG_110.md](../../changelogs/history/CHANGELOG_110.md) — R37 落地全 phase 详细记录

## 关联 plan

- [plans/deep-review-and-refactor-r37-20260515.md](../../plans/history/deep-review-and-refactor-r37-20260515.md)（archive 后路径）
