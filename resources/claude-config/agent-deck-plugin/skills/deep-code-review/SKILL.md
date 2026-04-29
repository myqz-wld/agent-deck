---
name: deep-code-review
description: 深度 code review 工具 — 多轮异构 reviewer 对抗 + 三态裁决，把代码变更里的浅层 bug 与深层隐患（race / leak / 边角条件 / 架构耦合 / 安全 / 测试盲区）一轮轮挖到见底。每轮并发跑 Codex CLI（gpt-5.5 xhigh）+ Claude code-reviewer subagent（Opus 4.7 xhigh）两个异构 reviewer，主 agent 做交叉裁决，发现的真问题立即 fix + 加回归测试，再进下一轮，直到双方都判 "可合" 或 max-rounds 触顶。触发：用户说「深度 code review」/「deep code review」/「code review 收口」/「双对抗 review」/「review-fix 多轮」/「/agent-deck:deep-code-review」/「再 review 一轮」。
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
- 用户说「再 review 一轮」/「再加一轮 review」/「continue deep-code-review」时**续接上一轮**（看 §6）

## 核心设计

### 异构原则（深度 review 的根基）

每轮**必须**并发 spawn 2 个**不同源**的 reviewer，最大化降低同源盲区：

| Reviewer A | Reviewer B |
|---|---|
| Claude code-reviewer subagent（Opus 4.7 xhigh）| Bash 调外部 codex CLI（gpt-5.5 xhigh）|
| Agent tool with `subagent_type: "code-reviewer"` | zsh 登录 shell + `codex exec`（模板见下）|

**禁止**两个 Claude 自己 review — 模型同源 = findings 重叠、盲区也重叠，深度无从谈起。

### 多轮挖深策略

| 轮次 | 重点 prompt 维度 | 期待 finding 类型 |
|---|---|---|
| Round 1 | A) 修复正确性 B) 是否引入新问题 C) 测试质量 | 浅层 bug、API 误用、明显 regression |
| Round 2 | D) 边界条件 E) 并发 / race / 顺序窗口 F) 资源 lifecycle / leak | race window、cleanup 漏 path、状态机边角 |
| Round 3 | G) 架构耦合 / 抽象边界 H) 安全（输入 trust / 权限放大）I) 性能尾延迟 | 跨模块隐患、信任边界破坏、p95/p99 异常 |
| Round 4+ | 上轮残留 + 用户特别关注的领域 | 收口或拒合 |

每轮 prompt 在 base 维度（A/B/C 永远要）基础上叠加该轮**重点**维度，让 reviewer 主动往深处看。

### codex CLI 调用模板

```bash
OUT=$(mktemp); PROMPT=$(mktemp)
cat > "$PROMPT" <<'EOF'
你是对抗 reviewer。... <prompt 内容> ...
约束：只读、不要写文件、不要 commit、用中文输出。
EOF
zsh -i -l -c "codex exec --sandbox read-only --skip-git-repo-check \
  -c model_reasoning_effort=\"xhigh\" \
  -C <REPO_ABS_PATH> -o '$OUT' - < '$PROMPT'"
cat "$OUT"
rm -f "$OUT" "$PROMPT"
```

Bash 工具调用 timeout: **600000**（深度 review）。`run_in_background: true` 让 codex 跑同时 spawn Claude reviewer 真并发。

### 三态裁决（每条 finding）

- ✅ **真问题**：双方独立提出 / 一方提出但现场核实成立 → 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，理由记下
- ⚠️ **部分**：双方都看到现场但角度不同 → 综合后决定修或不修

每条结论必须带 `文件:行号` + 代码片段 / 原文证据。空泛 finding 直接降级为 ⚠️ 或 ❌。

### 收口判定

满足全部条件 → **收口成功**：
1. 当轮双 reviewer 都给 "可合"
2. 当轮 0 个 HIGH/MED 真问题
3. 上轮的真问题已经全部 fix 并通过测试
4. 当轮 LOW/INFO 数量已经趋于稳定（不再涌出新发现）

否则继续：进 §3 fix 流程，再回 §2 review。

### 拒合与 escalate

- Round 数 ≥ `max_rounds`（默认 4）仍有 HIGH 真问题 → **拒合 + 报告**，不强行 fix
- 同一问题连续 2 轮没修掉 → 说明无法在当前 scope 内解决，**escalate**：建议拆 scope / 写 ADR / 寻求人审
- codex CLI 不可用 → 不要降级到同源双 Claude，**告诉用户决策**：等 codex 恢复 / 单方出结论 / abort

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

### Step 2. 并发 review（**真并发**）

**同一个 message 里**起两个 tool call：
1. Bash 起 codex CLI（`run_in_background: true`，给 600000 ms）
2. Agent 起 Claude code-reviewer subagent（不能 background，但因 codex 在 background 跑，二者并发）

两份 prompt 内容不一定一字不差，但**核心维度对齐当前 round 重点**（见上表）。Round N+1 的 prompt 顶部必须写「上一轮已修：P1/P2 别再列；本轮重点关注 X/Y」让 reviewer 不重复劳动。

两个 reviewer 都返回后，**主 agent 自己**做交叉对比 + 三态裁决，写到 `.deep-code-review/round-N.md`：

```markdown
# Round N

scope: <文件清单>
focus: <本轮重点维度>

## Codex (gpt-5.5 xhigh) 综合: ...
## Claude code-reviewer (Opus 4.7) 综合: ...

## 双方完全一致
| ID | 维度 | Codex | Claude | 严重度 |
|---|---|---|---|---|
| A1 | ... | ✅ | ✅ | HIGH |

## 双方都发现的问题
| # | 严重度 | 文件:行号 | 问题 | 修复方向 |
|---|---|---|---|---|
| P1 | HIGH | x.ts:123 | ... | ... |

## 单方独有发现
| 来源 | 严重度 | 描述 | 主 agent 裁决 (✅/❌/⚠️) | 理由 |

## 综合判断
"可合 / 需 Round N+1 / 拒合" + 1-2 句理由
```

### Step 3. 决策分支

- **可合**：报告给用户「Round N 收口成功」，列改动 stat + 结束
- **拒合**：列必修问题，**用户决策是否继续**（默认继续）
- **需 follow-up**：进 §4 fix

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
- round number +1，回 Step 2，**focus 切到下一个深度维度**（见上表）
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

- `.deep-code-review/round-N.md` — 每轮一份，含 scope + focus + 双方 raw output 摘要 + 裁决表 + commit hash
- `.deep-code-review/state.json`（可选）— 跨轮状态：current round / max_rounds / fix queue / done queue / escalation flags

`.deep-code-review/` 默认 gitignore，不进 commit。如果用户希望保留 review 痕迹，可以把关键 round 文件复制到 `reviews/REVIEW_X.md`（用户全局 CLAUDE.md「工程地基」节定义）。

## 关键约束

1. **不要降级到同源双 Agent**：codex CLI 不可用时（`Reconnecting...` / OAuth 过期 / 二进制缺失），**告诉用户并请决策**：降级到单方 / 等恢复 / abort。**禁止偷偷只用 Claude 双跑**（同源 = 同盲区）。

2. **不要把 reviewer 当 fix agent**：reviewer 只读，主 agent 做 fix。reviewer subagent 用 `code-reviewer` 类型确保只读语义。

3. **大 scope 必须拆批**：单 prompt 文件清单 ≥ 15 / 总长 ≥ 80 行 + reasoning xhigh，codex 容易卡。≤10 文件一批，每批独立 round，最后汇总。

4. **每轮 commit 必须 atomic**：一个 fix 一个 commit，commit message 含 round 标记。这样如果某 fix 后续被反驳，可以单独 revert，不影响其他 fix。

5. **测试必须能挂掉回归**：判定标准 "如果还原本 fix，这个测试会 FAIL"。空跑测试（pass 不论 fix 在不在）= 没有测试，重写。

6. **Round N+1 prompt 必须告诉 reviewer 上轮已修了什么**：否则 reviewer 会重复 list 上一轮的 finding，浪费 token + 假阳性多。

## 常见反模式

| 反模式 | 后果 | 正确做法 |
|---|---|---|
| 串行跑两个 reviewer | 慢一倍，消耗 context | `run_in_background: true` 真并发 |
| 把双方 raw 全文塞主 context | context 爆炸 | 让 reviewer 用紧凑 bullet 输出，主 agent 只复述裁决 |
| LOW / INFO 也修 | PR 失焦 | 只列不修，留给后续 |
| 没有 commit 直接进下一轮 | 无法追溯 / revert | 每个 fix 独立 commit |
| Round 1 就喊「可合」 | 缺少深度证据（深 bug 通常 R2-R3 才浮现） | 至少跑 2-3 轮，每轮 focus 不同维度 |
| 每轮 prompt 一字不差 | reviewer 反复列同样 finding | Round N+1 prompt 切换 focus + 告知上轮已修 |
| 拒合时强推 fix | 把不该 scope 的工作硬塞进来 | 拒合 → 拆 scope / escalate / 写 ADR |

## 与「用户全局 CLAUDE.md 决策对抗节」的关系

用户全局 CLAUDE.md 已经定义了「决策对抗」原则（异构双 reviewer + 三态裁决）。本 skill 是把这个原则**深度迭代化**：单次决策对抗 → 多轮 review × fix 循环 + focus 切片，并自动管理状态文件 / commit 节奏 / 收口判定 / escalate 机制。

如果你的全局 CLAUDE.md 没有「决策对抗」节，本 skill 仍可独立运行 — prompt 模板已经自带异构原则。

## 示例触发

> 用户："刚改完 Wave 11，跑下 deep code review 收口"
> Agent: 启动 Round 1（focus: 修复正确性 / regression / 测试）→ 三态裁决 → 修 P1/P2 → Round 2（focus: race / lifecycle / leak）→ 修 P3 → Round 3（focus: 架构 / 安全）→ 双方 "可合" → 收口

> 用户："这个 PR 我担心 multi-client race，深 review 几轮"
> Agent: 设 `focus: multi-client race`、`max_rounds: 5`，每轮 prompt 强调 concurrency / lifecycle / shared state / cleanup / order window

> 用户："deep-code-review 接着跑"（中断后续接）
> Agent: 读 `.deep-code-review/state.json` 确认 current round = K，从 Step 2 起 Round K+1，focus 顺位下一个维度
