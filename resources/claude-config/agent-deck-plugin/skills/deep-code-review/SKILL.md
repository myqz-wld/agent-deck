---
name: deep-code-review
description: 深度 code review 工具 — 多轮异构 reviewer 对抗 + 三态裁决，把代码变更里的浅层 bug 与深层隐患（race / leak / 边角条件 / 架构耦合 / 安全 / 测试盲区）一轮轮挖到见底。每轮在同一 message 里并发起 `agent-deck:reviewer-claude` (Opus 4.7 xhigh) + `agent-deck:reviewer-codex` (gpt-5.5 xhigh) 两个独立异构 reviewer subagent，主 agent 收两份结论后做交叉裁决，发现的真问题立即 fix + 加回归测试，再进下一轮，直到双方都判 "可合" 或 max-rounds 触顶。触发：用户说「深度 code review」/「deep code review」/「code review 收口」/「双对抗 review」/「review-fix 多轮」/「/agent-deck:deep-code-review」/「再 review 一轮」。
---

# Deep Code Review — 多轮异构对抗 review × fix 收口

把「review → fix → review → fix → ... 直到挖不出新问题」这个**深度** code review 循环封装成可复用流程。重点是**多轮挖深**，不是单次确认 — 第 1 轮抓浅层（typo / null check / 错变量），第 2-3 轮挖深层（race / leak / 边角 / 架构耦合 / 测试盲区 / 性能尾延迟）。

## 何时用

- 关键路径 / 核心抽象的代码变更 review（multi-client / 并发 / lifecycle / 资源管理）
- 一改动跨多个模块、影响主链路（≥ 200 行 / ≥ 5 文件）
- MR 提交前最后一道闸门（让 reviewer 看不到任何 HIGH/MED 才推）
- 历史 bug 反复犯的模块（前几轮已 review 过仍有 escape 进生产的）
- **不适合**：trivial 改动（typo / 单点 rename / 显然措辞修订）— 一轮人审就够，深度循环成本不值

## 触发

- 显式：`/agent-deck:deep-code-review`、"deep code review"、"deep-code-review"
- 关键词：「深度 code review」「深 review」「双对抗 code review」「review fix 多轮」「review 收口」「Wave N 收口」「加固直到合格」「review 直到挖不出问题」
- 用户说「再 review 一轮」/「再加一轮 review」/「continue deep-code-review」时**续接上一轮**（看 §Step 0）

## 核心设计

### 异构对抗（深度 review 的根基）

每轮**必须**在同一 message 里并发起两个 reviewer subagent：

| Reviewer A | Reviewer B |
|---|---|
| `agent-deck:reviewer-claude`（Opus 4.7 xhigh） | `agent-deck:reviewer-codex`（gpt-5.5 xhigh，wrapper 内跑 codex CLI） |

两个 subagent 完全独立（互相不知道对方存在 / 不沟通），各自回到本 skill 的主 agent。**主 agent 自己**做三态裁决——绝不让 reviewer 既当 reviewer 又当裁判。

> **不要**两个 Claude 自己 review — 模型同源 = findings 重叠、盲区也重叠，深度无从谈起。`reviewer-codex` 失败时**严禁降级**到同源双 Claude（agent 内部已有失败模板，主 agent 收到失败后通知用户决策）。

### 多轮挖深策略

| 轮次 | focus 维度 | 期待 finding 类型 |
|---|---|---|
| Round 1 | A) 修复正确性 B) 是否引入新问题 C) 测试质量 | 浅层 bug、API 误用、明显 regression |
| Round 2 | D) 边界条件 E) 并发 / race / 顺序窗口 F) 资源 lifecycle / leak | race window、cleanup 漏 path、状态机边角 |
| Round 3 | G) 架构耦合 / 抽象边界 H) 安全（输入 trust / 权限放大）I) 性能尾延迟 | 跨模块隐患、信任边界破坏、p95/p99 异常 |
| Round 4+ | 上轮残留 + 用户特别关注的领域 | 收口或拒合 |

每轮 prompt 的 focus 字段填该轮重点维度；reviewer agent 内部按 focus 优先排序 finding。

### 三态裁决（每条 finding）

- ✅ **真问题**：双方独立提出 / 一方提出**且现场实践验证成立**（写小 test 复现 / grep 调用点 / 读真实代码确认）→ 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，理由记下
- ❓ **部分** / **未验证**：双方都看到现场但角度不同 / 一方提出但纯文本推理（含弱断言 "可能 / 也许"）尚未实践验证 → 综合后决定修或不修；未验证的必须降级为非 HIGH 严重度

主 agent 在裁决时，对**每条单方独有发现**：
1. 严重度 HIGH 候选 → 走反驳轮（§Step 2.5），spawn 对方 reviewer 反驳
2. 严重度 MED → 主 agent 自己用 Grep / Read / Bash 工具验证一次
3. 严重度 LOW/INFO → 直接列 ❓ 不深究
4. **不接受没经过验证的 ✅ HIGH**

### 收口判定

满足全部条件 → **收口成功**：
1. 当轮双 reviewer 都给 "可合"
2. 当轮 0 个 HIGH/MED 真问题
3. 上轮的真问题已经全部 fix 并通过测试
4. 当轮 LOW/INFO 数量已经趋于稳定（不再涌出新发现）

否则继续：进 §Step 4 fix 流程，再回 §Step 2 review。

### 拒合与 escalate

- Round 数 ≥ `max_rounds`（默认 4）仍有 HIGH 真问题 → **拒合 + 报告**，不强行 fix
- 同一问题连续 2 轮没修掉 → 说明无法在当前 scope 内解决，**escalate**：建议拆 scope / 写 ADR / 寻求人审
- `agent-deck:reviewer-codex` 失败（agent 输出 `## reviewer-codex 失败` 模板）→ 不要降级到同源双 Claude，**告诉用户决策**：等恢复 / 单方 reviewer-claude 出结论 / abort

## 步骤

### Step 0. 启动 / 续接判断

读取上下文：
- 用户给的 review target（branch / commits range / 文件范围 / `--since=COMMIT`）
- 是否给了 `max_rounds`（默认 4）
- 是否给了 `focus`（特别关注的维度，如 `multi-client race` / `memory leak` / `security`）
- 上一轮的 round file（`.deep-code-review/round-N.md`）— 续接模式

如果 cwd 没有 `.deep-code-review/`，初始化：
```bash
mkdir -p .deep-code-review
echo ".deep-code-review/" >> .gitignore  # 不污染 repo
```

### Step 1. 划范围

明确一轮 review 的 scope：
- branch diff: `git diff origin/main...HEAD --stat`
- 改动文件清单 + LOC：`git diff origin/main...HEAD --name-only`
- 大于 ~6000 行 / ~20 文件 → 拆批，否则 single batch

scope + round 重点维度写到 `.deep-code-review/round-N.md` 顶部。

### Step 2. 并发 review（**真并发，委托 agent**）

**同一个 message 里**起两个 Task call：

1. `Task(subagent_type: "agent-deck:reviewer-claude", prompt: <见下>)`
2. `Task(subagent_type: "agent-deck:reviewer-codex",  prompt: <见下>)`

两个 prompt 内容**对齐当前 round focus**，结构：

```text
scope:
<本轮要审的文件绝对路径清单 / diff range / 决策面描述>

focus:
<本轮重点维度，按 §多轮挖深策略 表填，如 "race / lifecycle / leak"（Round 2）>

skip:
<上一轮已修的 P1/P2 / 历史 review 结论 / 不必再列的项；让 reviewer 不重复劳动>

repo_abs_path: <仓库绝对路径，给 reviewer-codex 用作 codex `-C` 参数>
```

**注意**：
- Round N+1 的 prompt 顶部必须填 `skip: 上一轮已修 P1/P2/...` 让 reviewer 不重复劳动
- 不要在 prompt 里再写「异构原则 / 验证纪律 / 弱断言降级」等纪律——这些已经在两个 reviewer agent 的 body 里固化，重复写只会浪费 token

两个 reviewer 都返回后，**主 agent 自己**做交叉对比 + 三态裁决，写到 `.deep-code-review/round-N.md`：

```markdown
# Round N

scope: <文件清单>
focus: <本轮重点维度>

## reviewer-claude 综合: ...
## reviewer-codex 综合: ...

## 双方一致
| ID | 维度 | 严重度 |
|---|---|---|

## 双方都看到但角度不同
| # | 严重度 | 文件:行号 | claude 视角 | codex 视角 | 主 agent 综合 |
|---|---|---|---|---|---|

## 单方独有发现
| 来源 | 严重度 | 描述 | 反驳轮 (✅/❌/❓) | 主 agent 裁决 |

## 综合判断
"可合 / 需 Round N+1 / 拒合" + 1-2 句理由
```

### Step 2.5. 反驳轮（针对单方独有 + HIGH 候选）

**触发条件**：单方独有 + HIGH 候选 finding。其他情形不触发反驳轮，直接走裁决（不浪费 token）：

| Finding 类型 | 裁决方式 |
|---|---|
| 双方一致 | 直接 ✅ |
| 双方都看到但角度不同 | ❓ 综合（已有两份独立证据） |
| **单方独有 + HIGH** | ✅ **触发反驳轮** |
| 单方独有 + MED | 主 agent 自己 grep / 读代码验证 |
| 单方独有 + LOW/INFO | 直接列 ❓ |
| 双方都说没问题 | ✅ 可合 |

**反驳轮做法**：

主 agent spawn **对方** reviewer 反驳（保持异构）：

- reviewer-claude 提出的 P_X → spawn `agent-deck:reviewer-codex` 反驳
- reviewer-codex 提出的 P_Y → spawn `agent-deck:reviewer-claude` 反驳

反驳 prompt 模板（**专注单点，禁止借机提其他 finding**）：

```text
以下是 reviewer-<对方> 提出的 finding，请独立判断（不要做泛 review）：

<P_X 完整内容：严重度 / 文件:行号 / 描述 / 验证手段>

你的任务：
1. 同意 / 反对 / 不确定？给立场
2. 反对：给反驳证据（grep 调用点 / 写小 test 复现走得通 / 跑命令证伪）
3. 同意：补充关键细节或加固方向
4. 不确定：明说哪部分验不了 + 为什么

严禁借机提其他 finding；只回应被反驳的这一条。
```

**反驳后主 agent 推到**：
- 反驳成立（对方给反证）→ ❌ 不修，记反驳依据
- 反驳失败（对方独立验证后同意）→ ✅ HIGH 真问题，必修
- 仍模糊（对方也不确定）→ 主 agent **自己**用 Grep / Read / Bash 现场验证 → 还不行降 ❓ + 非 HIGH

**约束**：
- 同一条 finding 只反驳一次（避免循环）
- 单轮反驳轮发起的 Task call 数量 = 单方独有 HIGH 候选数量；通常 0-3 条
- 反驳结果写到 `round-N.md` 的「单方独有发现」表里

### Step 3. 决策分支

- **可合**：报告给用户「Round N 收口成功」，列改动 stat + 结束
- **拒合**：列必修问题，**用户决策是否继续**（默认继续）
- **需 follow-up**：进 §Step 4 fix

### Step 4. Fix 应用

按严重度排序 fix queue：HIGH → MED → LOW → INFO。

每条 fix:
1. 改代码（精准最小修复，不顺手重构）
2. 加 / 调整测试（每个 fix 至少有一个回归保护测试，能在 fix 还原时挂掉）
3. 同步 typecheck / lint / test（这一轮的 fix 全部通过才进下一轮）
4. 单独 commit（commit message 含 `fix(scope): 简述 (Round N P-X)` 标记，便于追溯）

LOW / INFO 默认**只列不修**（除非用户明确要），避免 PR 失焦。

### Step 5. 进下一轮

- fix commit hash 列在 `.deep-code-review/round-N.md` 末尾
- round number +1，回 Step 2，**focus 切到下一个深度维度**（见 §多轮挖深策略 表）
- 触发收敛之一：
  - 双 reviewer 都给 "可合" + 0 个 HIGH/MED
  - Round 数 ≥ `max_rounds`（默认 4）
  - 用户主动 abort
  - 同一问题连续 2 轮没修掉（escalate）

### Step 6. 收口

输出最终 summary 给用户：

```
deep-code-review 收口
├── 总轮数: N
├── 修复 issues:
│   ├── HIGH: P1 (Round 1) / P3 (Round 2) / ...
│   └── MED:  P2 (Round 1) / ...
├── 测试新增: M 个
├── 反驳轮触发: K 次（推到 ✅ X 条 / ❌ Y 条 / 仍 ❓ Z 条）
├── 最终裁决: 双方均 "可合" / 触顶 max_rounds
└── commits: <hash 列表>

未解决（已 acknowledge）:
├── (LOW) ...
└── (INFO) ...

Wave 后续议程（如有）:
└── ...

建议: 推 MR / 跑 CI / 通知 reviewer / 写 ADR
```

## 上下文 / 状态文件

- `.deep-code-review/round-N.md` — 每轮一份，含 scope + focus + 双方 raw output 摘要 + 反驳轮结果 + 裁决表 + commit hash
- `.deep-code-review/state.json`（可选）— 跨轮状态：current round / max_rounds / fix queue / done queue / escalation flags

`.deep-code-review/` 默认 gitignore，不进 commit。如果用户希望保留 review 痕迹，可以把关键 round 文件复制到 `reviews/REVIEW_X.md`（用户全局 CLAUDE.md「工程地基」节定义）。

## 关键约束

> 验证纪律 / 弱断言降级 / 实践验证 / codex CLI 调用模板 / 失败兜底 等规则**已固化在 reviewer agent body 里**，本节只列 skill 主流程层面的约束。

1. **不要降级到同源双 Agent**：`agent-deck:reviewer-codex` 失败时（输出 `## reviewer-codex 失败` 模板），主 agent **告诉用户并请决策**：降级到单方 / 等恢复 / abort。**禁止偷偷只用 reviewer-claude 双跑**（同源 = 同盲区）。

2. **不要把 reviewer 当 fix agent**：reviewer 只读，主 agent 做 fix。两个 agent 的 frontmatter `tools` 都没含 Edit/Write，从 system prompt 层面禁掉。

3. **大 scope 必须拆批**：单 prompt 文件清单 ≥ 15 / 总长 ≥ 80 行 + reasoning xhigh，codex 容易卡。≤10 文件一批，每批独立 round，最后汇总。

4. **每轮 commit 必须 atomic**：一个 fix 一个 commit，commit message 含 round 标记。这样如果某 fix 后续被反驳，可以单独 revert，不影响其他 fix。

5. **测试必须能挂掉回归**：判定标准 "如果还原本 fix，这个测试会 FAIL"。空跑测试（pass 不论 fix 在不在）= 没有测试，重写。

6. **Round N+1 prompt 必须填 skip**：上轮已修了什么必须写进 skip 字段，否则 reviewer 会重复 list 上一轮的 finding，浪费 token + 假阳性多。

## 常见反模式

| 反模式 | 后果 | 正确做法 |
|---|---|---|
| 串行起两个 Task call | 慢一倍，消耗 context | 同一 message 里并发起两个 Task |
| 把双方 raw 全文塞主 context | context 爆炸 | reviewer agent 输出已经是紧凑 markdown，主 agent 复述时只列裁决表 |
| LOW / INFO 也修 | PR 失焦 | 只列不修，留给后续 |
| 没有 commit 直接进下一轮 | 无法追溯 / revert | 每个 fix 独立 commit |
| Round 1 就喊「可合」 | 缺少深度证据（深 bug 通常 R2-R3 才浮现） | 至少跑 2-3 轮，每轮 focus 不同维度 |
| 每轮 prompt focus 一字不差 | reviewer 反复列同样 finding | Round N+1 切换 focus + 填 skip 上轮已修 |
| 拒合时强推 fix | 把不该 scope 的工作硬塞进来 | 拒合 → 拆 scope / escalate / 写 ADR |
| reviewer-codex 失败后自己 review 一遍 | 破坏异构原则 | 必须报错让用户决策 |
| 反驳轮 prompt 没禁「借机提其他 finding」 | 反驳轮变成第二轮 review，token 暴涨 | 反驳 prompt 必须含「严禁借机提其他 finding」 |
| 单方独有 LOW 也走反驳轮 | 反驳成本远超价值 | 反驳轮只针对 HIGH 候选 |

## 与「用户全局 CLAUDE.md 决策对抗节」的关系

用户全局 CLAUDE.md 已经定义了「决策对抗」原则（异构双 reviewer + 反驳轮 + 三态裁决），**两个 reviewer agent 是两边共用的**实现：

- 全局 CLAUDE.md 用 reviewer-claude / reviewer-codex 做单次决策对抗
- 本 skill 是把这个原则**深度迭代化**：单次决策对抗 → 多轮 review × fix 循环 + focus 切片 + 反驳轮选择性触发，并自动管理状态文件 / commit 节奏 / 收口判定 / escalate 机制

如果你的全局 CLAUDE.md 没有「决策对抗」节，本 skill 仍可独立运行 — 调用方姿势就是同一 message 起两个 Task call 起两个 reviewer agent。

## 示例触发

> 用户："刚改完 Wave 11，跑下 deep code review 收口"
> Agent: 启动 Round 1（focus: 修复正确性 / regression / 测试）→ 同 message spawn reviewer-claude + reviewer-codex → 两份返回 → 三态裁决 → 触发 1 次反驳轮 → 修 P1/P2 → Round 2（focus: race / lifecycle / leak）→ 修 P3 → Round 3（focus: 架构 / 安全）→ 双方 "可合" → 收口

> 用户："这个 PR 我担心 multi-client race，深 review 几轮"
> Agent: 设 `focus: multi-client race`、`max_rounds: 5`，每轮 prompt focus 字段强调 concurrency / lifecycle / shared state / cleanup / order window

> 用户："deep-code-review 接着跑"（中断后续接）
> Agent: 读 `.deep-code-review/state.json` 确认 current round = K，从 Step 2 起 Round K+1，focus 顺位下一个维度

> 用户："reviewer-codex 报失败了"
> Agent: 不降级到同源双 reviewer-claude；输出失败原因 + 三个选项（等 codex 恢复重跑 / 单方 reviewer-claude 单跑（用户接受同源风险）/ abort 本轮）让用户决策
