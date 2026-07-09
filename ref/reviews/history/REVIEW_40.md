---
review_id: REVIEW_40
title: codex/claude adapter 架构对称性 R1+R2+R3 深度 review × Phase 2+3 fix 落地（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh）
created_at: 2026-05-15
plan_id: codex-claude-adapter-symmetry-20260515
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-claude-adapter-symmetry-20260515
base_commit: 91c4568
final_commit: 726af8d
parent_review_id: REVIEW_37
heterogeneous_dual_completed: true
---

# REVIEW_40 — codex/claude adapter 架构对称性 R1+R2+R3 深度 review × Phase 2+3 fix 落地

## 触发场景

REVIEW_37 R2 reviewer-codex 已发现 3 处 pre-existing「codex/claude 架构对称性不对齐」(HIGH-2/HIGH-3/MED-3),被 R37 三态裁决标 ❌ 不归 R37 scope（设计取舍 — codex/claude 架构对称是独立专题）→ 留独立 plan `codex-claude-adapter-symmetry-20260515`。

复用 R37 同款异构对抗模式（reviewer-claude Opus 4.7 teammate + reviewer-codex gpt-5.5 xhigh wrapper），**focused single-topic review**:scope = codex / claude adapter 对称性 13 文件 + 6 sub-focus(sandbox 字段命名 / restart method signature / resume defense / event emit 时序 / ensureXxx pool 模式 / SDK lifecycle 边界)。

按 user CLAUDE.md §决策对抗 多轮深度 review 编排（plan-driven 三轮 R1 → fix → R2 → R2 fix → R3 收口 + R3 fix）。R37 R3 教训:本 plan 全程 hand-off 显式传 `keep_teammates: true` 让 reviewer dormant 后可复用 mental model（实际本 plan 全程同会话内完成,无 hand-off 触发）。

## 方法

### Scope = codex / claude adapter 对称性 13 文件 + 4 共享 caller + 4 对称参照

**claude adapter (7 文件)**: index.ts / sandbox-config.ts / sdk-bridge/{index, recoverer, restart-controller, sandbox-resolve, session-finalize}

**codex adapter (6 文件)**: index.ts / codex-instance-pool.ts / sdk-bridge/{index, restart-controller, session-finalize, input-pack}

**共享 caller (4 文件)**: agent-deck-mcp/tools/handlers/{spawn, hand-off-session, hand-off-session-impl, baton-cleanup}

**对称参照（可选拉取对照）**: adapters/types.ts / claude-code/sdk-bridge/stream-processor.ts / codex-cli/sdk-bridge/thread-loop.ts / shared/types/{session,settings}.ts

### 异构对抗 reviewer

| 轮次 | reviewer-claude | reviewer-codex | team |
|---|---|---|---|
| **R1** | 1 teammate（全 scope）| 1 teammate（wrapper, 走外部 codex CLI）| `codex-claude-symmetry-r1` |
| **R2** | 同 R1 reviewer 复用 mental model（in-process backend SDK 自动 resume）| 同 R1 reviewer dormant 后 send_message 自动 resume 复用 | `codex-claude-symmetry-r1` |
| **R3** | 同 R1/R2 reviewer 复用 | 同 R1/R2 reviewer 复用 | `codex-claude-symmetry-r1` |

R2/R3 全程 1 个 team 复用 mental model — 与 R37 R3 教训（R2 reviewer 被中间 hand-off 误 shutdown 导致 R3 必须 spawn 全新对）相反,本 plan 同会话内完成无 hand-off 触发,reviewer dormant 后 send_message 自动 SDK resume 复原对话历史。

### 工作流（R1 → P2 fix 6 commit → R2 → R2 fix 1 commit → R3 → R3 fix 1 commit）

- **R1**（spawn 一对 reviewer 全 scope）: reviewer-claude 11 finding + reviewer-codex 7 finding → 三态裁决 9 ✅ 真问题清单（含 1 反驳轮 reviewer-codex 单方 HIGH 被 reviewer-claude 部分支持降为 MED）
- **P2 fix**（6 commit）: MED-C jsdoc / MED-B 删 currentSandboxMode 三层镜像 / HIGH-A single-flight + MED-A emit upserted / HIGH-B 新建 codex recoverer.ts + MED-E jsonl pre-check + LOW-A cwdExists / MED-D thread-loop case 3 + resume await / MED-F extraAllowWrite jsdoc reflect reality
- **R2**（reuse R1 reviewer mental model）: reviewer-claude 3 fix-to-fix（MED-G + LOW-B + INFO-T）+ reviewer-codex 3 fix-to-fix（HIGH 1 + MED 2）
- **R2 三态裁决 + R2 fix**（1 commit）: 3 真问题修（reviewer-codex HIGH「sessions Map 残留」+ reviewer-claude MED-G「cwdFellBack 错误信息 + 强制 fallback」+ reviewer-claude LOW-B「30s timeout silent」）;3 不修（reviewer-codex MED parity / LOW double rename / reviewer-claude INFO-T 测试覆盖留 follow-up）
- **R3 收口**（reuse R1/R2 reviewer）: reviewer-claude ✅ 可合不需补改 + reviewer-codex ⚠ 需补改（发现 R2-1 修法漏洞: 30s timeout 后 late earlyErr 仍残留 stale session）
- **R3 fix**（1 commit）: late earlyErr cleanup + reviewer-codex final ack ✅ 对症可合

## R1 三态裁决（共 9 真问题: 2 HIGH + 6 MED + 1 LOW + 6 INFO/未修）

### 真问题（必修）

| ID | 严重度 | 内容 | 出处 | 落地 commit |
|---|---|---|---|---|
| **HIGH-A** | HIGH | codex restart 缺 single-flight `recovering` Map（并发 restart 可双 SDK 子进程同 sid）| 双方独立提出 | f76aed5 |
| **HIGH-B** | HIGH | codex sendMessage 缺 recoverAndSend 自愈（app 重启 / dev vite reload 必触发 → throw 不可恢复）| 双方独立提出 | ef10747 |
| **MED-A** | MED | codex restart 不 emit `session-upserted`（DB 改完 UI 下拉值不感知）| 双方独立提出 | f76aed5 |
| **MED-B** | MED | codex bridge `currentSandboxMode` 三层镜像 vs claude 直读（R37 P1 G 删 `private codexCliPath` 同款先例）| reviewer-claude 单方 | 453520e |
| **MED-C** | MED | codex-instance-pool jsdoc「应用全局唯一」与实现不符（live bridge 自带 cache 不走 pool）| 双方独立提出 | 8d3328e |
| **MED-D** | MED | codex resume early return + thread.started 校验跳过 + restart-controller catch 死代码（future-proof gap）| reviewer-codex 单方 → reviewer-claude 反驳轮「部分支持 HIGH→MED」| c9c94d7 |
| **MED-E** | MED | codex 缺 jsonl pre-check + missing fallback | reviewer-claude 单方 + lead 实证 | ef10747（合 HIGH-B）|
| **MED-F** | MED | extraAllowWrite jsdoc 写「持久化」实现未实现（fictional claim）| reviewer-codex 单方 + lead 实证 | 8b607a1 |
| **LOW-A** | LOW | codex 缺 cwd existence check（与 HIGH-B recoverer 一同顺手）| reviewer-claude 单方 | ef10747（合 HIGH-B）|

### ❌ 不修 / 重新定性

- **R37 R2 HIGH-2 「sandbox 字段命名不一致」claim 不成立**: reviewer-claude grep 36/38 文件实证内部 TS camelCase + DB/MCP snake_case 已统一规则（0 处违反）→ 本 plan 显式 confirm 已对齐而非「fix 不一致」
- **R37 R2 HIGH-3 「restart signature 不一致」claim 不成立**: reviewer-claude grep 32 处实证方法名/参数顺序/返回类型全镜像;enum value 不一致是 SDK 内禀差异（claude `'off'/'workspace-write'/'strict'` ↔ codex `'workspace-write'/'read-only'/'danger-full-access'`）无法对齐也不该对齐
- **reviewer-codex HIGH-2 「跨 adapter sandbox 继承断链」**: 实质 design question — sandbox enum value 不平凡映射（spawn.ts:131 显式分两条 fallback chain 是设计选择不是 bug），本 plan 不 fix,留架构 plan
- **reviewer-codex MED「Codex close 只按 map key 查不按 thread id/alias」**: 与 MED-D 重叠（latent gap 触发后才相关）→ 收口在 MED-D 一并修
- **4 条 INFO**: emit session-end 差异（架构内禀 — codex thread per-session 持续可复用 vs claude query per-session lifetime stream）/ SDK init/shutdown noop 各有理由（架构内禀）/ closeSession markRecentlyDeleted 差异（codex 无 hook 通道）/ event emit 时序 LOW（无实际 race 因同 microtask 派发）

### 反驳轮（reviewer-codex 单方 HIGH「resume race」）

reviewer-codex 主题 C HIGH 单方提出: codex resume path 先返回成功 → restart-controller `newRealId !== sessionId` rollback / fork rename 防线失效。reviewer-claude R1 INFO 主题 B HIGH-3bis-3 注释「codex resume historically returns same id」言下之意 codex 不需要 rename 防线 → **双方对 codex SDK 实际 resume 行为判断不一致**,触发反驳轮。

reviewer-claude 反驳轮三反驳点结论:
- 反驳点 1（codex SDK resume 是否会返新 id）: ❌ 当前 SDK 不返（spike-A2 实测 + restart-controller.ts:97 注释铁证）;但 SDK 源码 dist/index.js:84-87 无条件 swap _id ← parsed.thread_id,允许 CLI 行为变更
- 反驳点 2（early return + 跳过 thread.started 校验是否 race）: ✅ 真 latent code bug — application layer 完全感知不到（internal.threadId 不更新 / sessions Map key 不切 / DB 仍是 opts.resume）→ silent split,历史会话静默断链
- 反驳点 3（early error 不到 restart-controller 是否 race）: ✅ 真 race + restart-controller catch 在 resume path 几乎死代码

**最终裁决**: HIGH→MED future-proof gap（当前不可见因 SDK 不返新 id,但 latent gap 真在 + 顺手关 restart-controller catch 死代码）。落地 commit c9c94d7。

## R2 三态裁决（共 6 fix-to-fix finding: 3 修 + 3 不修）

### 真问题（必修）

| ID | 严重度 | 内容 | 出处 | 落地 commit |
|---|---|---|---|---|
| **R2-1** | HIGH | resume early-error sessions Map + sdkClaim 残留半初始化 internal,后续 sendMessage 命中绕过 recoverer | reviewer-codex 单方 + lead 实证 c9c94d7 引入 | 6e0eb37 |
| **R2-2** | MED | recoverer cwdFellBack 处理两个问题:(a) emit message 与 ef10747 自身注释自相矛盾「codex jsonl 在原 cwd 下」(b) 强制 fresh thread 即使 jsonl 在 — 用户失去本可保留的对话历史 | reviewer-claude 单方 MED-G + 实证 codex jsonl 路径独立于 cwd | 6e0eb37 |
| **R2-3** | LOW | resume 30s timeout silent resolve 无 emit, 用户在 SessionDetail 等 30s 啥反馈没有 | reviewer-claude 单方 LOW-B | 6e0eb37 |

### ❓ 不修(留 follow-up)

- **reviewer-codex MED「recovering Map waiter 用 OLD_ID」**: claude 同款 limitation（recoverAndSend 返 void,waiter `await inflight` 后用 OLD sessionId,recovery 走 jsonl missing fallback rename 后 waiter 撞 sessions Map miss + sessionRepo.get 已 rename 走 NULL → throw "not found"）。改 recoverAndSend 返回 Promise<string> 是双 adapter breaking change → 留独立 cross-adapter parity plan
- **reviewer-codex LOW「double rename owner」**: reviewer-claude R2 实证 `sessionRepo/rename.ts:60 if (!fromRow) return` 静默 no-op,实际 idempotent;只是 console.warn 多打一次,不阻塞;cleanup 可 LOW follow-up
- **reviewer-claude INFO-T「测试覆盖严重缺失」**: codex `__tests__/` 仅 translate.test.ts(0 sdk-bridge 测试);HIGH-A/B + MED-D/E 全无 unit test。与 c9c94d7/ef10747 commit 自承一致,独立 plan 排期镜像 claude 套件（sdk-bridge.recovery.test.ts + sdk-bridge.consume-fork.test.ts）

## R3 三态裁决（reviewer-codex 1 fix-to-fix MED）

### R3 收口结论

- **reviewer-claude R3**: ✅ 可合不需补改 — 6 sub-focus 整体改善 ack:codex 现在有 claude 同款全套 recovery 防御;架构 drift = 0(全部字面镜像 claude pattern)
- **reviewer-codex R3**: ⚠ 需补改 — 发现 R2-1 修法遗漏路径

### 真问题（必修）

| ID | 严重度 | 内容 | 出处 | 落地 commit |
|---|---|---|---|---|
| **R3-1** | MED | resume 30s timeout 后 late earlyErr 仍留 stale session（`if (resolved) return` 短路 cleanup）→ 后续 sendMessage 命中绕过 recoverer | reviewer-codex 单方 + lead 实证 R2-1 漏洞 | 726af8d |

R3 fix 后 reviewer-codex 单点 ack: ✅ 对症可合 — earlyErrCb 已移除 `if (resolved) return`,cleanup + emit finished 永远做;late earlyErr 补 emit error message。

## 架构 drift 验证

reviewer-claude R2 主题 C 明确 ack: 所有 6 commit 修法**字面镜像 claude pattern**（restart-controller / recoverer / cwdExists thunk / sandbox-resolve 直读 / pool jsdoc / extraAllowWrite 修正）;不引入 codex 内新冗余（反 MED-B 删 currentSandboxMode 三层镜像减冗余）;不引入与 P4 BaseAdapter 设计冲突的新模式;不破坏 claude SessionRecoverer / RestartController 的对称（差异均是 SDK 形态内禀:codex 无 LLM 摘要 prepend / 无 implicit fork / 无 permissionMode / jsonl 路径不同 — 这些差异 R3 reviewer-claude 都明确 ack 为「正确的差异」）。

## 留 follow-up（不在本 plan scope）

按本 plan §不在本 scope 节,以下留独立 plan / ticket:

| ID | 来源 | 触发条件 |
|---|---|---|
| **P4 BaseAdapter / CreateSessionOptions 拆判别联合** | R37 R1 finding | 加新 adapter / 4 adapter 间 sandbox/permission 行为漂移频繁修 |
| **F2 scheduler 命名一致性** | R37 R1 finding（reviewer-claude 自降级 INFO）| 下次加新 scheduler 时一并 rename(顺手) |
| **跨 adapter sandbox 继承（reviewer-codex R1 HIGH-2）** | reviewer-codex 单方设计 question | sandbox enum value 不平凡映射方案设计 |
| **recoverer waiter Promise<string>（reviewer-codex R2 MED）** | claude + codex 同款 limitation | 双 adapter breaking change 设计 |
| **double rename owner cleanup（reviewer-codex R2 LOW）** | idempotent 不阻塞 | 顺手清理 |
| **codex sdk-bridge unit tests（reviewer-claude R2 INFO-T）** | 横跨 HIGH-A/B/MED-D/E 横向 gap | 独立 plan ~200 LOC tests + setup,镜像 claude 套件 |
| **extraAllowWrite 持久化（reviewer-codex R1 MED-F）** | hand_off_session 外置 worktree 后 app 重启 | 独立 plan: migration v019 + sessionRepo + finalize + recoverer 5 步 |

## 实施统计

- **共 8 commit**(6 R1 fix + 1 R2 fix + 1 R3 fix)
- **行为零变化为目标**(纯对齐 / refactor 风格 + recoverer 新增 = 自愈能力新增,与 claude 对齐前提下不算「新功能」)
- **typecheck 双端 + vitest 524/524 全过 + 64 环境 skip**(better-sqlite3 ABI 不匹配,与拆分无关)
- **全程同会话内完成**,无 hand-off 触发(plan §会话风格授权 autonomous mode 验证 R37 教训规避成功)

## 引用

- 本 review 配套 plan: [`plans/codex-claude-adapter-symmetry-20260515.md`](../../plans/history/codex-claude-adapter-symmetry-20260515.md)
- 父 review: [REVIEW_37.md](./REVIEW_37.md) — 触发本 plan 的 R37 R2 ❌ pre-existing 不归 R37 finding
- 父 plan: [`plans/deep-review-and-refactor-r37-20260515.md`](../../plans/history/deep-review-and-refactor-r37-20260515.md) — R37 R2 reviewer-codex 3 处 codex/claude 架构对称性发现
- 同期 changelog: [CHANGELOG_113.md](../../changelogs/history/CHANGELOG_113.md) — 本 plan 8 commit 归档
