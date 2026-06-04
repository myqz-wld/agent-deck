---
name: simple-review
description: 轻量异构对抗 review — spawn 一对 reviewer-claude + reviewer-codex 单次 full_review + 三态裁决 + 五级严重度(CRITICAL/HIGH/MEDIUM/LOW/INFO)。CRITICAL/HIGH 必须反驳论,无 CRITICAL/HIGH 才允许合入。前提:会话已挂载 agent-deck-mcp。触发:「review 一下」/「简单 review」/「轻量 review」/「决策评审」/「对抗一下」/「帮我 review」/「这个对不对」/「下结论前对抗」/「约定升级评审」。
---

# Simple Review — 单次异构对抗 × 可选一轮 fix（code / plan）

下结论 / 出 plan / 升级约定前的**单次**对抗评审。spawn 一对异构 reviewer（reviewer-claude + reviewer-codex）各跑一遍 full_review，lead 收两份独立结论做三态裁决与五级严重度归档；CRITICAL/HIGH 必须有反驳论，且无 CRITICAL/HIGH 才允许合入。**比 deep-review 轻**：不强制多轮挖深，单次为主。reviewer 走 SDK in-process teammate，**UI 实时可见**进度与 reply。

> **前提**：会话已挂载 agent-deck-mcp（应用 Settings → Agent Deck MCP server 已启用）。本 SKILL 走 `mcp__agent-deck__*` tool 编排；Backend 协议（spawn / send_message / dispatch / wire format / shutdown 语义）SSOT 在应用约定文件 `CLAUDE.md`「Agent Deck Universal Team Backend」节。MCP 关时本 SKILL 不可用 → 降级人审。

## 何时用

- **单点判定**：某段代码 bug / 优化 / 安全 / 根因 的定性判断
- **plan sanity**：plan / RFC 写完快速过一遍设计大方向（不是逐 step 行级深挖 — 那走 deep-review kind='plan'）
- **重要技术选型 / 重构方向决策**：下结论前要异构对抗一次
- **约定升级评审**：`ref/conventions/tally.md` 候选 count=3 升级提案的三态裁决 gate
- **不适合**：
  - trivial 改动（typo / 样式数值 / 单点 rename / 显然措辞修订）→ 一轮人审就够，不必起 reviewer
  - scope 跨多模块需挖 race / leak / 架构 / 安全 / 测试盲区 / 需 ≥ 2 轮 fix 收口 / kind='mixed' → 走 `agent-deck:deep-review`（多轮挖深）

## Scope schema (typed args)

caller invoke SKILL 时显式传 typed scope，**不依赖 path 后缀启发**：

```ts
{
  kind: 'code' | 'plan',       // 无 mixed（mixed 双向交叉评审是 deep-review 的域）
  paths: string[],             // 文件清单(绝对路径)
  ack_cache_unignored?: boolean   // optional;批处理 / 自动调度场景显式 ack 跳过 .gitignore 自检(详 §Sandbox 处理 step 6)。default false
}
```

**caller 责任**：
- `kind` 必须显式传（不要让 SKILL 猜）
- `paths` 全绝对路径（与 spawn cwd 同前缀，worktree 内必须含 `.claude/worktrees/<plan-id>/` 前缀；**例外**：§Sandbox 处理 自动 cp 路径除外详下节）
- caller 自己拆批（单批 ≤ 10 文件 / ≤ 30 行 prompt）；超出按主题拆多次 invoke

## ⚠️ Sandbox 处理（auto cp + manifest）

**问题**：scope 路径含 worktree 外文件（如 user 家目录配置文件 / 其他 repo / 系统路径）→ reviewer 受 sandbox 限制读不到（详 reviewer-{claude,codex} body §Sandbox 限制说明 节）。

**reviewRoot 定义**：`reviewRoot` = SKILL spawn 时 caller 传入的 cwd 参数（绝对路径，可为 repo root / worktree root；SKILL 不强制处于 worktree）。cache 一律落在 `<reviewRoot>/.deep-review-cache/<invocationId>/`（与 deep-review 共用同款 cache 目录约定 + `.gitignore` entry）。

**SKILL 自动 cp 落地**（caller invoke SKILL 时本节第一步执行）——把 reviewRoot 外的文件 cp 到 reviewRoot 内 cache 目录让 reviewer SDK sandbox 能读，review 完自动清，每次调用建独立子目录避免并发互踩：

1. **生成 invocation-id**：`<invocationId> = sha256(timestamp+random)[0:8]` 标识本次 SKILL 调用。每次 invoke 都生成新 id，即使同一 scope 调多次也不冲突
2. **建 cache 子目录**：`<reviewRoot>/.deep-review-cache/<invocationId>/`（每次 invocation 独立子目录，**避免并发 review 同 scope 互踩**）
3. **检查 scope.paths 每个路径**：路径前缀含 `<reviewRoot>/` → 直接传给 reviewer；不含 → 走 cp 流程
4. **cp 外部文件进 reviewRoot cache**：
   - cache file 命名：`<reviewRoot>/.deep-review-cache/<invocationId>/<fileSha8>-<sanitized-basename>.md`（`<fileSha8>` = sha256(原 abspath)[0:8] 防同名 basename 冲突；`<sanitized-basename>` = 原 basename 去除 `[^A-Za-z0-9._-]` 字符；**注**：`<invocationId>` 与 `<fileSha8>` 是两个不同维度的 sha8 separate placeholder 不复用）
   - Bash `cp <orig-abspath> <cache-path>`
   - 路径表替换：reviewer 收到的 scope 用 cache 路径替代原 abspath
5. **生成 manifest**：`<reviewRoot>/.deep-review-cache/<invocationId>/manifest.json`（放 invocation 子目录内，与 cache files 同级）
   ```json
   {
     "invocationId": "<invocationId>",
     "createdAt": "<ISO>",
     "files": [
       { "origAbspath": "/Users/.../ref/plans/foo.md", "cachePath": "<reviewRoot>/.deep-review-cache/<invocationId>/<fileSha8>-foo.md" }
     ]
   }
   ```
6. **SKILL 启动 step 0 双自检**：
   - **sweep 旧 orphan**：扫 `<reviewRoot>/.deep-review-cache/*/manifest.json`，`createdAt` 距今 > 24h 的 invocation 子目录全删 `rm -rf <invocation-id>/`（中断的 SKILL 留下 orphan 不会无限累积）
   - **`.gitignore` 自检**：`Bash: grep -q '^\.deep-review-cache/' <reviewRoot>/.gitignore` 失败 → warn caller「`.gitignore` 缺 `.deep-review-cache/` entry，cache 文件可能被 commit；请加 entry 或接受风险继续」继续不 abort。**批处理 / 自动调度场景**（caller 看不到 warn 输出）：caller 必须 invoke 时显式传 `ack_cache_unignored: true` 跳过自检 + 接受 cache untracked 风险；否则 SKILL warn + abort 让 caller explicit consent
7. **review 完后 cleanup**：`rm -rf <reviewRoot>/.deep-review-cache/<invocationId>/` 整个子目录干掉（子目录粒度删，不影响别 invocation）。包 try/finally 即使 cleanup 中失败也尝试 rm 一遍

**caller 看到**：scope 路径透明（仍传原 abspath），SKILL 内部路径替换后 reviewer 拿到 cache 路径。

**失败兜底**：cp 撞权限 / 磁盘满 → SKILL warn + abort，告知 caller 手工 cp 后再 invoke。

## 异构对抗

spawn 一对 reviewer（**单次起，不强制多轮复用** — 单轮跑完即可 shutdown；若进 Round 2 fix 则复用同对）：

| Reviewer A | Reviewer B |
|---|---|
| `reviewer-claude` teammate（claude-code adapter，Opus 4.7 default thinking） | `reviewer-codex` teammate（**codex-cli adapter，native codex SDK in-process**，gpt-5.5 xhigh） |

两个 teammate 完全独立（互不知道对方存在）。**lead 自己**做三态裁决，不让 teammate 既当 reviewer 又当裁判。

> **跨 adapter 直起**：lead 调 `spawn_session({adapter:'codex-cli', agentName:'reviewer-codex', ...})` 直接起 codex SDK 子进程承载 reviewer-codex agent body。lead adapter 任意（claude-code 或 codex-cli）— SKILL 编排始终生成 native reviewer-claude（claude-code adapter）+ native reviewer-codex（codex-cli adapter）一对，物理保证异构。**严禁**降级同源双 reviewer（双 Claude / 双 Codex 破坏异构对抗根基）。

## 执行模板（单次 full_review + 可选一轮 fix）

| Step | 动作 | 关键字段 / 等什么 |
|---|---|---|
| 0 | 准备 `cwd`（仓库 / worktree 绝对路径）+ `scope: {kind, paths}`；走 §Sandbox 处理 auto cp 把 worktree 外路径 cp 进 cache | caller 显式传 kind |
| 1 | 并发 spawn 两 reviewer：`spawn_session({adapter, cwd, prompt, teamName, agentName, displayName})` × 2，**adapter 各异**（reviewer-claude → `adapter:'claude-code'` + `agentName:'reviewer-claude'`；reviewer-codex → `adapter:'codex-cli'` + `agentName:'reviewer-codex'`），body 自动注入 prompt 头；prompt 按 kind 选 §Prompt 模板 | 各拿 `spawnPromptMessageId` 当首轮 reply chain 锚点；两 spawn 之间不等 reply |
| 2 | **告诉 user**「已派 2 个 reviewer 跑 review，UI 实时显示进度，reply 来了我会自动收到处理；期间你可随时插话」**然后等 reply 自动注入**。reviewer 跑完调 `send_message + replyToMessageId` → reply 自动注入 lead conversation。**lead 不主动 poll** | 两份独立 finding 自动到达 |
| 3 | 三态裁决（§三态裁决）：双方一致 → ✅；任一 CRITICAL/HIGH → Step 4 反驳轮；单方独有 MEDIUM → lead 自己 Grep/Read 验证；LOW/INFO → 直接列 ❓ | — |
| 4 | 反驳轮（所有 CRITICAL/HIGH，**只一次**）：`send_message({sessionId: B-sid, teamId, text: '<A 的 finding 全文> 请独立反驳，禁止借机提其他 finding', replyToMessageId: <Round 1 messageId>})` → 等 B 反驳 reply 自动注入 | 同一条 finding 必须记录支持论与反驳论；反驳后仍不能定 → lead 自己验证；还不行 → 降为 MEDIUM 或更低 |
| 5 | **可选**一轮 fix：有 CRITICAL/HIGH 真问题 → lead fix；MEDIUM 由 lead 明确「本轮修 / 接受风险 / 记 follow-up」→ **复用同对** teammate 调 `send_message` 发 Round 2 prompt（带 `skip` = 上轮 ✅ fix 摘要 `已修：<filepath:line> <一句话改动> (commit <hash>)`）→ 等 reply → 回 Step 3。**收口**判定满足（0 CRITICAL/HIGH + 双方可合）即进 Step 6，**不强制多轮**；若仍 ≥ 1 CRITICAL/HIGH 或双方又抓 ≥ 5 条新真问题 → 升 `agent-deck:deep-review` 接管多轮挖深 | fix loop 期间**绝不 shutdown**（复用同对 teammate 保 mental model） |
| 6 | 收尾：`shutdown_session` × 2 + cleanup auto-cp cache（按 manifest 精确 rm，try/finally） | shutdown 不删 events / messages，lead 仍可在裁决报告引用 |

> **lead 自然推进**：reply 走 adapter dispatch 自动注入 receiver SDK conversation flow → reviewer reply 一到 lead 自动收到一条 user-role message → 当普通 user input 处理 → 自然完成裁决。

**收口判定**：双 reviewer 都「可合」+ 0 CRITICAL/HIGH。MEDIUM 必须有 lead 处置记录；LOW/INFO 留 follow-up。单方收口不算（漏审风险）。

## 三态裁决

每条 finding 三态裁定：
- ✅ **真问题**（CRITICAL/HIGH 必须满足 ≥1 个验证条件）：「**双方独立提出**」（异构强冗余即算验证）**或**「**一方提出且现场实践验证成立**」（grep 出 N 处证据 / 写小 test 复现挂掉 / 跑命令确认）→ CRITICAL/HIGH 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，记反驳依据
- ❓ **部分 / 未验证**：双方角度不同 / 一方提出但纯文本推理（含弱断言）尚未实践验证 → 综合后决定，强制降到 MEDIUM 或更低

**CRITICAL/HIGH 反驳论**：任一 CRITICAL/HIGH finding 都必须走 §执行模板 Step 4。单方提出时让另一 reviewer 反驳；双方独立提出时仍让至少一方针对「是否真达 CRITICAL/HIGH」写反驳论。最终裁决必须同时记录支持论、反驳论、lead 判定。

**单方独有分流**：CRITICAL/HIGH → §执行模板 Step 4 反驳轮；MEDIUM → lead 自己 Grep / Read 验证（≤ 5min / ≤ 5 grep / ≤ 1 test，超就保留 ❓ 并降到 LOW/INFO）；LOW/INFO → 直接列 ❓。双方都说没问题 → ✅ 可合。

## 五级严重度（P0-P4）

严重度只按真实影响和触发概率定级；证据不足时降级，不用高等级表达不确定性。

| 等级 | 评定细则 | 合入门槛 |
|---|---|---|
| CRITICAL (P0) | 可稳定触发数据丢失 / 权限绕过 / secret 泄露 / 任意代码执行 / 跨 session 严重串线 / 主链路全局不可用，且没有可靠规避路径 | 必须修复或证伪；必须有反驳论；存在时禁止合入 |
| HIGH (P1) | 支持路径上可复现的崩溃、死锁、状态损坏、安全边界破坏、用户工作丢失、核心功能错误结果，或设置 / 迁移 / 协议改动导致一类用户稳定回归 | 必须修复或证伪；必须有反驳论；存在时禁止合入 |
| MEDIUM (P2) | 真实缺陷但有明确规避路径、触发范围有限、影响非核心路径；或高风险改动缺关键回归测试；或文档 / prompt 误导会让 agent 做错但不会直接破坏安全边界 | lead 必须记录本轮修、接受风险或 follow-up；不单独阻止合入 |
| LOW (P3) | 小范围边界问题、轻微 UX / 文案 / 注释 drift、可读性或维护性改进，触发概率低且影响可逆 | 记录即可，不阻止合入 |
| INFO (P4) | 背景观察、验证覆盖说明、非行动项 caveat、改进想法、已确认无问题的风险点 | 仅供裁决上下文 |

## Finding 输出契约（lead spot-check 用）

每条 finding 必须带：
- `文件:行号` + 代码 / 原文片段（≤ 6 行）
- **验证手段**（如 "grep 出 3 处全无 null check" / "写 stateful mock 模拟双 disconnect 实测 abort 0 次"）
- 严重度分组：CRITICAL (P0) / HIGH (P1) / MEDIUM (P2) / LOW (P3) / INFO (P4) / *未验证*

**强制约束**：
- 空泛 finding + 没验证 = 直接降 ❓ 或 ❌
- **任何 ✅ CRITICAL/HIGH 都必须落到 §三态裁决 两个验证条件之一**（双方独立 / 单方 + 现场验证）且必须有反驳论
- 弱断言关键词（"可能 / 也许 / 看起来 / 应该 / 大概"）**只允许**出现在标注 *未验证* 的条目里
- 未验证强制降级为 MEDIUM 或更低

reviewer body 已强约束本契约。lead spot-check：缺定位 / 缺代码片段 / 缺验证手段任一项 → 降 ❓；纯文本推理无验证标 ✅ CRITICAL/HIGH → 强制降 ❓ 或走反驳轮。

## Prompt 模板（按 kind 分流）

每次 spawn 或 send_message 的 prompt 必带：
- `output_mode: full_review` 或 `rebuttal`
- `scope`：文件清单（**绝对路径**，与 spawn cwd 同前缀；worktree 外路径已被 §Sandbox 处理 auto cp 替换为 cache 内路径）
- `focus`：本轮重点维度
- `skip`：上轮 ✅ fix 摘要 / 已审过的稳定项（仅 Round 2 fix 轮）

### kind='code' 模板（focus 维度）

```
focus:
- 修复正确性 / 是否引新问题
- 边界条件 / 并发 race / 资源 lifecycle（按 scope 取最相关 1-2 项，不必穷举）
- 测试覆盖度（关键 fix 是否有回归 test）
```

### kind='plan' 模板（focus 维度）

```
focus:
- plan §设计决策 是否清晰 / 不变量定义边界明确
- 流程一致性（RFC 决策 / spike 实证 inline 进 §设计决策）
- §下一会话第一步 是否完整可执行（cold start prompt 含绝对路径）
```

## 失败兜底

| 场景 | 处理 |
|---|---|
| reviewer-codex 失败（codex SDK 起不来 / OAuth 过期 / shell tool call cancel / sandbox 拒 / timeout / codex thread jsonl 缺失 fresh-session abort）| 通知用户决策。**合规兜底（仍异构）**：`shutdown_session` 掉失败的 reviewer-codex → `spawn_session({adapter:'codex-cli', agentName:'reviewer-codex', ...})` **重 spawn**（retry ≤ 2 次 / 每次 ≤ 5min），与未动的 reviewer-claude teammate 仍异构。重 spawn 仍失败 → 提示用户三选一：①等 SDK/OAuth 恢复后再 spawn ②单方 reviewer-claude 出结论（finding 全降单方非 CRITICAL/HIGH，过 §三态裁决 §单方独有分流）③abort。**严禁**降级同源双 Claude；**严禁**让 reviewer-claude teammate 跑「codex 视角」补缺 |
| reviewer-claude 失败（claude SDK 起不来 / OAuth 过期 / sandbox 拒 / timeout / claude jsonl 缺失 fresh-session abort）| 对称处理：`shutdown_session` + `spawn_session({adapter:'claude-code', agentName:'reviewer-claude', ...})` 重 spawn，与 reviewer-codex teammate 仍异构。仍失败 → 三选一（等恢复 / 单方 reviewer-codex 出结论降单方非 CRITICAL/HIGH / abort）。**严禁**降级同源双 Codex |
| reviewer-* 报「⚠ FRESH SESSION — in-memory state empty」信号 | teammate 被 SDK 自动重启过 in-memory state 全丢。`shutdown_session` → 重 spawn → 按 scope 重发 init prompt 全量重跑（不要继续 Round 2） |
| reviewer-* 报「⚠ SCOPE PATH MISMATCH」信号 | scope 路径前缀与 spawn cwd 不一致（worktree 场景 scope 写成主仓库根级形态 / auto cp 漏 cp 某文件）。修 scope 路径 / 检查 manifest → shutdown + 重 spawn + 重发 prompt |
| reviewer 持续不 reply（≥ 30min 无 reply + nudge 后仍无）| `get_session(reviewerSid).lastEventAt` 检查：recent → 还在跑只是慢，告诉 user 再等等；非 recent → 卡死，提示真人去 PendingTab 或 shutdown 重 spawn |
| §Sandbox 处理 auto cp 失败（权限 / 磁盘满）| SKILL warn + abort，告知 caller 手工 cp 后再 invoke |

> 其余 mcp tool error（no-shared-team / ambiguous-team / rate-limit / 投递 failed）走 mcp tool schema 自描述错误处理；高级救火场景见应用约定文件「Agent Deck Universal Team Backend」节。

## 与 deep-review SKILL 的关系

本 SKILL = **单次** review + 可选一轮 fix（轻量异构对抗）；`agent-deck:deep-review` = **多轮**挖深 review × fix × 反驳轮（teammate 跨轮持久化）。两个 SKILL 都各自 inline §三态裁决 + §Finding 输出契约（各自 SSOT，不交叉引用应用 CLAUDE.md）。本 SKILL 跑完发现水比预期深（≥ 1 CRITICAL/HIGH 反复 / 跨多模块）→ 升 deep-review 接管。
