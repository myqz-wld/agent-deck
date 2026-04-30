---
name: deep-code-review
description: 深度 code review 工具 — 多轮异构 reviewer 对抗 + 三态裁决，把代码变更里的浅层 bug 与深层隐患（race / leak / 边角条件 / 架构耦合 / 安全 / 测试盲区）一轮轮挖到见底。**默认 Agent Teams 模式**：lead spawn 两个 teammate（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 wrapper），每轮 sendMessage 复用 teammate context（多轮 / 反驳轮的 token 与精准度都靠这个），lead 收两份独立结论后做交叉裁决。环境不满足（CLI < v2.1.32 / agentTeamsEnabled OFF / 非 SDK 会话）回退 §Fallback Task subagent 模式。触发：用户说「深度 code review」/「deep code review」/「code review 收口」/「双对抗 review」/「review-fix 多轮」/「/agent-deck:deep-code-review」/「再 review 一轮」。
---

# Deep Code Review — 多轮异构对抗 review × fix 收口

把「review → fix → review → fix → ... 直到挖不出新问题」封装成可复用流程。重点是**多轮挖深**：第 1 轮抓浅层（typo / null / 错变量），第 2-3 轮挖深层（race / leak / 边角 / 架构 / 测试盲区 / 性能尾延迟）。

## 何时用

- 关键路径 / 核心抽象的代码变更（multi-client / 并发 / lifecycle / 资源管理）
- 跨多模块、影响主链路（≥ 200 行 / ≥ 5 文件）
- MR 提交前最后一道闸门
- 历史 bug 反复犯的模块
- **不适合**：trivial 改动（typo / 单点 rename / 显然措辞修订）— 一轮人审就够

## 触发

- 显式：`/agent-deck:deep-code-review`、"deep code review"
- 关键词：「深度 code review」「深 review」「双对抗 code review」「review fix 多轮」「review 收口」「Wave N 收口」「加固直到合格」「review 直到挖不出问题」
- 「再 review 一轮」/「continue deep-code-review」→ 续接（看 §Step 0）

## 核心设计

### 异构对抗 + 跨轮 context 持久化

每轮**必须**两个 reviewer 同时起；初轮 spawn，**后续轮次复用同一对**（sendMessage 不重新 spawn）：

| Reviewer A | Reviewer B |
|---|---|
| `reviewer-claude` teammate（Opus 4.7 xhigh） | `reviewer-codex` teammate（claude-code wrapper，内部 Bash 跑外部 codex CLI gpt-5.5 xhigh） |

两个 teammate 完全独立（互不知道对方存在），各自回结论给 lead。**lead 自己**做三态裁决——不让 teammate 既当 reviewer 又当裁判。

> **不要**两个 Claude 自己 review — 同源 = findings 重叠、盲区也重叠。`reviewer-codex` 失败时**严禁降级**到同源双 Claude（teammate 内部已有失败模板，lead 收到后通知用户决策）。

**为什么 teammate 而非 subagent**：teammate 跨调用 context 持久化 — 多轮场景每轮省重读文件 token + 反驳轮被反驳方记得自己上轮 finding 推理链精准度更高。环境不满足时按 §Fallback 退到 subagent 也能跑，只是失去这层 gain。

### 多轮挖深策略

| 轮次 | focus 维度 | 期待 finding |
|---|---|---|
| Round 1 | 修复正确性 / 是否引新问题 / 测试质量 | 浅层 bug、API 误用、明显 regression |
| Round 2 | 边界条件 / 并发 race / 资源 lifecycle | race window、cleanup 漏 path、状态机边角 |
| Round 3 | 架构耦合 / 安全 / 性能尾延迟 | 跨模块隐患、信任边界破坏、p95/p99 异常 |
| Round 4+ | 上轮残留 + 用户特别关注的领域 | 收口或拒合 |

### 三态裁决（每条 finding）

- ✅ **真问题**：双方独立提出 / 一方提出且现场实践验证成立（写 test 复现 / grep 调用点 / 读真实代码）→ 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，记反驳依据
- ❓ **部分 / 未验证**：双方角度不同 / 一方提出但纯文本推理（含弱断言）尚未实践验证 → 综合后决定；未验证强制降级非 HIGH

lead 对**每条单方独有**：HIGH 候选 → §Step 2.5 反驳轮；MED → 自己 grep / 读代码验证；LOW/INFO → 直接列 ❓。**不接受没验证的 ✅ HIGH**。

### 收口 / 拒合 / escalate

**收口成功**（全部满足）：双 reviewer 都给 "可合" + 0 个 HIGH/MED + 上轮真问题已 fix 通过测试 + LOW/INFO 数量趋稳。

否则继续 §Step 4 fix → 回 §Step 2 review。

**拒合**：Round 数 ≥ `max_rounds`（默认 4）仍有 HIGH → 不强行 fix，报告。同一问题连续 2 轮没修掉 → escalate（拆 scope / 写 ADR / 寻求人审）。

**reviewer-codex 失败**（teammate 输出 `## reviewer-codex 失败` 模板）→ 不要降级同源双 Claude，告诉用户决策（等恢复 / 单方 reviewer-claude / abort）。

## 步骤

### Step 0. 启动 / 续接 + 环境检测

读上下文：review target / `max_rounds` / `focus` / 上一轮 round file。

**环境检测**（决定 teammate 主流程 vs §Fallback subagent）：

| 检查 | 行动 |
|---|---|
| `claude --version` < v2.1.32 / agentTeamsEnabled OFF / 用户独立终端跑 `claude` | → §Fallback subagent |
| 三项都满足 + Hook 已装 | → teammate 主流程 |
| Hook 没装 | teammate 仍可用，但 lead 看不到状态事件，需手动 task_list 轮询 |

cwd 没有 `.deep-code-review/`：
```bash
mkdir -p .deep-code-review
echo ".deep-code-review/" >> .gitignore
```

**续接模式**：读 `state.json` 的 `teammate_alive` 字段。`true` 且 dormant 不超 24h → sendMessage 进 Round N+1；否则重新 spawn 一对。

> **resume limitation 提醒**：Anthropic v2.1.32+ Agent Teams 实验特性官方明确**不支持 `/resume` 与 `/rewind`** —— 用户中断 lead + CLI 重启后新 SDK 会话不能 attach 回原 team。但 round 文件与 state.json 都落盘，重新 §Step 2 起新一对 + 喂 skip 字段就能续上工作流（损失的是 teammate 自己的 in-memory context，不是工作进度）。

### Step 1. 划范围

- branch diff: `git diff origin/main...HEAD --stat`
- 改动文件清单 + LOC: `git diff origin/main...HEAD --name-only`
- ≥ 6000 行 / ≥ 20 文件 → 拆批

写到 `.deep-code-review/round-N.md` 顶部。

### Step 2. 初轮：spawn 两个 teammate 并发 review

> **仅 Round 1 执行**——后续轮次走 §Step 5（sendMessage 复用同一对）。

lead 自然语言指令（Agent Teams in-process backend 自动起两个独立 SDK session 加进 team config）：

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

review prompt 块（两个 teammate 收到的初始 prompt 一样）：
  scope: <要审的文件绝对路径清单 / diff range / 决策面描述>
  focus: <本轮重点维度，按 §多轮挖深策略 表填>
  skip:  <上一轮已修的 P1/P2 / 历史 review 结论 / 不必再列的项>
  repo_abs_path: <仓库绝对路径，给 reviewer-codex 用作 codex `-C` 参数>
  output_mode: full_review

请等两个 teammate 各自给出第一份 finding（hook event TeammateIdle 触发或 task_list 看到 status=completed）后再做交叉裁决，绝不在收齐前推断。
```

**注意**：
- 不在 review prompt 里写「异构原则 / 验证纪律 / 弱断言降级」——这些已固化在 reviewer agent body 里
- spawn 完不要主动 sendMessage 催；等 idle / completed 事件
- lead 等待期间不要启动其他重活（避免分散裁决精力 + 抢 SDK CLI 子进程）

两个 teammate 都给 finding 后，lead 写 `.deep-code-review/round-N.md`：

```markdown
# Round N
scope: <文件清单>
focus: <本轮重点维度>

## reviewer-claude 综合: ...
## reviewer-codex 综合: ...

## 双方一致
| ID | 维度 | 严重度 |

## 双方都看到但角度不同
| # | 严重度 | 文件:行号 | claude 视角 | codex 视角 | lead 综合 |

## 单方独有发现
| 来源 | 严重度 | 描述 | 反驳轮 (✅/❌/❓) | lead 裁决 |

## 综合判断
"可合 / 需 Round N+1 / 拒合" + 1-2 句理由
```

### Step 2.5. 反驳轮（针对单方独有 + HIGH 候选）

| Finding 类型 | 裁决 |
|---|---|
| 双方一致 / 双方都说没问题 | 直接 ✅ |
| 双方都看到但角度不同 | ❓ 综合（已有两份独立证据） |
| **单方独有 + HIGH** | ✅ **触发反驳轮** |
| 单方独有 + MED | lead 自己 grep / 读代码验证 |
| 单方独有 + LOW/INFO | 直接列 ❓ |

**反驳轮**：lead 用 sendMessage 给**对方** teammate（保持异构 + 复用 R_N context 拿精准度 gain）：

- reviewer-claude 提的 P_X → sendMessage **reviewer-codex** teammate
- reviewer-codex 提的 P_Y → sendMessage **reviewer-claude** teammate

```text
[反驳轮 / output_mode: rebuttal]

以下是 reviewer-<对方> 在 Round N 提出的 finding，请独立判断（不要做泛 review）：
<P_X 完整内容：严重度 / 文件:行号 / 描述 / 验证手段>

任务（按 reviewer agent body §rebuttal 输出格式）：
1. 同意 / 反对 / 不确定？给立场
2. 反对：给反驳证据（grep / 写小 test 复现 / 跑命令证伪）
3. 同意：补充关键细节
4. 不确定：明说哪部分验不了 + 为什么

严禁借机提其他 finding；只回应这一条。
```

**反驳后 lead 推到**：反驳成立 → ❌ 不修；反驳失败 → ✅ HIGH 必修；仍模糊 → lead 自己 Grep/Read/Bash 现场验证 → 还不行降 ❓ + 非 HIGH。

**约束**：同一条 finding 只反驳一次（避免循环）；**不要 spawn 新 teammate 反驳**——必须复用 Round 1 那对（context 复用是反驳轮 gain 核心）。

### Step 3. 决策分支

- **可合** → §Step 6 收口（cleanup teammate）
- **拒合** → 列必修问题，用户决策是否继续（默认继续）
- **需 follow-up** → §Step 4 fix

### Step 4. Fix 应用

按严重度排序 fix queue：HIGH → MED → LOW → INFO。每条 fix:
1. 改代码（精准最小修复，不顺手重构）
2. 加 / 调整测试（必须能在 fix 还原时挂掉）
3. 同步 typecheck / lint / test 全过才进下一轮
4. 单独 commit（message 含 `fix(scope): 简述 (Round N P-X)`）

LOW/INFO 默认**只列不修**（除非用户明确要）。

### Step 5. 进下一轮（sendMessage 复用 teammate context）

- fix commit hash 列在本轮 round 文件末尾
- round +1，**不要重新 spawn teammate**——sendMessage 给原两个 teammate：

```text
[Round N+1 / output_mode: full_review]

上轮已修（skip）: <fix commit hash + P-X 一句话>

新一轮 focus 切到 <下一个深度维度，见 §多轮挖深策略 表>。
scope 不变（如有微调，列出新增 / 移除文件）。

按 reviewer agent body §full_review 输出格式给本轮 finding。
```

**核心 gain 落地点**：teammate 已有 Round N 完整 context（已读文件 + mental model + 上轮 finding），不必重读、重 grep；新一轮只需换 focus + 看 fix patch。

**收敛触发**（任一）：双 reviewer "可合" + 0 HIGH/MED / Round 数 ≥ max_rounds / 用户 abort / 同一问题连续 2 轮没修掉（escalate）。

### Step 6. 收口 + teammate cleanup

```
deep-code-review 收口
├── 总轮数: N
├── 修复 issues: HIGH: P1 (R1) / P3 (R2)... | MED: P2 (R1)...
├── 测试新增: M 个
├── 反驳轮触发: K 次（推到 ✅ X / ❌ Y / 仍 ❓ Z）
├── 最终裁决: 双方均 "可合" / 触顶 max_rounds
└── commits: <hash 列表>

未解决（已 acknowledge）: (LOW) ... | (INFO) ...
Wave 后续议程（如有）: ...
建议: 推 MR / 跑 CI / 写 ADR
```

**teammate cleanup**（必做）：

```
请 cleanup 两个 teammate（reviewer-claude / reviewer-codex），dismiss / shutdown。
```

如果 cleanup 卡住（CHANGELOG_40 上游 bug：teammate `shutdown_approved` 后 config.members 不移除 → TeamDelete 拒绝），告诉用户在应用 TeamDetail UI 用「force-cleanup」按钮兜底（rm -rf `~/.claude/teams/<name>` 与 `~/.claude/tasks/<name>` 残留）。

`state.json` 的 `teammate_alive` 改 `false`。

## 上下文 / 状态文件

- `.deep-code-review/round-N.md` — 每轮一份：scope + focus + 双方 raw output 摘要 + 反驳轮结果 + 裁决表 + commit hash
- `.deep-code-review/state.json` — 跨轮：`current_round / max_rounds / fix_queue / done_queue / escalation_flags / team_name / teammate_alive / teammate_spawn_at`

`.deep-code-review/` 默认 gitignore。如需保留 review 痕迹，把关键 round 文件复制到 `reviews/REVIEW_X.md`（用户全局 CLAUDE.md「工程地基」节定义）。

## 关键约束

1. **不降级到同源双 Agent**：reviewer-codex 失败时告诉用户决策（降级单方 / 等恢复 / abort），禁止偷偷只用 reviewer-claude 双跑
2. **不把 reviewer 当 fix agent**：reviewer 只读，lead 做 fix
3. **大 scope 必须拆批**：≤ 10 文件 / ≤ 30 行 prompt 一批，每批 `run_in_background: true` 多批并发起
4. **每轮 commit atomic**：一个 fix 一个 commit，message 含 round 标记，便于单独 revert
5. **测试必须能挂回归**：判定 "如果还原本 fix，这个测试会 FAIL"。空跑测试 = 重写
6. **Round N+1 sendMessage 必须填 skip**：避免 reviewer 重复 list 上轮 finding
7. **不重新 spawn teammate**：Round 2+ / 反驳轮都用 sendMessage 复用 Round 1 那对（重新 spawn = 退化成 subagent 模式）
8. **收口必须 cleanup teammate**：卡住用 force-cleanup 兜底

## 常见反模式

| 反模式 | 后果 | 正确做法 |
|---|---|---|
| Round 2+ 重新 spawn teammate / 反驳轮 spawn 新 teammate | 失去 context 持久化 gain，退化 subagent 模式 | sendMessage 复用同一对 |
| spawn 完没等 idle / completed 事件就裁决 | 拿到不完整 finding | 必须等两个都给出第一份再裁决 |
| 把双方 raw 全文塞 lead context | context 爆炸 | reviewer 输出已是紧凑 markdown，lead 复述时只列裁决表 |
| LOW / INFO 也修 | PR 失焦 | 只列不修，留给后续 |
| 没 commit 直接进下一轮 | 无法追溯 / revert | 每个 fix 独立 commit |
| Round 1 就喊「可合」 | 缺深度证据（深 bug 通常 R2-R3 才浮现） | 至少 2-3 轮，每轮 focus 不同维度 |
| 每轮 sendMessage focus 一字不差 | reviewer 反复列同样 finding | 切换 focus + 填 skip 上轮已修 |
| 拒合时强推 fix | 把不该 scope 的工作硬塞进来 | 拒合 → 拆 scope / escalate / 写 ADR |
| reviewer-codex 失败后自己 review 一遍 | 破坏异构原则 | 必须报错让用户决策 |
| 反驳轮 prompt 没禁「借机提其他 finding」 | 反驳轮变第二轮 review | 反驳 prompt 必含「严禁借机提其他 finding」 |
| 单方独有 LOW 也走反驳轮 | 反驳成本远超价值 | 反驳轮只针对 HIGH 候选 |
| 收口忘 cleanup teammate | fs 残留 + 下次同 team_name 创建报错 | Step 6 必做；卡住用 force-cleanup |

## 与全局 CLAUDE.md 决策对抗节的关系

- 全局 CLAUDE.md「决策对抗」节：**单次**对抗（一两个问题就够，开 teammate 浪费）→ 推荐 subagent
- 本 skill：**深度迭代化** —— 多轮 × fix 循环 + focus 切片 + 反驳轮选择性触发 → 推荐 teammate（多轮 context + 反驳精准都靠它）

两个 reviewer agent 是两边共用的实现。

## 示例触发

> 用户："刚改完 Wave 11，跑下 deep code review 收口"
> Lead: Round 1 (focus: 修复正确性/regression/测试) → spawn 两 teammate → 等 finding → 三态裁决 → 1 次反驳轮 (sendMessage 对方) → 修 P1/P2 → Round 2 sendMessage 同对 (race/lifecycle/leak) → Round 3 sendMessage (架构/安全) → 双方"可合" → cleanup teammate → 收口

> 用户："reviewer-codex 报失败了"
> Lead: 不降级同源；输出失败原因 + 三选项（等 codex 恢复重试 / 单方 reviewer-claude 单跑（接受同源风险）/ abort + cleanup teammate）让用户决策

## Fallback：subagent 模式（环境不满足时）

CLI < v2.1.32 / agentTeamsEnabled OFF / 非 SDK 会话内 / 用户独立终端跑 `claude` → 退到 Task subagent 模式：

```
每轮 lead 在同一 message 里并发起两个 Task call：
  Task(subagent_type: "agent-deck:reviewer-claude", prompt: <scope+focus+skip 同 §Step 2>)
  Task(subagent_type: "agent-deck:reviewer-codex",  prompt: <同上>)
```

Trade-off：失去跨轮 context 持久化（每轮 fresh 重读文件）+ 反驳轮也是 cold start；换来零依赖 + 启动快 + 适合 ≤2 轮的轻量场景。裁决逻辑、反驳轮触发条件、收口判定**完全不变**，只是 spawn / 通信机制退到 subagent。reviewer agent 文件 frontmatter 仍有效，被 Task tool 当 subagent 注册调用。
