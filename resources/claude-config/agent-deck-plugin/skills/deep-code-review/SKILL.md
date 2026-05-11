---
name: deep-code-review
description: 深度 code review — 多轮异构 reviewer 对抗 + 三态裁决，把代码变更里的浅层 bug 与深层隐患（race / leak / 边角条件 / 架构耦合 / 安全 / 测试盲区）一轮一轮挖到见底。**默认 Agent Teams 模式**：lead 先 `TeamCreate` 建 team、再 spawn 两个 teammate（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 wrapper），每轮 sendMessage 复用 context；TeamCreate 必须先于 spawn，详见 §Step 2-3 红字护栏。环境不满足回退 §Fallback Task subagent。触发：「深度 code review」/「deep code review」/「双对抗 review」/「review fix 多轮」/「/agent-deck:deep-code-review」/「再 review 一轮」。
---

# Deep Code Review — 多轮异构对抗 review × fix 收口

把「review → fix → review → fix → ... 直到挖不出新问题」封装成可复用流程。重点是**多轮挖深**：第 1 轮抓浅层（typo / null / 错变量），第 2-3 轮挖深层（race / leak / 边角 / 架构 / 测试盲区 / 性能尾延迟）。

## 何时用

- 关键路径 / 核心抽象的代码变更（multi-client / 并发 / lifecycle / 资源管理）
- 跨多模块、影响主链路（≥ 200 行 / ≥ 5 文件）
- MR 提交前最后一道闸门
- **不适合**：trivial 改动（typo / 单点 rename / 显然措辞修订）— 一轮人审就够

## 核心设计

### 异构对抗

每轮**必须**两个 reviewer 同时起；初轮 spawn，**后续轮次复用同一对**（sendMessage 不重新 spawn）：

| Reviewer A | Reviewer B |
|---|---|
| `reviewer-claude` teammate（Opus 4.7 xhigh） | `reviewer-codex` teammate（claude-code wrapper，内部 Bash 跑外部 codex CLI gpt-5.5 xhigh） |

两个 teammate 完全独立（互不知道对方存在）。**lead 自己**做三态裁决，不让 teammate 既当 reviewer 又当裁判。

> **不要**两个 Claude 自己 review — 同源 = findings 重叠、盲区也重叠。`reviewer-codex` 失败时**严禁降级**到同源双 Claude（teammate body 内已有失败模板，lead 收到后通知用户决策）。

### 多轮挖深

| 轮次 | focus | 期待 finding |
|---|---|---|
| Round 1 | 修复正确性 / 是否引新问题 / 测试质量 | 浅层 bug、API 误用、明显 regression |
| Round 2 | 边界条件 / 并发 race / 资源 lifecycle | race window、cleanup 漏 path、状态机边角 |
| Round 3 | 架构耦合 / 安全 / 性能尾延迟 | 跨模块隐患、信任边界破坏、p95/p99 异常 |
| Round 4+ | 上轮残留 + 用户特别关注的领域 | 收口或拒合 |

### 三态裁决

- ✅ **真问题**：双方独立提出 / 一方提出且现场实践验证成立（写 test 复现 / grep 调用点 / 读真实代码）→ 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，记反驳依据
- ❓ **部分 / 未验证**：双方角度不同 / 一方提出但纯文本推理（含弱断言）尚未实践验证 → 综合后决定；未验证强制降级非 HIGH

每条**单方独有**：HIGH 候选 → §反驳轮；MED → lead 自己 grep / 读代码；LOW/INFO → 直接列 ❓。**不接受没验证的 ✅ HIGH**。

### 收口 / 拒合

**收口**（全部满足）：双 reviewer 都「可合」+ 0 个 HIGH/MED + 上轮真问题已 fix 通过测试。

**拒合**：Round ≥ `max_rounds`（默认 4）仍有 HIGH → 不强行 fix，报告。同一问题连续 2 轮没修掉 → escalate（拆 scope / 写 ADR / 寻求人审）。

### Milestone tracking（task list）

SendMessage 是**主体讨论通道**（teammate context 持久化、自由文本反驳）；task list 是**进度可见性通道**（TeamDetail「hook 事件流」section 时间线 + 复盘机器化）。两者互补：进 / 出每个 milestone 时调 `mcp__tasks__task_create` / `mcp__tasks__task_update`，中间讨论照旧 SendMessage。

**前置**：应用 SettingsDialog「实验功能」节的「SDK Task Manager」必须 ON（`enableTaskManager: true`，CHANGELOG_43 默认 OFF）。OFF 时 lead 拿不到 `mcp__tasks__*` 工具 —— 本节所有调用整段跳过，纯走 SendMessage（功能不残，只失去 TeamDetail 可见度 + 机器化复盘）。

**5 个 milestone + 调用模板**：

| Milestone | 时机 | 工具 + 关键参数 |
|---|---|---|
| Round N 起 | spawn / sendMessage 之前 | `task_create({subject: "Round N: <focus 一句话>", status: "active", priority: 7, labels: ["round-N"]})` → 记返回 id 为 `R_N` |
| Round N 收齐 | 双方都 idle 给完 finding，**裁决前** | `task_update({task_id: R_N, status: "completed", description: "<finding 数 / HIGH MED LOW 分布>"})` |
| 反驳轮起（每条 HIGH 一个） | sendMessage 反驳 prompt 之前 | `task_create({subject: "Rebuttal R_N · H<X>", status: "active", priority: 8, labels: ["rebuttal", "round-N"], blocked_by: [R_N]})` → 记为 `B_N_X` |
| 反驳轮裁决落锤 | 反驳回 + lead 推到 ✅/❌/❓ 之后 | `task_update({task_id: B_N_X, status: "completed" / "abandoned", description: "✅ 必修 <一句修复方向> / ❌ <反驳依据> / ❓ <降级原因>"})` |
| 整轮收口 | §Step 7 cleanup teammate 之前 | `task_list({status_filter: "active"})` 应返 0 条；若有遗留逐条 `task_update(status:"abandoned", description:"收口前 abort：<原因>")` |

**约束**：

- `task_create` 不传 `team_name`——closure 自动注入当前 team；强行传跨 team 直接被拒（写锁）
- `description` 一句话状态摘要，**finding 全文不要塞进去**（finding 全文走 SendMessage / lead 自己的裁决表）
- task 调用失败（OFF / 工具不存在 / 参数错）一律 swallow，不阻断主流程；裁决 / SendMessage / fix 该走还得走

## 步骤

### Step 1. 划范围

- branch diff: `git diff origin/main...HEAD --stat`
- 改动文件清单 + LOC: `git diff origin/main...HEAD --name-only`
- ≥ 6000 行 / ≥ 20 文件 → 拆批

### Step 2. 建 team（**前置基础设施，整轮 review 仅一次**）

> 与"Round N"概念正交——团队是整个 deep review 共享的基础设施，不是 Round 1 的子步骤。Round 2+ sendMessage 时复用同一个 team / 同一对 teammate，不会也不能再 `TeamCreate`。

调 `TeamCreate` 工具（CLI 内置，不是 mcp__）：

- `team_name`: 本轮 review 的唯一标识，建议 `deep-review-YYYY-MM-DD` 或 `<topic>-review`
- `description`: 一句话说明本轮 review 主题（给 TeamHub UI 看）

> ❗ **必做、必须在 §Step 3 spawn 之前完成 + 拿到成功返回**：Agent 工具的 `team_name` 字段是「指针」不是「声明」——必须指向一个**已通过 `TeamCreate` 注册成功的 team**。SDK 端不会因为 spawn 时带了 `team_name` 就自动给你建一个。跳过本步 / 与 §Step 3 spawn 塞同一 message 并发的后果：
> - 该 spawn 退化成纯 subagent 模式（reviewer-codex 内部 Bash 在 SDK 上游被默认 settings.json 权限策略 deny → reviewer 报 Bash 权限被拒收摊，详见 §Fallback 红字警告）
> - 应用 TeamHub UI 看不到 team / teammate（没有 fs SSOT 写入）
> - Round 2+ / 反驳轮 sendMessage 找不到 teammate（in-process backend 没有该 team 的 inbox 注册）
> - 现场会"看起来好像在跑"但 finding 全无，浪费一整轮

环境不满足（CLI 老版本 / agentTeamsEnabled OFF / 非 SDK 会话，`TeamCreate` 工具不存在）→ 直接退到 §Fallback；不要绕路用 `Agent(subagent_type=...)` 单参数起 reviewer（等同 Fallback subagent，reviewer-codex 内部 Bash 必挂）。

### Step 3. 初轮 spawn（Round 1 启动）

> **仅 Round 1 才 spawn**——Round 2+ 走 §Step 6 sendMessage 复用同一对 teammate；spawn teammate 这个动作本身**只在整轮 review 发生一次**，跟 `TeamCreate` 一样属于「一次性基础设施」。

同一 message 并发起两个 teammate，调 **两次 `Agent` 工具**（与 §Fallback 用的是同一个 Task tool，但参数列表不同），**必须四个字段齐全**：

```text
Agent 1:
  subagent_type: "agent-deck:reviewer-claude"
  name:          "reviewer-claude"               # 不传或重名 → 起不来
  team_name:     "<§Step 2 的 team_name>"        # ❗ 不传退化成纯 subagent
  prompt:        <见下面 review prompt 块>

Agent 2:
  subagent_type: "agent-deck:reviewer-codex"
  name:          "reviewer-codex"
  team_name:     "<同上>"                         # ❗ 不传退化成纯 subagent
  prompt:        <同 review prompt 块>
```

**❗ `team_name` / `name` 字段不能漏**：`Agent` 工具是 SDK 双模工具——带 `team_name + name` 走 in-process teammate（写 inbox → 触发 PendingTab → 用户审批 Bash）；不带退化成纯 subagent，reviewer 内部 Bash 在 SDK 上游就被默认 settings.json 权限策略 deny，**PendingTab 永远不会触发**。这不是 Agent Deck bug 是 SDK 设计，不要怀疑应用通路。

review prompt 块（两个 teammate 收到的 prompt 一致）：

```
scope:         <要审的文件绝对路径清单 / diff range / 决策面描述>
focus:         <本轮重点维度，按 §多轮挖深 表填>
skip:          <上一轮已修的 P1/P2 / 不必再列的项>
repo_abs_path: <仓库绝对路径，给 reviewer-codex 用作 codex `-C` 参数>
output_mode:   full_review
```

注意：
- 不在 review prompt 里写「异构 / 验证纪律 / 弱断言降级」——已固化在 reviewer agent body 里
- spawn 完不要主动催；等 idle / completed 事件（hook event TeammateIdle 或 task_list status=completed）
- lead 等待期间不要启动其他重活
- spawn **之前**调一次 `mcp__tasks__task_create` 建 `R_1`（与 §Milestone tracking 表第 1 行「Round N 起」一致；可与两次 Agent 调用同 message 并发，但语义上必须先于 spawn 进入 active 状态）

### Step 4. 反驳轮（针对单方独有 HIGH）

对**单方独有 + HIGH** 候选，lead 用 sendMessage 给**对方** teammate（保持异构 + 复用 R_N context）：

- reviewer-claude 提的 → sendMessage **reviewer-codex**
- reviewer-codex 提的 → sendMessage **reviewer-claude**

```text
[反驳轮 / output_mode: rebuttal]

以下是 reviewer-<对方> 在 Round N 提出的 finding，请独立判断（不要做泛 review）：
<完整内容：严重度 / 文件:行号 / 描述 / 验证手段>

任务（按 reviewer agent body §rebuttal 输出格式）：
1. 同意 / 反对 / 不确定？给立场
2. 反对：给反驳证据（grep / 写小 test / 跑命令证伪）
3. 同意：补充关键细节
4. 不确定：明说哪部分验不了 + 为什么

严禁借机提其他 finding；只回应这一条。
```

反驳后 lead 推到：反驳成立 → ❌ 不修；反驳失败 → ✅ HIGH 必修；仍模糊 → lead 自己 Grep/Read/Bash 现场验证 → 还不行降 ❓ + 非 HIGH。

约束：同一条 finding 只反驳一次；**不要 spawn 新 teammate 反驳**——必须复用 Round 1 那对。

**task 节奏**：sendMessage 反驳 prompt 之前 `task_create` 建 `B_N_X`（参 §Milestone tracking 表第 3 行）；裁决落锤后 `task_update(B_N_X, status: "completed" / "abandoned", description: "<裁决理由>")`（表第 4 行）。

### Step 5. Fix

按严重度排序 fix queue：HIGH → MED → LOW → INFO。每条 fix:

1. 改代码（精准最小修复，不顺手重构）
2. 加 / 调整测试（必须能在 fix 还原时挂掉）
3. 同步 typecheck / lint / test 全过
4. 单独 commit（message 含 round 标记便于单独 revert）

LOW/INFO 默认**只列不修**（除非用户明确要）。

### Step 6. 进下一轮（sendMessage 复用 teammate context）

**不要重新 spawn teammate**——sendMessage 给原两个：

```text
[Round N+1 / output_mode: full_review]

上轮已修（skip）: <fix commit hash + P-X 一句话>

新一轮 focus 切到 <下一个深度维度，见 §多轮挖深 表>。
scope 不变（如有微调，列出新增 / 移除文件）。

按 reviewer agent body §full_review 输出格式给本轮 finding。
```

核心 gain：teammate 已有 Round N 完整 context（已读文件 + mental model + 上轮 finding），不必重读、重 grep；新一轮只需换 focus + 看 fix patch。

**task 节奏**：sendMessage 之前 `task_create` 建 `R_(N+1)`（参 §Milestone tracking 表第 1 行；`blocked_by: [R_N]` 记 round 依赖）；收齐 finding 后 `task_update(R_(N+1), status: "completed")`（表第 2 行）。

收敛触发（任一）：双方「可合」+ 0 HIGH/MED / Round ≥ max_rounds / 用户 abort / 同一问题连续 2 轮没修掉。

### Step 7. 收口

汇总：总轮数、修复 issues 列表（按严重度）、反驳轮触发数（推到 ✅/❌/仍 ❓）、最终裁决（双方均「可合」/ 触顶 max_rounds）、commits hash 列表、未解决 LOW/INFO。

**task list 收口校验**（cleanup 之前）：`task_list({status_filter: "active"})` 应返 0 条；若有遗留逐条 `task_update(status: "abandoned", description: "收口前 abort：<原因>")`。汇总段贴一次 `task_list({})` 全量结果作为机器化复盘起点（REVIEW_X.md 时间线可直接由此导出）。

**cleanup teammate**：lead **必须**调 `SendMessage` 工具 originate `shutdown_request`（结构化 message），**每个 teammate 各调一次**。同一 message 里两次 SendMessage 并发：

```text
SendMessage(
  to: "reviewer-claude",        # ❗ 是 teammate 名，不是 "team-lead"
  message: {
    type:   "shutdown_request",
    reason: "deep review 收口"   # 简短理由，会显示在 teammate 退出消息里
  }
)
SendMessage(
  to: "reviewer-codex",         # 同上，第二个 teammate
  message: {
    type:   "shutdown_request",
    reason: "deep review 收口"
  }
)
```

**❗ lead 严禁自己发 `shutdown_response` —— 自杀**：CLI v2.x 端 `SendMessage.validateInput` 强校验 `shutdown_response` 的 `to === "team-lead"`（CLI 协议设计：response 仅 teammate → lead，approve 触发**响应方**自身的 abortController）。lead 如果误把 `shutdown_response` 发到 `"team-lead"`（自己），SDK 端 `kJY` 拿到当前 caller 的 abortController 就是 lead 自己的 → **lead 自我 abort，sdk-stream-ended 整个 review 现场死亡**。lead 唯一姿势是 originate `shutdown_request`（上面模板），teammate 那边 SDK 自动走 response 自终止，**lead 完全不需要参与 response 环节**。

发完两次 shutdown_request 后等 5-30s（in-process backend 异步 cleanup）：
- lead inbox 收到两个 `shutdown_approved` 通知（CLI 自动转 `Ei1` 事件）
- TeamDetail UI 上 teammate 状态走 `[stopping]` → 消失

之后调 `TeamDelete` 工具（CLI 内置，团队整体清理）：
- 首次调用经常报 `Cannot cleanup with N active member(s)`——CLI in-process backend cleanup 是异步的，`config.members` 移除有延迟（实测可达几分钟）
- 等几分钟重试通常成功；如真卡死告诉用户在应用 TeamDetail 用「force-cleanup」按钮兜底（`rm -rf ~/.claude/teams/<name>` + `~/.claude/tasks/<name>`）

## 关键约束

1. **不降级到同源双 Agent**：reviewer-codex 失败 → 通知用户决策（降级单方 / 等恢复 / abort），禁止偷偷只用 reviewer-claude 双跑
2. **不把 reviewer 当 fix agent**：reviewer 只读，lead 做 fix
3. **大 scope 拆批**：≤ 10 文件 / ≤ 30 行 prompt 一批，每批 `run_in_background: true` 多批并发
4. **每轮 commit atomic**：一个 fix 一个 commit
5. **测试能挂回归**：判定「如果还原 fix，测试会 FAIL」。空跑测试 = 重写
6. **Round N+1 sendMessage 必须填 skip**：避免 reviewer 重复 list 上轮 finding
7. **不重新 spawn teammate**：Round 2+ / 反驳轮都用 sendMessage 复用 Round 1 那对
8. **task list 是进度通道，不是裁决通道**：description 一句话状态摘要，finding 全文走 SendMessage / lead 自己的裁决表；前置 `enableTaskManager: true` OFF 时整段 task_* 跳过，不阻断 review 主流程

## 常见反模式

| 反模式 | 后果 | 正确做法 |
|---|---|---|
| spawn teammate 时未先 `TeamCreate` 成功（含跳过 §Step 2 / 与 spawn 塞同 message 并发）| 详见 §Step 2 红字段 4 个后果 | 先 §Step 2 `TeamCreate` 单独 tool call 拿到成功返回，下一条 message 再 §Step 3 起两个 `Agent` |
| Round 2+ 重新 spawn / 反驳轮 spawn 新 teammate | 失去 context 持久化 gain | sendMessage 复用同一对 |
| spawn 完没等 idle / completed 就裁决 | 拿到不完整 finding | 必须等两个都给出第一份 |
| 把双方 raw 全文塞 lead context | context 爆炸 | reviewer 输出已是紧凑 markdown，lead 复述只列裁决表 |
| LOW / INFO 也修 | PR 失焦 | 只列不修 |
| 没 commit 直接进下一轮 | 无法追溯 / revert | 每个 fix 独立 commit |
| Round 1 就喊「可合」 | 缺深度证据 | 至少 2-3 轮，每轮 focus 不同维度 |
| 每轮 sendMessage focus 一字不差 | reviewer 反复列同样 finding | 切换 focus + 填 skip |
| reviewer-codex 失败后自己 review 一遍 | 破坏异构 | 必须报错让用户决策 |
| 反驳轮 prompt 没禁「借机提其他 finding」 | 反驳轮变第二轮 review | 反驳 prompt 必含「严禁借机提其他 finding」 |
| 单方独有 LOW 也走反驳轮 | 反驳成本远超价值 | 反驳轮只针对 HIGH 候选 |
| Round / 反驳轮起前没 task_create | TeamDetail hook 事件流空白 / 复盘没机器化时间线 | 参 §Milestone tracking 表，每个 milestone 进出各调一次 task_* |
| task description 抄 finding 全文 | task list 变第二份 review 报告 / 写入超 2000 字限制被截 | description 一句话状态摘要；finding 全文走 SendMessage |
| Step 7 cleanup 时 lead 发 `shutdown_response`（不论 `to` 是 teammate 还是 "team-lead"）| `to: <teammate>` 被 SendMessage validateInput 直接拒（强校验 `to === "team-lead"`）；改投 `to: "team-lead"` 触发 SDK `kJY` 把 lead 自己的 abortController abort → **lead 自杀 sdk-stream-ended** | lead 只 originate `shutdown_request` 给 teammate；teammate 收到后 SDK 自动走 response 自终止，lead 完全不参与 response |
| Step 7 用「请 cleanup teammates」自然语言代替结构化 SendMessage | teammate 行为不可控（可能反向 originate shutdown_request 求许可，把 lead 推进上一行的自杀路径）| Step 7 必须发结构化 `{type: "shutdown_request", reason: ...}` |

## Fallback：subagent 模式（环境不满足时）

> ❗ **必读**：仅在 `TeamCreate` 工具确实不可用时才走 §Fallback（典型：CLI 老版本启不来 / `agentTeamsEnabled` 设置 OFF / 非 SDK 会话）。**日常 review 默认必走 §Step 2** —— Fallback subagent 模式下 reviewer-codex 内部 Bash 会在 SDK 上游被默认 settings.json 权限策略 deny，**PendingTab 不会触发**，用户看不到审批，reviewer 只看到「Bash 权限被拒」假象就报错收摊。这是 SDK 双模 `Agent` 工具的设计（不带 `team_name + name` = 纯 subagent 通路），不是 Agent Deck 应用 bug。**先试 §Step 2 走 teammate 通路；确实拿不到 `TeamCreate` 才退 §Fallback**。

CLI < v2.1.32 / agentTeamsEnabled OFF / 非 SDK 会话 → 退到 Task subagent：

```
每轮 lead 在同一 message 里并发起两个 Task call：
  Task(subagent_type: "agent-deck:reviewer-claude", prompt: <scope+focus+skip 同 §Step 3>)
  Task(subagent_type: "agent-deck:reviewer-codex",  prompt: <同上>)
```

Trade-off：失去跨轮 context 持久化（每轮 fresh 重读文件）+ 反驳轮也是 cold start；换来零依赖 + 启动快 + 适合 ≤ 2 轮的轻量场景。裁决 / 反驳轮触发条件 / 收口判定**完全不变**，只是 spawn 机制退到 subagent。
