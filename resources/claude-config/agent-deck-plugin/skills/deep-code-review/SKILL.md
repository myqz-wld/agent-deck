---
name: deep-code-review
description: 深度 code review — 多轮异构 reviewer 对抗 + 三态裁决，把代码变更里的浅层 bug 与深层隐患（race / leak / 边角条件 / 架构耦合 / 安全 / 测试盲区）一轮一轮挖到见底。**默认 Agent Teams 模式**：lead spawn 两个 teammate（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 wrapper），每轮 sendMessage 复用 teammate context，lead 自己做交叉裁决。环境不满足（CLI < v2.1.32 / agentTeamsEnabled OFF / 非 SDK 会话）回退 §Fallback Task subagent。触发：「深度 code review」/「deep code review」/「双对抗 review」/「review fix 多轮」/「/agent-deck:deep-code-review」/「再 review 一轮」。
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

## 步骤

### Step 1. 划范围

- branch diff: `git diff origin/main...HEAD --stat`
- 改动文件清单 + LOC: `git diff origin/main...HEAD --name-only`
- ≥ 6000 行 / ≥ 20 文件 → 拆批

### Step 2. 初轮 spawn

> **仅 Round 1**——后续轮次走 §Step 5。

lead 自然语言指令（in-process backend 自动起两个 SDK session 加进当前 team）：

```
请同时创建两个 teammate（异构对抗 reviewer，互不通信）：

teammate 1:
  name: reviewer-claude
  role: 引用 ${CLAUDE_PLUGIN_ROOT}/agents/reviewer-claude.md 全文作为 system prompt
  initial task: 全量 review，参数见下面 review prompt 块

teammate 2:
  name: reviewer-codex
  role: 引用 ${CLAUDE_PLUGIN_ROOT}/agents/reviewer-codex.md 全文作为 system prompt
  initial task: 全量 review，参数见下面 review prompt 块

review prompt 块（两个 teammate 收到的 prompt 一致）：
  scope: <要审的文件绝对路径清单 / diff range / 决策面描述>
  focus: <本轮重点维度，按 §多轮挖深 表填>
  skip:  <上一轮已修的 P1/P2 / 不必再列的项>
  repo_abs_path: <仓库绝对路径，给 reviewer-codex 用作 codex `-C` 参数>
  output_mode: full_review

请等两个 teammate 各自给出第一份 finding（hook event TeammateIdle 触发或 task_list 看到 status=completed）后再做交叉裁决，绝不在收齐前推断。
```

注意：
- 不在 review prompt 里写「异构 / 验证纪律 / 弱断言降级」——已固化在 reviewer agent body 里
- spawn 完不要主动催；等 idle / completed 事件
- lead 等待期间不要启动其他重活

### Step 3. 反驳轮（针对单方独有 HIGH）

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

### Step 4. Fix

按严重度排序 fix queue：HIGH → MED → LOW → INFO。每条 fix:

1. 改代码（精准最小修复，不顺手重构）
2. 加 / 调整测试（必须能在 fix 还原时挂掉）
3. 同步 typecheck / lint / test 全过
4. 单独 commit（message 含 round 标记便于单独 revert）

LOW/INFO 默认**只列不修**（除非用户明确要）。

### Step 5. 进下一轮（sendMessage 复用 teammate context）

**不要重新 spawn teammate**——sendMessage 给原两个：

```text
[Round N+1 / output_mode: full_review]

上轮已修（skip）: <fix commit hash + P-X 一句话>

新一轮 focus 切到 <下一个深度维度，见 §多轮挖深 表>。
scope 不变（如有微调，列出新增 / 移除文件）。

按 reviewer agent body §full_review 输出格式给本轮 finding。
```

核心 gain：teammate 已有 Round N 完整 context（已读文件 + mental model + 上轮 finding），不必重读、重 grep；新一轮只需换 focus + 看 fix patch。

收敛触发（任一）：双方「可合」+ 0 HIGH/MED / Round ≥ max_rounds / 用户 abort / 同一问题连续 2 轮没修掉。

### Step 6. 收口

汇总：总轮数、修复 issues 列表（按严重度）、反驳轮触发数（推到 ✅/❌/仍 ❓）、最终裁决（双方均「可合」/ 触顶 max_rounds）、commits hash 列表、未解决 LOW/INFO。

cleanup teammate：

```
请 cleanup 两个 teammate（reviewer-claude / reviewer-codex），dismiss / shutdown。
```

如果 cleanup 卡住（teammate `shutdown_approved` 后 config.members 不移除 → TeamDelete 拒绝），告诉用户在应用 TeamDetail 用「force-cleanup」按钮兜底。

## 关键约束

1. **不降级到同源双 Agent**：reviewer-codex 失败 → 通知用户决策（降级单方 / 等恢复 / abort），禁止偷偷只用 reviewer-claude 双跑
2. **不把 reviewer 当 fix agent**：reviewer 只读，lead 做 fix
3. **大 scope 拆批**：≤ 10 文件 / ≤ 30 行 prompt 一批，每批 `run_in_background: true` 多批并发
4. **每轮 commit atomic**：一个 fix 一个 commit
5. **测试能挂回归**：判定「如果还原 fix，测试会 FAIL」。空跑测试 = 重写
6. **Round N+1 sendMessage 必须填 skip**：避免 reviewer 重复 list 上轮 finding
7. **不重新 spawn teammate**：Round 2+ / 反驳轮都用 sendMessage 复用 Round 1 那对

## 常见反模式

| 反模式 | 后果 | 正确做法 |
|---|---|---|
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

## Fallback：subagent 模式（环境不满足时）

CLI < v2.1.32 / agentTeamsEnabled OFF / 非 SDK 会话 → 退到 Task subagent：

```
每轮 lead 在同一 message 里并发起两个 Task call：
  Task(subagent_type: "agent-deck:reviewer-claude", prompt: <scope+focus+skip 同 §Step 2>)
  Task(subagent_type: "agent-deck:reviewer-codex",  prompt: <同上>)
```

Trade-off：失去跨轮 context 持久化（每轮 fresh 重读文件）+ 反驳轮也是 cold start；换来零依赖 + 启动快 + 适合 ≤ 2 轮的轻量场景。裁决 / 反驳轮触发条件 / 收口判定**完全不变**，只是 spawn 机制退到 subagent。
