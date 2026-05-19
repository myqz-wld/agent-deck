---
review_id: REVIEW_48
title: deep-review-batch-a1-b-followup-r3-20260519 plan 收口 — 5 plan-review + R3 fresh reviewer 4 HIGH + 6 MED 落地
created_at: 2026-05-19
heterogeneous_dual_completed: true
---

# REVIEW_48 — deep-review-batch-a1-b-followup-r3 全程异构对抗 review × 5 轮 plan-review + R3 fresh reviewer 兜底

## 触发场景

上轮 plan `deep-review-batch-a1-b-fixes-20260519` (commit `074782e` 已归档) 完成 R3 verify 重 spawn 4 reviewer fresh review 发出 **5 HIGH + 9 真 MED + 2 用户反馈** (F1 baton dormant teammate 未 shutdown + F2 archive_plan mainRepo dirty fail-fast UX)，需要全量 follow-up + R3 fresh reviewer 兜底再挖。本 plan 走「复杂 plan 流程 v2」（user CLAUDE.md §Step 0 RFC + Step 0.5 spike + Step 1 plan + Step 1.5 plan-review × 5 轮 + Step 2 worktree + Phase 1-6 fix + R3 verify + Phase 5 收口），全程异构对抗。

## 方法

### Scope

- **A1 batch (claude-code SDK bridge)**: 13 文件 — index.ts / restart-controller.ts / sdk-message-translate.ts / stream-processor.ts / types.ts / 6 个 sub-bridge test + 2 个 _shared mock
- **B batch (agent-deck-mcp tool handlers + tests)**: 17 文件 — archive-plan-impl.ts / archive-plan.ts / exit-worktree-impl.ts / hand-off-session.ts / shutdown-baton-teammates.ts (新增 Phase 5.3) / tools/index.ts / schemas.ts / transport-http.ts / types.ts + 9 个 test 文件
- **应用 CLAUDE.md + store test**: 2 文件 — resources/claude-config/CLAUDE.md / src/main/store/__tests__/rejoin-after-soft-exit.test.ts

总 32 文件 worktree 内 git diff --name-only main...HEAD scope。

### 流程

| 阶段 | reviewer pair | 输出 |
|---|---|---|
| Step 0 RFC | user 双轮 AskUserQuestion | 8 design 决策对齐（plan 范围 / H1+H2 修法选 (C) 双保险 / F1+F2 修法策略 / R3 是否重 spawn / H5 P0 test 策略 / 双失败 race fix 边界 / chain 串行化 / 矩阵 test 覆盖） |
| Step 0.5 spike1 | lead 写 mini-runner 实测 | SDK query.interrupt() 三边界行为：interrupt 不阻止 in-flight first id frame burst (case A 实测 7 frame burst) + result frame 改 'error_during_execution' (现有 expectedClose 已覆盖) + interrupt() resolve 时机在 hook frames 之后 |
| Step 1.5 plan-review × 5 轮 | claude+codex teammate 双对抗 | R1 16 修订（3 HIGH + 5 MED + 3 LOW + 2 INFO + 1 未验证 vs codex 3 HIGH + 3 MED） / R2 14 修订（1 HIGH + 5 MED + 3 LOW + 2 INFO + 1 未验证 vs codex 2 HIGH + 4 MED + 1 LOW + 1 未验证）/ R3 4 修订（claude ✅ 1 INFO trivial vs codex ❌ 3 真 MED + 1 LOW）/ R4 1 修订（codex 1 真 MED + 2 LOW）/ R5 ✅ 共识 0 HIGH + 0 真 MED |
| Phase 1-6 fix | lead | 15 commit chain（034efea → e24e335）覆盖 Test debt 工程化补全 + Race (C) 双保险 + Cache 同步 + archive_plan precheck 精确化 + F1 baton + escape hatch + 杂项注释精确化 |
| R3 verify | 4 reviewer pair fresh（reviewer-claude 全量 + reviewer-codex 3 batch 拆批） | 4 真 HIGH + 6 真 MED + 2 LOW/INFO（codex 32 文件 xhigh 撞 6m4s budget 限制按主题拆 Batch A sdk-bridge / Batch B mcp prod / Batch C+D mcp test+CLAUDE+store 并发） |
| Phase R3 fix | lead | 7 atomic commit chain（313410f → b08359e）全 land 4 HIGH + 6 MED + 2 LOW/INFO |

### 关键决策

- **Step 0 RFC 8 题**: plan 范围一个 plan 全做 / H1+H2 修法 spike1 升级 (A) → (C) 双保险（abort consume + consume guard）/ F2 修法 commit pathspec + mainRepo precheck 精确化 / F1 修法重新诊断（真根因 = F2 fail-fast 导致用户绕过 archive_plan tool）/ R3 verify 重 spawn fresh pair / H5 P0 test export production lambda 根除 inline 漂移 / H3 sync 顺序 / 全部 fix 完一次走 R3 verify
- **Step 0.5 spike1 实证**: SDK interrupt() 多种边界行为含可能 reject，case A interrupt @ 50ms SDK 仍 emit 7 frame burst（含 first id @ 2759ms），结论 race 修法不能只靠 (A) abort consume，必须 (C) 双保险加 consume L221 first-id guard
- **Step 1.5 5 轮 plan-review**: plan v2 双对抗修订共 35+ 项（覆盖矩阵 / atomic boundary 强约束 / mock 策略升级 / per-session seq 演进到 chain 串行化 / NUL parser repo-relative / 错误契约 caller-not-lead 改 error 非 silent / rejoin invariant 校准 / 闭包变量 currentSid 写入 realId 漏修等）
- **R3 reviewer-codex 32 文件 xhigh budget 撞顶**: codex 6m4s 内 15 shell exec 全用于读文件未进入分析阶段。lead 按 user CLAUDE.md §reviewer-codex 失败兜底「严禁同源化降级」+ 应用环境「合规兜底允许」，决策走拆 4 batch 重起 reviewer-codex teammate（A: sdk-bridge 11f / B: mcp prod 9f / C+D: mcp test + CLAUDE + store 12f），保持异构对抗 + reviewer-claude 全量 32 文件不变。
- **R3 fix 用户 confirm 全修**: 4 HIGH + 6 MED + 2 LOW/INFO 全 land 不拆下一轮 plan（避免连续 R 轮 fix 心智负担）

## 三态裁决

### R3 verify 4 reviewer 独立 finding 合并 → R3 fix（全部 ✅ 真问题必修）

**真 HIGH ×4（全 land）**：

| # | finding | 来源 | 验证 | R3 fix commit |
|---|---|---|---|---|
| H1 | `restart-controller.ts` Phase 2.9 两个 race：① `restartWithClaudeCodeSandbox` 完全没改（不对称漏修）② `restartWithPermissionMode` 加了 listener 但 recovering Map key set 时是 OLD、rename 后 delete 用 NEW → OLD stale Promise 永驻 + NEW caller 绕过单飞 | claude MED-1 + codex A HIGH-1 合并升级 | 双方独立 + 现场 grep 实证：grep restart-controller.ts:246-340 0 个 session-renamed listener；event-bus.ts:94-103 listener 同步执行；stream-processor.ts:300-311 confirm rename emit 时机 | `313410f` |
| H2 | `archive-plan-impl.ts:144` `runGit.trim()` 破坏 porcelain `-z` NUL 输出：`' M plans/INDEX.md\0'.trim()` 首列 space 被吃 → parser status=`'M '` filename=`'lans/INDEX.md\0'` → criticalSet 永不命中 → Y 列 unstaged critical path 全漏判 | codex B HIGH-1 | 现场 `node -e` 实测铁证 `' M plans/INDEX.md\0'.trim()` → `'M plans/INDEX.md\0'` | `4507537` |
| H3 | `archive-plan-impl.ts:340` `assertBaseBranchIsNamedBranch` 仅 rev-parse 校验：`refs/heads/main~1` 通过 verify exit 0 (rev-parse 接受作为 valid rev expression) → ff-merge `git checkout main~1` 进 detached HEAD → 归档 commit 落 detached HEAD → B-HIGH-3 同款数据丢失 | codex C+D HIGH-1 | 现场实测 `git rev-parse --verify --quiet refs/heads/main~1` 返回 commit hash `a02cb9c...` exit 0 + `git check-ref-format --branch main~1` fatal exit 128 | `4507537` |
| H4 | `archive-plan-impl.ts:250` `git status --porcelain=v1 -z` 缺 `--untracked-files=all` → default mode 输出 untracked 仅目录级 `?? plans/\0` → criticalSet.has('plans/INDEX.md') 不命中 `'plans/'` → untracked critical 文件全漏判 | codex C+D *未验证* 升级 | 现场建临时 git repo 实测 default mode `?? plans/\0` vs `--untracked-files=all` `?? plans/INDEX.md\0?? plans/myplan.md\0` 铁证 | `4507537` |

**真 MED ×6（全 land）**：

| # | finding | 来源 | 验证 | R3 fix commit |
|---|---|---|---|---|
| M3 | `index.ts:590` per-session `permissionModeSeq` 不防同 session 并发双失败脏 cache：A: ++seq=1, oldMode='default', s.permissionMode='plan', await 失败 → B: ++seq=2, oldMode='plan'(A optimistic), s.permissionMode='bypass', await 失败 → B catch: seq===2 === B.seq → s.permissionMode = oldMode = 'plan' (A 脏值)；A catch: seq===2 !== A.seq(1) → 跳过回滚 → 最终 cache='plan' 但 SDK 实际仍'default' → 脏 cache → canUseTool 按脏 cache 判断 → 安全降级风险 | codex A HIGH-2 降级 | 推理链清晰 + 现场看 set-permission-mode-rollback.test.ts:170-269 现有 case 仅 cover A 失败 + B 成功，未覆盖 A/B 都失败 | `f00ade3` (chain 串行化替代 seq counter) |
| M2 | `spoofing-attack-paths.test.ts:70` stdio sentinel 本地复制 `() => EXTERNAL_CALLER_SENTINEL` 不绑 production transport-stdio.ts → 将来 transport-stdio 回退 `null` test 不报警 → B-HIGH-1 修法被静默 ship | codex C+D MED-1 | 现场读 spoofing-attack-paths.test.ts:30-31 注释承认 "stdio override 写死与 transport-stdio.ts:85 一致" 是本地复制；rg 验证 test 只 import transport-http 不 import stdio | `8721786` (抽 `stdioCallerSessionIdOverride` lambda export + test 真 import) |
| M5 | `exit-worktree.ts:76` handler wrapper `err(result.error, result.hint)` 丢失 `markerCleared` 字段 → Phase 5.6-5.8 加的 partial-success markerCleared 对 MCP caller 不可见，caller 无法判断是否手动调 IPC clearCwdReleaseMarker 兜底 | codex B MED-2 (scope 外但 focus 相关) | 现场读 exit-worktree.ts:76-78 + helpers.ts:146-156 err signature 只接 `message + hint` | `4db30c3` (err helper 加 optional `extras` 参数 + wrapper 透传 markerCleared) |
| M6 | `dormant-teammate-shutdown.test.ts:78` mock listActiveMembers 不调真 SQL → 将来 SQL 加 lifecycle 过滤本 test 不会 fail → baton-cleanup 漏 dormant teammate 静默回归 | codex C+D MED-2 | 现场读 test 注释「mock 返回手工构造的 dormant member」+ 未调真实 createAgentDeckTeamRepo | `9c270fb` (补 in-memory DB 2 case 锁真 SQL invariant，defense in depth) |
| M1 | `spoofing-attack-paths.test.ts:108-115` + `helpers.deny-external.test.ts:180-188` 矩阵 writeTools 数组漏 Phase 5.3 新增的 `shutdown_baton_teammates` 第 8 个写 tool | reviewer-claude LOW 升级 | grep 两处 writeTools 数组 0 命中 `shutdown_baton_teammates`；types.ts EXTERNAL_CALLER_ALLOWED.shutdown_baton_teammates=false confirm 已 deny external | `b08359e` (两处数组加 + 注释「7 写 tool」改「8 写 tool」) |
| M4 | `archive-plan-impl.ts:517` "无关 dirty 降 warning + commit message 注脚" 注脚未实际写入 commit message：warnings 仅 push 到 ok return 数组，commitMsg 是固定单行 → git log 看不出归档时刻 mainRepo 有 N 个无关 dirty 文件 | codex B MED-1 | rg 验证 commitMsg 是固定 single line，无 warnings 拼接路径 | `b08359e` (commitMsg 加 footer 「Note: N unrelated dirty file(s)...Sample: <up to 3>」) |

**真 LOW + INFO ×2（trivial）**：

| # | finding | 来源 | R3 fix commit |
|---|---|---|---|
| L1 | 应用 CLAUDE.md:154 `baton 不计 spawn_depth` 文档过时（写成「内部 spawn 一律 batonMode:true」），与 production `resolveBatonRoleForSpawn` 在 archive_caller=false 时返回 batonMode=false 不一致 | codex C+D LOW | `b08359e` (文档改成「仅 archive_caller=true 时 batonMode:true; archive_caller:false 退化 normal spawn」+ 补充 fork-bomb 防御理由) |
| I1 | `stream-processor.ts:154` + `index.ts:327` 两处 fire-and-forget `void internal.query?.interrupt?.()` 未挂 .catch，SDK interrupt reject 触发 unhandled rejection | reviewer-claude INFO + codex A MED-1 同款 | `b08359e` (两处加 `.catch(err => console.warn(...))` 吞错 + 留痕) |

### R3 反驳轮决策

**未走反驳轮**（直接现场验证铁证省时）：H1/H2/H3/H4 通过 grep + 实测 git 命令 + 临时 fixture 验证后即可确认真问题，没必要让 codex/claude 再走反驳轮浪费 round-trip。

**M3 推理链**: codex A HIGH-2 论述清晰 + 现场看 set-permission-mode-rollback.test.ts 现有 case 未覆盖双失败场景 → 推理 + 测试缺口双重 evidence 直接确认。

**M2/M5/M6 设计选择**: 三条都是「test 不绑 production / handler 丢字段 / mock 不锁 SQL」design improvement，用户 confirm 全修后即纳入。

## R3 fix 总结判断

**✅ 全部可合**：22 commit chain 完整 land；4 HIGH + 6 MED + 2 LOW/INFO 全清；typecheck pass + 32 file 416 test pass + 5 skip (binding ABI by-design) + 0 regression。

## 经验沉淀（影响后续 plan）

1. **plan-review 5 轮收口 vs 单轮就过**：本 plan 5 轮 plan-review（R1 16 修订 → R2 14 修订 → R3 4 修订 → R4 1 修订 → R5 ✅ 共识）暴露了大 plan 写作的 design 演进盲点。单轮 plan-review 就 ✅ 通常意味着 reviewer 没真正 review 完，应至少 2 轮（R1 finding + R2 fix verify）。
2. **R3 verify reviewer 单 prompt 32 文件 xhigh 撞 budget**：codex 单轮 review 文件数应 ≤ 10（与 user CLAUDE.md §大 scope 拆批 阈值 ≤ 10 一致）。本 plan 因为 32 文件全量超阈值，按主题拆 4 batch 并发避免 budget 耗尽。这是「拆批+ 异构 reviewer pair」的实战 SOP（未来类似 R3 verify 默认拆批）。
3. **Phase 2.9 修法引入二阶 race（recovering Map key 不一致）**：R3 fresh reviewer 抓到 Phase 2.9 修法本身引入的新 race 模式 — listener 改 currentSid 但 set(OLD)/delete(NEW) 不配对。下次类似 race fix 必须把「set/delete key 一致性」当 invariant 显式 test 覆盖。
4. **lambda export 不能省**：H4/H5 export production lambda + test 真 import 是「test 不漂移 production」根治。M2 spoofing-attack-paths.test.ts stdio override 本地复制就是漏 export 的复发 — 未来 fix 一个 lambda 必须同步抽出 test seam。
5. **runGit().trim() 破坏 NUL 输出**：通用 helper（默认 trim）+ 特殊场景（-z NUL）的接口设计 mismatch 是 H2 真根因。未来任何 NUL 分隔 / binary-safe 协议都必须 caller 显式 raw opt-in（不依赖通用 helper 默认行为）。

## 关联归档

- [CHANGELOG_129](../changelog/CHANGELOG_129.md)：本 plan 22 commit chain 完整变更
- plan archive 路径：`<main-repo>/plans/deep-review-batch-a1-b-followup-r3-20260519.md`（C6 archive_plan tool 完成后）
- 上轮 plan 引用：[REVIEW_47](REVIEW_47.md) + [CHANGELOG_128](../changelog/CHANGELOG_128.md) (deep-review-batch-a1-b-fixes-20260519)
