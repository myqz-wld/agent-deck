---
name: deep-review
description: "Deep review agent for complex code, plan, or mixed-scope reviews. Use for deep review, multi-round review agents, review-fix loops, plan/RFC review, mixed review, overall validation of complex changes, or Chinese anchors such as 深度 review, 双对抗 review, review agent 深挖, 再 review 一轮, 深挖整体改动是否符合预期, and plan 评审. Spawns reviewer-claude and reviewer-codex as a heterogeneous pair across rounds; lead must adjudicate findings, require example-backed complex issues, produce a final summary report, and block merge until CRITICAL/HIGH findings are fixed or rebutted."
---

# Deep Review — 多轮异构对抗 review × fix 收口（code / plan / mixed）

把「review → fix → review → fix → ... 直到挖不出新问题」封装成可复用流程。重点是**多轮挖深**：第 1 轮抓浅层（typo / null / 错变量 / plan 流程矛盾），第 2-3 轮挖深层（race / leak / 边角 / 架构 / 测试盲区 / 性能尾延迟 / plan 不变量边界 / step 行级 reference 漂移）。

> **前提**：会话已挂载 agent-deck-mcp（应用 Settings → Agent Deck MCP server 已启用）。本 SKILL 走 `mcp__agent-deck__*` tool 编排；Backend 协议（spawn / send_message / dispatch / wire format / shutdown 语义）SSOT 在应用约定文件（claude 端 `CLAUDE.md` / codex 端 `CODEX_AGENTS.md`）「Agent Deck Universal Team Backend」节。

## 何时用

- **kind='code'**: 关键路径 / 核心抽象的代码变更（multi-client / 并发 / lifecycle / 资源管理）；跨多模块、影响主链路（≥ 200 行 / ≥ 5 文件）；MR 提交前最后一道闸门
- **kind='plan'**: 复杂 plan 写完先评审（应用 CLAUDE.md §复杂 plan：Agent Deck baseline 最小协议 §Review Gate 调用入口）— 评审 plan design / 流程一致性 / 不变量定义 / step 行级 reference / 测试矩阵覆盖度
- **kind='mixed'**: 复杂 refactor 同时含 plan 设计 + code 实施一致性需双向评审；多 phase plan 完成后 meta-review 收尾
- **不适合**：trivial 改动（typo / 单点 rename / 显然措辞修订）— 一轮人审就够

## Scope schema (typed args)

caller invoke SKILL 时显式传 typed scope，**不依赖 path 后缀启发**：

```ts
{
  kind: 'code' | 'plan' | 'mixed',
  paths: string[],            // 文件清单(绝对路径)
  ack_cache_unignored?: boolean   // optional;批处理 / 自动调度场景显式 ack 跳过 .gitignore 自检 + 接受 cache untracked 风险(详 §Sandbox 处理 step 6)。default false
}
```

**caller 责任**:
- `kind` 必须显式传(不要让 SKILL 猜)
- `paths` 全绝对路径(与 spawn cwd 同前缀,worktree 内必须含 `.claude/worktrees/<plan-id>/` 前缀;**例外**: §Sandbox 处理 自动 cp 路径除外详下节)
- caller 自己拆批(单批 ≤ 10 文件 / ≤ 30 行 prompt)

## ⚠️ Sandbox 处理（auto cp + manifest）

**问题**：scope 路径含 worktree 外文件（如 user 家目录配置文件 / 其他 repo / 系统路径）→ reviewer 受 sandbox 限制读不到（详 reviewer-{claude,codex} body §Sandbox 限制说明 节）。

**reviewRoot 定义**：`reviewRoot` = SKILL spawn 时 caller 传入的 cwd 参数（绝对路径，可为 repo root / worktree root；SKILL 不强制处于 worktree）。cache 一律落在 `<reviewRoot>/.deep-review-cache/<invocationId>/`。

**SKILL 自动 cp 落地**（caller invoke SKILL 时本节第一步执行）——把 reviewRoot 外的文件 cp 到 reviewRoot 内 cache 目录让 reviewer SDK sandbox 能读（reviewRoot 见上方定义，可为 repo root / worktree root），review 完自动清，每次调用建独立子目录避免并发互踩：

1. **生成 invocation-id**：`<invocationId> = sha256(timestamp+random)[0:8]` 标识本次 SKILL 调用。每次 invoke SKILL 都生成新 id,即使同一 SKILL 用同一 scope 调多次也不冲突
2. **建 cache 子目录**：`<reviewRoot>/.deep-review-cache/<invocationId>/`(每次 invocation 独立子目录,**避免并发 review 同 scope 互踩**)
3. **检查 scope.paths 每个路径**：路径前缀含 `<reviewRoot>/` → 直接传给 reviewer；不含 → 走 cp 流程
4. **cp 外部文件进 reviewRoot cache**：
   - cache file 命名：`<reviewRoot>/.deep-review-cache/<invocationId>/<fileSha8>-<sanitized-basename>.md` （`<fileSha8>` = sha256(原 abspath)[0:8] 防同名 basename 冲突;`<sanitized-basename>` = 原 basename 去除 `[^A-Za-z0-9._-]` 字符;**注**:`<invocationId>` 与 `<fileSha8>` 是两个不同维度的 sha8 separate placeholder 不复用）
   - Bash `cp <orig-abspath> <cache-path>`
   - 路径表替换：reviewer 收到的 scope 用 cache 路径替代原 abspath
5. **生成 manifest**：`<reviewRoot>/.deep-review-cache/<invocationId>/manifest.json`(放 invocation 子目录内,与 cache files 同级)
   ```json
   {
     "invocationId": "<invocationId>",
     "createdAt": "<ISO>",
     "files": [
       { "origAbspath": "/Users/.../ref/plans/foo.md", "cachePath": "<reviewRoot>/.deep-review-cache/<invocationId>/<fileSha8>-foo.md" },
       ...
     ]
   }
   ```
6. **SKILL 启动 step 0 双自检**：
   - **sweep 旧 orphan**：扫 `<reviewRoot>/.deep-review-cache/*/manifest.json`，`createdAt` 距今 > 24h 的 invocation 子目录全删 `rm -rf <invocation-id>/`（中断的 SKILL 留下 orphan 不会无限累积）
   - **`.gitignore` 自检**：`Bash: grep -q '^\.deep-review-cache/' <reviewRoot>/.gitignore` 失败 → warn caller「`.gitignore` 缺 `.deep-review-cache/` entry，cache 文件可能被 commit；请加 entry 或接受风险继续」继续不 abort（本项目 `.gitignore` 已加，自检失败常发于跨项目用 SKILL 时）。**批处理 / 自动调度场景**(caller 看不到 warn 输出):caller 必须在 invoke SKILL 时显式传 `ack_cache_unignored: true` 跳过自检 + 接受 cache untracked 风险;否则 SKILL warn + abort 让 caller explicit consent
7. **review 完后 cleanup**：`rm -rf <reviewRoot>/.deep-review-cache/<invocationId>/` 整个子目录干掉(子目录粒度删,每次 invocation 独立不影响别 invocation 的 cache files)。包 try/finally 即使 cleanup 中失败也尝试 rm 一遍

**caller 看到**：scope 路径透明（仍传原 abspath），SKILL 内部路径替换后 reviewer 拿到 worktree 内 cache 路径。

**应用层 .gitignore 兜底**：repo / worktree 根目录 `.gitignore` 已加 `.deep-review-cache/` entry,cache 目录及其子目录全不入 git;ff-merge 回 baseBranch 时也不污染。

**失败兜底**：cp 撞权限 / 磁盘满 → SKILL warn + abort，告知 caller 手工 cp 后再 invoke。

## 异构对抗

每轮**必须**两个 reviewer 同时起；初轮 spawn，**后续轮次复用同一对**（send_message 不重新 spawn）：

| Reviewer A | Reviewer B |
|---|---|
| `reviewer-claude` teammate（claude-code adapter，Claude 系模型） | `reviewer-codex` teammate（**codex-cli adapter，native codex SDK in-process**，Codex/OpenAI 系模型） |

两个 teammate 完全独立（互不知道对方存在）。**lead 自己**做三态裁决，不让 teammate 既当 reviewer 又当裁判。同源化禁令（不可降级到双 Claude）见 §失败兜底 引用。

> **跨 adapter 直起**：reviewer-codex 不再走 wrapper 形态（claude SDK 子进程内部 Bash 跑外部 codex CLI），而是 lead 调 `spawn_session({adapter:'codex-cli', agentName:'reviewer-codex', ...})` 直接起 codex SDK 子进程承载 reviewer-codex agent body。lead adapter 任意（claude-code 或 codex-cli）— SKILL 编排始终生成 native reviewer-claude（claude-code adapter）+ native reviewer-codex（codex-cli adapter）一对，物理保证异构。

## 多轮挖深（按 kind 分流）

| 轮次 | kind='code' focus | kind='plan' focus | kind='mixed' focus |
|---|---|---|---|
| Round 1 | 修复正确性 / 是否引新问题 / 测试质量 | 流程一致性 / 设计决策清晰 / 步骤 checklist 完整 | 上述两 mode 并行 |
| Round 2 | 边界条件 / 并发 race / 资源 lifecycle | 不变量定义边界 / step 行级 reference / 测试矩阵覆盖 | 上述两 mode 并行 |
| Round 3 | 架构耦合 / 安全 / 性能尾延迟 | 跨 phase 设计漂移 / 触发条件矛盾 / fallback 缺失 | 上述两 mode 并行 |
| Round 4+ | 上轮残留 + 用户特别关注 | 同款 | 同款 |

## ⚠️ kind='mixed' 成本与失败兜底

**成本明示**（2 reviewer × 2x scope 设计）：仍 spawn 2 reviewer（与 §异构对抗 表一致 — reviewer-claude + reviewer-codex），但 **prompt scope 含 code + plan 双 mode focus**（同一对 reviewer 拼合并 prompt 同时审 code 实施 + plan 设计一致性）。成本 = 2 reviewer × 2x scope = 2x token + 2x time per reviewer（**同 reviewer 数,prompt 体积翻倍**），不是 spawn 4 reviewer。

**失败兜底**：任一 reviewer fail（reviewer-claude: claude SDK 起不来 / OAuth 过期 / sandbox 拒 / timeout；reviewer-codex: codex SDK 起不来 / OAuth 过期 / shell tool call cancel / sandbox 拒 / timeout / codex thread jsonl 缺失 fresh-session abort）→ SKILL **不阻塞**，其他 reviewer 仍跑;失败方丢失整 reviewer（含 code + plan 双角度,因 mixed 模式 reviewer 本体含两 mode 无法只丢一半）；缺失方 finding 降级为「单方」非 CRITICAL/HIGH（遵循本 SKILL §三态裁决）。

**fallback 优先级链** (lead 必按此顺序处理 reviewer fail,不要直接走 ③ 跳过 ① ②):
- **①** 等 SDK / OAuth 恢复 (短超时 retry ≤ 5min) → 失败转 ②
- **②** §失败兜底 表「重 spawn 失败 reviewer」(shutdown_session + spawn_session 重起,仍异构) → 重 spawn 仍失败转 ③
- **③** 降级单方非 CRITICAL/HIGH 走当前 §99 fast path (失去对方 reviewer 覆盖,但 §三态裁决 §单方独有分流 保障 single-side CRITICAL/HIGH 不被错升级)

**异构保障核心 invariant**: ✅ CRITICAL/HIGH 必双方独立提出 OR 单方 + 现场验证,并且必须有反驳论;mixed fallback 路径 ③ 下 single-side reviewer 提出的 finding 必须过 §单方独有分流(CRITICAL/HIGH → 反驳轮 / MEDIUM → lead Grep/Read 验证)才能成 CRITICAL/HIGH,reviewer fail 不会让 active reviewer 独自决定 CRITICAL/HIGH。

**典型场景**（**不用 mixed 的情况**）：
- 单纯 plan review（写完 plan 评审 design） → kind='plan'（2 reviewer 即可,常规成本）
- 单纯 code review（实施完评审代码） → kind='code'
- 不需要双向交叉评审 → 走单 kind 节省 prompt token

## 三态裁决

每条 finding 三态裁定：
- ✅ **真问题**（CRITICAL/HIGH 必须满足 ≥1 个验证条件）：「**双方独立提出**」（异构强冗余即算验证）**或**「**一方提出且现场实践验证成立**」（grep 出 N 处证据 / 写小 test 复现挂掉 / 跑命令确认）→ CRITICAL/HIGH 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，记反驳依据
- ❓ **部分 / 未验证**：双方角度不同 / 一方提出但纯文本推理（含弱断言）尚未实践验证 → 综合后决定，强制降到 MEDIUM 或更低

**CRITICAL/HIGH 反驳论**：任一 CRITICAL/HIGH finding 都必须走 §Step 4。单方提出时让另一 reviewer 反驳；双方独立提出时仍让至少一方针对「是否真达 CRITICAL/HIGH」写反驳论。最终裁决必须同时记录支持论、反驳论、lead 判定。

**单方独有分流**：CRITICAL/HIGH → §Step 4 反驳轮；MEDIUM → lead 自己 Grep / Read 验证（≤ 5min / ≤ 5 grep / ≤ 1 test，超就保留 ❓ 并降到 LOW/INFO）；LOW/INFO → 直接列 ❓。双方都说没问题 → ✅ 可合。

## 五级严重度（P0-P4）

严重度只按真实影响和触发概率定级；证据不足时降级，不用高等级表达不确定性。

| 等级 | 评定细则 | 合入门槛 |
|---|---|---|
| CRITICAL (P0) | 可稳定触发数据丢失 / 权限绕过 / secret 泄露 / 任意代码执行 / 跨 session 严重串线 / 主链路全局不可用，且没有可靠规避路径 | 必须修复或证伪；必须有反驳论；存在时禁止合入 |
| HIGH (P1) | 支持路径上可复现的崩溃、死锁、状态损坏、安全边界破坏、用户工作丢失、核心功能错误结果，或设置 / 迁移 / 协议改动导致一类用户稳定回归 | 必须修复或证伪；必须有反驳论；存在时禁止合入 |
| MEDIUM (P2) | 真实缺陷但有明确规避路径、触发范围有限、影响非核心路径；或高风险改动缺关键回归测试；或文档 / prompt 误导会让 agent 做错但不会直接破坏安全边界 | lead 必须记录本轮修、接受风险或 follow-up；不单独阻止合入 |
| LOW (P3) | 小范围边界问题、轻微 UX / 文案 / 注释 drift、可读性或维护性改进，触发概率低且影响可逆 | 记录即可，不阻止合入 |
| INFO (P4) | 背景观察、验证覆盖说明、非行动项 caveat、改进想法、已确认无问题的风险点 | 仅供裁决上下文 |

## 收口 / 拒合

**收口**（全部满足）：双 reviewer 都「可合」+ 0 个 CRITICAL/HIGH + 上轮 CRITICAL/HIGH 真问题已 fix 通过测试 + MEDIUM 均有 lead 处置记录。
**拒合**：还有 CRITICAL/HIGH 未修或未证伪 / 双方仍发现 ≥ 5 条新真问题 / 用户主动停。

## Final Summary Report

When deep review reaches 收口 or 拒合, lead must deliver a final summary report before ending the workflow. Do not finish with only "done" or "review passed".

Report fields:
- Scope and review kind, including the reviewed paths and number of rounds.
- Final gate: PASS / BLOCKED / ABORTED / ESCALATED.
- Reviewer coverage: both reviewer session ids, fallback/retry status, and whether the heterogeneous pair stayed intact.
- Findings by severity and tri-state outcome, including CRITICAL/HIGH support, rebuttal, and lead decision.
- Complex finding examples: for every accepted complex finding, include a short user-facing example that names the concrete trigger path, state sequence, input, or plan step and the visible failure.
- Fix and decision log: files changed, tests or commands run, MEDIUM disposition, accepted risk, and follow-up items.
- Cleanup status: reviewer shutdown status and sandbox cache cleanup status.

## 执行模板（7 步）

| Step | 动作 | 关键字段 / 等什么 |
|---|---|---|
| 0 | 准备 `cwd`（仓库 / worktree 绝对路径）+ `scope: {kind, paths}`（typed schema 上节）| caller 显式传 kind;SKILL 走 §Sandbox 处理 auto cp 把 worktree 外路径 cp 进 cache |
| 1 | 并发 spawn 两 reviewer：`spawn_session({adapter, cwd, prompt, teamName, agentName, displayName})` × 2，**adapter 各异**（reviewer-claude → `adapter:'claude-code'` + `agentName:'reviewer-claude'`；reviewer-codex → `adapter:'codex-cli'` + `agentName:'reviewer-codex'`），body 自动注入到 prompt 头；prompt 按 kind 选模板（kind='code' → §code 模板 / kind='plan' → §plan 模板 / kind='mixed' → §mixed 模板）| 各拿 `spawnPromptMessageId`，是首轮 reply chain 锚点；两 spawn 之间不要等 reply。**注**：lead adapter 与 reviewer adapter 无关 — claude-code lead 同样走 `spawn_session(adapter:'codex-cli', ...)` 跨 adapter 起 reviewer-codex；codex-cli lead 走 `spawn_session(adapter:'claude-code', ...)` 跨 adapter 起 reviewer-claude，对偶物理保证 |
| 2 | **告诉 user**「已派 2 个 reviewer 跑 review，UI 实时显示进度，reply 来了我会自动收到处理；期间你可以随时插话（跳过 X / 优先看 Y / abort 某 reviewer）」**然后等 reply 自动注入**。reviewer 跑完调 `send_message + replyToMessageId` 后 reply 自动注入 lead conversation flow（dispatch 机制 / wire prefix 详应用约定文件 §Universal Team Backend）。**lead 不主动 poll** | 两份独立 finding 自动到达 lead conversation；user 也可在 UI 实时看 |
| 3 | 三态裁决：双方一致 → ✅；任一 CRITICAL/HIGH → Step 4 反驳轮；单方独有 MEDIUM → lead 自己 Grep/Read 验证；LOW/INFO → 直接列 ❓ | — |
| 4 | 反驳轮（所有 CRITICAL/HIGH）：`send_message({sessionId: B-sid, teamId, text: '<A 的 finding 全文> 请独立反驳', replyToMessageId: <Round 1 messageId>})` 把 A 的 finding 给 B 反驳（reverse 同理）→ 同 Step 2，等 B 的反驳 reply 自动注入 lead conversation | 同一条 finding 必须记录支持论与反驳论；反驳后仍不能定 → lead 自己验证；还不行 → 降为 MEDIUM 或更低 |
| 5 | fix → 下一轮：lead 修 CRITICAL/HIGH 真问题；MEDIUM 明确「本轮修 / 接受风险 / 记 follow-up」；改代码 / 改 plan 后，**复用同一对** teammate 调 `send_message` 发 Round 2 prompt（必带 `skip` 字段 = 上轮 ✅ fix 摘要，每条按格式 `已修：<filepath:line> <一句话改动> (commit <hash>)`，避免 reviewer 重复列）→ 等 reply 自动注入 → 回到 Step 3 → ... → 直到 §收口 判定满足（0 CRITICAL/HIGH + 双方共识可合）才进 Step 6。**多轮迭代期间绝不 shutdown**（违反「复用同一对 teammate」invariant — 重 spawn 会丢跨轮 mental model + 撞 reviewer-codex FRESH SESSION 拒） | — |
| 6 | **最终**收尾（仅当 §收口 判定满足后执行）：`shutdown_session` × 2 + SKILL cleanup auto-cp cache（按 manifest 精确 rm）+ 输出 §Final Summary Report | **前置约束**：只在确认本对 reviewer 不再用时才 shutdown — 多轮 fix loop 期间 `Step 5 回到 Step 3` 严禁 shutdown（违反 Step 5 invariant）。shutdown 不删 events / messages，lead 仍可在裁决报告里引用。**想几小时后再 R3 复用 reviewer mental model 时同样不要 shutdown** —— 留着让 lifecycle scheduler 自然 dormant，下次 send_message 会自动 SDK resume 复原对话历史；只有彻底不再用本对 reviewer 才 shutdown（详应用约定文件 §dormant ≠ 丢 mental model 节）。收尾后必须给用户总结报告，不要只说 review 已完成。 |

> **lead 自然推进**：reply 走 adapter dispatch 自动注入 receiver SDK conversation flow → reviewer reply 一到 lead 自动收到一条 user-role message → lead 当作普通 user input 处理 → 自然完成裁决 / 进入下一步。user 在场不在场都正常推进。

### lead 怎么处理 reviewer 卡死（reply 一直不到）

**触发**（任一）：
- user ping「reviewer 卡了吗 / 进度？」时 lead 顺便检查
- `get_session(reviewerSid).lastEventAt` 距今 ≥ 30min 且仍无任何 reviewer reply（与 spawn 后总时长无关）

**lead 自检步骤**：
1. 仅在 user 下一轮询问状态或达到 30min 阈值时调 `get_session(reviewerSid).lastEventAt`，看 reviewer 是否还在推进（recent ts → 还在跑只是慢，告诉 user 再等等；非 recent → 卡死）
2. 如果卡死 → `send_message({sessionId: reviewerSid, teamId, text: '📍 nudge: 我在等你 reply 上一条 review request；完成后请 send_message 回我；进度需要更多时间也请回一句告知', replyToMessageId: <last messageId>})`
3. nudge 后不要循环查询；下一轮仍无 reply 且达到阈值 → 走 §失败兜底「reviewer 持续卡死」recipe（PendingTab 真人介入 / shutdown 重 spawn / 合规兜底）

**绝不无限等**：30min（按 `lastEventAt` 判定 + user 多次 ping 仍无 reply）后 reviewer 仍卡死必须 abort 该 reviewer，不要让 lead 在 user 多次 ping 中持续消耗 context。

## Prompt 模板（按 kind 分流）

每次 spawn 或 send_message 的 prompt 必带：
- `output_mode: full_review` 或 `rebuttal`
- `scope`：文件清单（**绝对路径**，与 spawn cwd 同前缀；worktree 外路径已被 SKILL §Sandbox 处理 auto cp 替换为 cache 内路径）
- `focus`：本轮重点维度（按 kind + Round N 选 §多轮挖深 表对应行）
- `finding_contract`：每条 finding 必带定位、片段、验证手段、严重度、修复方向；复杂 finding 必带用户解释示例
- `skip`：上轮 ✅ fix 摘要 / 已审过的稳定项；每条按格式 `已修：<filepath:line> <一句话改动> (commit <hash>)`

### kind='code' 模板（focus 维度）

```
focus:
- 修复正确性 / 是否引新问题 / 测试质量
- 边界条件 / 并发 race / 资源 lifecycle
- 架构耦合 / 安全 / 性能尾延迟
- 测试覆盖度（每个 fix 是否有回归 test）
```

### kind='plan' 模板（focus 维度）

```
focus:
- plan §设计决策 是否清晰 / 不变量定义边界明确
- 步骤 checklist 行级 reference 准确（line 号 / 函数名 / 文件路径与代码现状对齐）
- 流程一致性（RFC 决策 / spike 实证 inline 进 §设计决策）
- 测试矩阵覆盖度（plan §不变量 是否每条有对应 test case）
- §下一会话第一步 是否完整可执行（cold start prompt 含绝对路径）
- §已知风险 / 历史问题 是否完备
```

### kind='mixed' 模板（双 mode 并行）

```
focus:
- 同时按 kind='code' 模板 evaluate 代码实施
- 同时按 kind='plan' 模板 evaluate plan 设计
- 重点：plan 设计 → code 实施的一致性（plan §设计决策 vs 实际代码行为对齐 / plan §不变量 vs 实际守门 enforce）
```

## Finding 输出契约（lead spot-check 用）

每条 finding 必须带：
- `文件:行号` + 代码 / 原文片段（≤ 6 行）
- **验证手段**（如 "grep 出 3 处全无 null check" / "写 stateful mock 模拟双 disconnect 实测 abort 0 次"）
- **用户解释示例**：复杂 finding（race / lifecycle / 架构耦合 / 安全 / 性能 / 多 step plan drift）必须给一个 concrete example：触发路径、关键状态变化、输入或 plan step、用户能看到的失败结果。示例必须使用 scope 里的真实函数 / 文件 / plan step 名称，不写抽象比喻
- **修复方向 / fix direction**：1-2 行说明应该改哪里、改什么；不写完整 patch
- 严重度分组：CRITICAL (P0) / HIGH (P1) / MEDIUM (P2) / LOW (P3) / INFO (P4) / *未验证*

**强制约束**：
- 空泛 finding / 缺定位 / 缺片段 / 缺验证 / 缺修复方向 = 直接降 ❓ 或 ❌
- 复杂 finding 缺用户解释示例 = lead 降 ❓；CRITICAL/HIGH 复杂 finding 先让 reviewer 补 example，再进入反驳轮
- **任何 ✅ CRITICAL/HIGH 都必须落到 §三态裁决 两个验证条件之一**（双方独立 / 单方 + 现场验证）且必须有反驳论
- 弱断言关键词（"可能 / 也许 / 看起来 / 应该 / 大概"）**只允许**出现在标注 *未验证* 的条目里
- 未验证强制降级为 MEDIUM 或更低

reviewer body 已强约束本契约。lead spot-check：缺定位 / 缺代码片段 / 缺验证手段 / 缺修复方向任一项 → 降 ❓；纯文本推理无验证标 ✅ CRITICAL/HIGH → 强制降 ❓ 或走反驳轮。

## 失败兜底

| 场景 | 处理 |
|---|---|
| reviewer-codex 报失败模板（codex SDK 起不来 / OAuth 过期 / shell tool call cancel / sandbox 拒 / timeout / codex thread jsonl 缺失 fresh-session abort）| 通知用户决策。**合规兜底（仍异构）**：`shutdown_session` 掉失败的 reviewer-codex → `spawn_session({adapter:'codex-cli', agentName:'reviewer-codex', ...})` **重 spawn** 一个（retry ≤ 2 次 / 每次 ≤ 5min），与未动的 reviewer-claude teammate 仍构成 Codex adapter + Claude adapter 异构对。重 spawn 仍失败 → 提示用户三选一：①等 SDK/OAuth 恢复后再 spawn ②单方 reviewer-claude 出结论（finding 全降单方非 CRITICAL/HIGH，过 §三态裁决 §单方独有分流）③abort 本轮。**严禁**降级同源双 Claude；**严禁**让 reviewer-claude 冒充 reviewer-codex 补缺（同源化破坏异构）|
| reviewer-claude 报失败模板（claude SDK 起不来 / OAuth 过期 / sandbox 拒 / timeout / claude jsonl 缺失 fresh-session abort）| 通知用户决策。**合规兜底（仍异构）**：`shutdown_session` 掉失败的 reviewer-claude → `spawn_session({adapter:'claude-code', agentName:'reviewer-claude', ...})` **重 spawn** 一个（retry ≤ 2 次 / 每次 ≤ 5min），与未动的 reviewer-codex teammate 仍构成 Claude adapter + Codex adapter 异构对。重 spawn 仍失败 → 提示用户三选一：①等 SDK/OAuth 恢复后再 spawn ②单方 reviewer-codex 出结论（finding 全降单方非 CRITICAL/HIGH，过 §三态裁决 §单方独有分流）③abort 本轮。**严禁**降级同源双 Codex；**严禁**让 reviewer-codex 冒充 reviewer-claude 补缺（同源化破坏异构）|
| reviewer-* 报「⚠ FRESH SESSION — in-memory state empty」信号 | teammate 被 SDK 自动重启过，in-memory state 全丢。`shutdown_session` 该 teammate → 重 spawn → 按当前 scope 发 **Round 1 init prompt 全量重跑**（不要继续 Round N+1）|
| reviewer-* 报「⚠ SCOPE PATH MISMATCH」信号 | scope 路径前缀与 spawn cwd 不一致（典型：worktree 场景下 scope 写成主仓库根级形态 / SKILL §Sandbox 处理 auto cp 漏 cp 某文件）。修 scope 路径 / 检查 manifest → shutdown + 重 spawn + 重发 prompt |
| reviewer 持续不 reply（user 多次 ping 仍无 reply + lead nudge 后仍无 reply）| 仅在 user 下一轮询问状态或达到 30min 阈值时调 `get_session(reviewerSid).lastEventAt` 检查 reviewer 是否仍推进：是 → 告诉 user「reviewer 还在跑只是慢，再等等」；否 → reviewer 卡审批 / 卡死，提示真人去 PendingTab 处理或走上面合规兜底 |
| kind='mixed' 任一 reviewer fail | SKILL 不阻塞,其他 reviewer 仍跑;缺失方所属 mode finding 降级单方非 CRITICAL/HIGH(详 §kind='mixed' 成本与失败兜底 节 §fallback 优先级链 — lead 必按 ①retry → ②合规兜底 → ③降级单方 顺序处理,不要直接走 ③ 跳过 ① ②) |
| §Sandbox 处理 auto cp 失败（权限 / 磁盘满）| SKILL warn + abort, 告知 caller 手工 cp 后再 invoke |

> 其余 mcp tool error（no-shared-team / ambiguous-team / rate-limit / 投递 failed / 跨会话捡 stranded reviewer）走 mcp tool schema 自描述错误处理；高级救火场景见应用约定文件「Agent Deck Universal Team Backend」节。

## 与 simple-review SKILL 的关系

本 SKILL = **多轮**深度 review × fix × 反驳轮编排（teammate 模式，跨轮 context 持久化、反驳轮被反驳方有自身上轮推理链）。**单点 / 单次 review**（单点判定 / plan sanity / 技术选型 / 约定升级）走 `agent-deck:simple-review`（单次 full_review + 可选一轮 fix，更轻），同样 spawn reviewer 对 UI 可观测。两个 SKILL 都各自 inline §三态裁决 + §Finding 输出契约（各自 SSOT，不交叉引用应用 CLAUDE.md）。

**何时升 deep-review**：scope 跨多模块需挖 race / leak / 架构 / 安全 / 测试盲区 / 需 ≥ 2 轮 fix 收口 / kind='mixed' 双向交叉评审。simple-review 跑完发现水比预期深 → 升 deep-review 重跑（teammate 跨轮 mental model 不丢，直接发 Round 2 prompt）。
