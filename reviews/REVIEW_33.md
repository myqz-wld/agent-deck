# REVIEW_33 — 5 份指令文档对抗 review × 优化落地

## 触发场景

用户要求对抗 review 5 份给 coding agent 的指令文档（system-prompt 类规则）有没有优化空间，明确指示「不要有太多历史兼容逻辑，没有意义」。这是 [REVIEW_30](REVIEW_30.md)（首轮 SKILL 三件套 + 两份 CLAUDE.md 大规模减肥）的延续 round —— REVIEW_30 改完后进入 maintenance 期，期间陆续加入若干 feature（CHANGELOG_99 hand_off_session 双模式 / archive_plan / NO MSG ANCHOR / fresh-session 信号化等），又积累了一批新的跨文档复制 / 历史标记 / 事实漂移。

## 方法

按 user CLAUDE.md §决策对抗 §场景分流走 **§主路径 双 Bash 起异构外部 CLI**（不是 deep-code-review SKILL —— 单次评审而非多轮 review × fix）：

- **reviewer-claude**: `zsh -i -l -c "claude -p"`（Claude Code CLI oneshot print mode，Opus 4.7 xhigh）
- **reviewer-codex**: `zsh -i -l -c "codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=xhigh"`（gpt-5.5 xhigh）

两路同 message 并发（`run_in_background: true` + `timeout: 600000`），各自独立审视相同 scope，互不知道存在。完毕后 lead 三态裁决，关键 HIGH 走 grep + 读 implementation 现场验证。

### Scope（5 份文档总 962 行）

- `~/.claude/CLAUDE.md` (364 行) — 用户全局通用约定
- `resources/claude-config/CLAUDE.md` (158 行) — agent-deck 应用打包注入 SDK system prompt 末尾
- `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md` (112 行)
- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md` (135 行)
- `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md` (193 行)

### Focus（用户主诉求驱动）

1. 历史兼容逻辑 / 迁移过渡描述（CHANGELOG_NN 引用 / "原叫 X 现在改 Y" / "已降级为 stub"）
2. 跨文档冗余（同概念在多文件重复定义）
3. 同文档内冗余（反模式 / 失败兜底 / 核心纪律 / 输入识别 互相重复）
4. 过度详细的 edge case 描述（细节多但低频用上）
5. 结构问题（章节划分 / 标题层级 / 表格 vs 列表）
6. 与时俱进度（引用已删 / 重命名 / 不存在的 API）

## 三态裁决清单

### ✅ HIGH（4 条 — 必修）

| # | 文件 / 节 | 问题 | 提出方 | 验证手段 |
|---|---|---|---|---|
| 1 | `app CLAUDE.md:92` §archive_plan | 文档写「plan status ≠ completed 拒」**事实写反** —— 实现是 `status !== 'in_progress'` 拒，会误导 agent 提前置 completed 触发短路 | reviewer-codex 单方 | 读 `archive-plan-impl.ts:236` 实测 |
| 2 | `reviewer-codex.md:31` 原 #8 | `（CHANGELOG_100，详第 12 条）` 残留是 5 份文档里**唯一**一处 CHANGELOG 编号引用，user 主诉求"无意义包袱"最纯案例 | 双方共识（claude HIGH / codex LOW） | `grep -E "CHANGELOG_[0-9]+"` 5 份只此一处 |
| 3 | `reviewer-codex.md:84-90` + `L115-119` | §codex CLI 调用模板 内**两遍**约束块，前者 5 条完整版、后者 4 条精简版且措辞不同，agent 拼 prompt 时不知该用哪个 | reviewer-claude 单方 | Read 实测两段并列共存 |
| 4 | `app CLAUDE.md` L94-148 vs `user CLAUDE.md` L204-245 | hand_off_session / archive_plan 两 tool args / 返回值 schema / 自动做的事情清单**两边都完整展开一遍** —— 违反 app CLAUDE 自己 L4/L12 声明的"不复制 user CLAUDE.md 任何内容" | reviewer-codex 单方 | sed 实测两边重叠度极高（~70 行 prose 复制） |

### ✅ MED（9 条 — 接受）

| # | 文件 / 节 | 问题 | 提出方 |
|---|---|---|---|
| 1 | `reviewer-{claude,codex}.md` 核心纪律 | NO MSG ANCHOR 退化路径段近乎逐字重复（双方共 ~12 行） | 双方共识 |
| 2 | `SKILL.md:105-107` §dormant ≠ 丢 mental model | 与 Step 6 callout（L63）+ app CLAUDE.md SSOT 三处描述同概念 | 双方共识 |
| 3 | `app CLAUDE.md:152-158` §recoverer cwd 启发式 fallback | 5 步内部算法描述对运行时 agent 无价值（agent 不操作这段代码） | 双方共识 |
| 4 | `reviewer-codex.md:164-174` §反模式 | 表头括号 meta + 末尾 callout 双 meta；表内 5 行有 4 行已被 §核心纪律 / §codex CLI 调用模板 / §rebuttal 显式覆盖 | 双方共识 |
| 5 | `reviewer-{claude,codex}.md` 核心纪律末 | wire format id invariant 逐字重复（charset / regex 与 crypto.randomUUID 关系） | reviewer-claude 单方，grep 实证 |
| 6 | `app CLAUDE.md:73` | "protocol.md 已降级为 stub" 是状态变更过去式叙述 | 双方共识（claude HIGH / codex LOW，折中 MED） |
| 7 | `app CLAUDE.md` L4 + L12 | HTML 注释 + blockquote 两段几乎逐字相同的"只补差异不复制 user"声明 | reviewer-claude 单方，Read 实证 |
| 8 | `user CLAUDE.md` §Step 4 | "完成（推荐）" + "完成（fallback 手动 5 步）" 并列结构，多数 agent 在 mcp 环境 fallback 是低频路径 | reviewer-claude 单方 |
| 9 | `reviewer-codex.md:91-95` §codex CLI 调用模板 | mktemp 5 行注释解释 sandbox/TMPDIR 原因，与 §核心纪律 第 11 条（现 #10）重复 | reviewer-codex 单方 |

### ✅ LOW（2 条 — 接受）

| # | 文件 / 节 | 问题 | 提出方 |
|---|---|---|---|
| 1 | `reviewer-codex.md:18` callout + 原 #8 | 都说"不主动 shutdown"；reviewer-claude 只有 callout 没 #8 → 两个 reviewer 不对称 | reviewer-claude 单方 |
| 2 | `SKILL.md:58-59` Step 2 | 把 dispatch 链 + wire prefix 全展开（"universal-message-watcher → adapter.receiveTeammateMessage → ..."），属 reviewer agent 契约细节 | reviewer-codex 单方 |

### ❌ 反驳（2 条）

| # | 文件 / 节 | reviewer 提出 | 反驳依据 |
|---|---|---|---|
| 1 | `user CLAUDE.md` 模板路径 *未验证* | reviewer-claude 推断 `~/.claude/templates/reviewer-*.sh.tmpl` 可能不存在 | review 起跑前已 `ls` 实测 1633 / 1854 字节 5 月 14 日存在 |
| 2 | `reviewer-{claude,codex}.md` frontmatter description 高度对称 | reviewer-claude LOW 候选自降级 | LOW 不强改；frontmatter description 是 SDK 决定何时调 agent 的关键 hint，每 agent 自带描述更稳 |

### ❓ 未验证（保留观察 — 不强改）

| # | 来源 | 为何不动 |
|---|---|---|
| 1 | reviewer-codex.md 4 种规则容器边界（核心纪律 / codex CLI 调用模板 / 失败兜底 / 反模式）| reviewer-claude 自标 *未验证*，没拉 agent 实读样本验证是否真困惑；保留观察 |

## 修复落地（18 项 1 commit 内全部完成 — 纯文档清理无 typecheck/build 影响）

按依赖顺序（先抽 SSOT 目的地，再各 reviewer 引用）：

### app CLAUDE.md（158 → 102，**减 35%**）

1. HIGH-1: `plan status ≠ completed` → `≠ in_progress（completed / abandoned 均拒）`
2. HIGH-4: §archive_plan 18 → 6 行 / §hand_off_session 55 → 15 行，删与 user CLAUDE.md 重复 args / 返回值 / 自动做清单，只留 app-only 差异（baton 不计 spawn_depth / archive 无条件原则 / cwd resilience / 预检短路）
3. MED-3: §recoverer 5 步算法 → 1-2 句 + `recoverer.ts:103-220` 指针
4. MED-6: 删「protocol.md 已降级为 stub」过渡说明
5. MED-7: HTML 注释多行 → 1 行 stub
6. MED-1 SSOT 落地: 新增 §NO MSG ANCHOR 退化路径子节（4 步退化逻辑 + 反查启发式 + 副作用警告 + 终极兜底）
7. MED-5 SSOT 落地: §Wire format / regex / DB invariant 节加 wire format id invariant 说明（crypto.randomUUID v4 charset 与 regex 严格对齐）

### user CLAUDE.md（364 → 366，+2，加 details 块外壳）

8. MED-8: §Step 4 fallback 5 步 → `<details><summary>展开</summary>...</details>` 折叠

### SKILL.md（112 → 107，−5）

9. MED-2: 删独立 §dormant ≠ 丢 mental model 节（Step 6 callout 已覆盖 + app CLAUDE 是 SSOT）
10. LOW-2: Step 2 dispatch 链 + wire prefix 展开 → 1 句"等 reply 自动注入；详机制见 app CLAUDE.md §Universal Team Backend"

### reviewer-claude.md（135 → 130，−5）

11. MED-1: 删 NO MSG ANCHOR 退化路径段 6 行 → 1 行引用 app CLAUDE
12. MED-5: 删 wire format id invariant 1 行 → 1 行引用 app CLAUDE

### reviewer-codex.md（193 → 168，**减 13%**）

13. LOW-1: 删 #8（"不主动调 shutdown_session" callout 已覆盖；HIGH-2 CHANGELOG_100 残留**随之自动清除**）
14. 编号重排: #9-12 → #8-11
15. MED-1: 删 NO MSG ANCHOR 退化路径段 6 行 → 1 行引用 app CLAUDE
16. MED-5: 删 wire format id invariant 1 行 → 1 行引用 app CLAUDE
17. HIGH-3: 删独立顶部约束块 9 行 + heredoc 内精简 4 条扩到完整 5 条（SSOT 唯一）
18. MED-9: mktemp 5 行注释 → 1 行 `# mktemp 必走 $TMPDIR（详 §核心纪律 第 10 条）`
19. MED-4: §反模式表头括号 meta 删 / 末尾 callout 删 / 表内 5 行 → 1 行（只留"改 codex 严重度 / 合并 finding"——前面没显式覆盖的真边界）
20. 交叉引用编号同步: callout 「§核心纪律 第 12 条」→ 第 11 条；mktemp 注释「第 11 条」→ 第 10 条；codex 模板 -C 注释「第 10 条」→ 第 9 条

## 总账

| 文件 | 优化前 | 优化后 | 净变化 |
|---|---|---|---|
| user CLAUDE.md | 364 | 366 | +2 |
| app CLAUDE.md | 158 | 102 | **−56（−35%）** |
| SKILL.md | 112 | 107 | −5 |
| reviewer-claude.md | 135 | 130 | −5 |
| reviewer-codex.md | 193 | 168 | **−25（−13%）** |
| **合计** | **962** | **873** | **−89（−9.2%）** |

## 验证

- `grep -E 'CHANGELOG_[0-9]+|已降级为 stub|原手动|start_next_session|原叫|原来叫|改名前'` 5 份文件：app/SKILL/reviewer-claude/reviewer-codex 全 0 hits；user CLAUDE.md 1 hit 是「代替 5 步 Bash」（描述功能优势非历史包袱，grep 误命中，**不动**）
- reviewer-codex.md `§核心纪律` 1-11 编号顺序 + 3 处交叉引用 (#9/10/11) 全部对齐 ✅
- reviewer-claude.md `§核心纪律` 1-9 编号 + L18/L123 引用 #9 全部对齐 ✅
- 不动代码 → 无 typecheck / build 验证需求

## 关联 changelog

无（纯文档清理，本 review 内直接落地）。
