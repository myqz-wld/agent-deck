# CHANGELOG_44: deep-code-review skill 改 teammate 主流程 + subagent fallback

## 概要

`agent-deck:deep-code-review` skill 从「Task subagent 同步并发」主流程升级为「Agent Teams teammate sendMessage 多轮复用」主流程。subagent 模式保留作为 fallback（CLI < v2.1.32 / agentTeamsEnabled OFF / 非 SDK 会话）。

**为什么改**：deep-code-review 是 N 轮 + 反驳轮工作流，subagent 模式每轮 fresh context（重读所有文件 + 重建 mental model），teammate 模式 dormant 但 context 留着，下轮 sendMessage 直接复用——多轮场景下 token 实打实省 + 反驳轮精准度高一档（被反驳方记得自己上轮 finding 的完整推理链）。

**决策对抗**：本次升级走了双对抗（按 `~/.claude/CLAUDE.md`「升级约定 / 重要技术选型」要求）：
- Round 1 双 reviewer 都给 ❌ 不该改 —— 但事后用户挑战发现两处错误：(1) F2「codex adapter `canJoinTeam: false`」是误读，reviewer-codex 是 Claude Code wrapper teammate（claude-code adapter，canJoinTeam: true），内部仍 Bash 跑外部 codex CLI；(2) 漏掉了多轮反驳轮 context 持久化这个 teammate 独有真实 gain
- 重新评估后裁决翻为 ✅ 该改 —— gain 真实且只有 teammate 模式能拿到，loss（门槛 / cleanup bug）真实但权重比初评估低

## 变更内容

### `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`（重写主工作流）

- **frontmatter description** 改为「默认 Agent Teams 模式 + Fallback Task subagent」
- **§核心设计 / 异构对抗** 加「为什么 teammate 而不是 Task subagent」段：列三条独有 gain（多轮 context / 反驳轮精准度 / token 省）
- **§Step 0** 加「环境检测」表（CLI 版本 / agentTeamsEnabled / hook 装否），决定走 teammate 主流程还是 §Fallback。续接模式加 `teammate_alive` 字段判断与 v2.1.32 resume limitation 提醒（Anthropic 官方限制，不是 agent-deck 自加）
- **§Step 2** 重写：从「同 message 起两个 Task call」改为「lead 用自然语言指令 spawn 两个 teammate（in-process backend 自动起独立 SDK session）」+ `output_mode: full_review` 标记
- **§Step 2.5 反驳轮** 重写：从「spawn 对方 reviewer subagent」改为「sendMessage 对方 teammate（保持异构）」+ `output_mode: rebuttal` 标记 + 强调「不要 spawn 新 teammate 反驳，必须复用 Round 1 起的同一对」
- **§Step 5 进下一轮** 重写：明确「不要重新 spawn teammate」，sendMessage 复用 Round 1 起的同一对（teammate 模式核心 gain 的落地点）
- **§Step 6 收口** 加「teammate cleanup」节，含 [CHANGELOG_40](./CHANGELOG_40.md) force-cleanup 上游 bug 兜底指引
- **§关键约束** 加 2 条：「不要重新 spawn teammate」/「收口必须 cleanup teammate」
- **§常见反模式** 加 4 条 teammate-specific 反模式（重新 spawn / 反驳轮新 spawn / 没等 idle event / 忘 cleanup）
- **§与全局 CLAUDE.md 决策对抗节的关系** 更新：明确「单次决策对抗推荐 subagent，深度迭代化推荐 teammate」分工
- **新增 §Fallback：subagent 模式**：环境不满足时退回原 Task subagent 工作流，裁决逻辑 / 反驳轮触发条件 / 收口判定完全不变

### `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`（dual-mode body）

- **frontmatter description** 改为「subagent + teammate 双形态共用 body」
- **新增 §使用形态识别**：明确形态 A (subagent 一次性) vs 形态 B (teammate 持久化)，无论哪种行为约束完全相同
- **§核心纪律** 加第 6 条：「teammate 模式下也不要主动跟 reviewer-codex teammate 通信」
- **§输入识别** 模式 A 任务 1 加「teammate 模式 + Round 2+ 不必重读文件，直接用记忆中的 mental model」；模式 B 任务 1 加「teammate 模式有自己 R_N finding 的 self-context，反驳更有依据」
- **§反模式** 加 2 条 teammate-specific：「Round 2+ 又重读所有文件」/「主动跟 reviewer-codex teammate 通信」
- **§失败兜底** 加 teammate 模式专属：sendMessage 收到非 reviewer 任务时的处理

### `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`（dual-mode body）

- **frontmatter description** 改为「subagent + teammate 双形态共用 body」+ 强调「外部 codex CLI 进程仍 stateless，wrapper 这层在 teammate 模式有 in-memory context，新一轮把上轮 codex 输出作为 skip 字段塞进新 prompt」
- **新增 §使用形态识别**：明确「外部 codex 进程是 stateless 的，但 wrapper（teammate session）记得上轮 codex 输出」这个关键差别
- **§核心纪律** 加 2 条：第 6 条「teammate 模式 sendMessage 时把上轮 codex finding 摘要拼进新 prompt 的 skip 字段（避免外部 codex 重复列）但不替 codex 思考」/ 第 7 条「teammate 模式不要主动跟 reviewer-claude 通信」
- **§输入识别** 模式 A 加任务 2「teammate 模式 + Round 2+ 把 in-memory 上轮输出追加到 skip」+ 任务 6「保留本轮输出 in-memory 给下轮拼 skip 用」；模式 B 加任务 2「teammate 模式给 codex prompt 加 self-context 段（wrapper 上轮判断），让外部 codex 反驳更有针对性」
- **§codex CLI 调用模板** prompt 内 skip 字段加「teammate 模式 Round 2+ 追加 in-memory 上轮 finding 摘要」一行
- **§反模式** 加 3 条 teammate-specific
- **§一句话自检** 加最后一条：「teammate 模式 Round 2+：上轮 codex finding 摘要已追加到 skip 字段」

## 设计取舍

### 为什么保留 subagent fallback 而不是彻底替换

- **门槛回退**：CLI 老版本（< v2.1.32）/ 用户 agentTeamsEnabled OFF / 用户独立终端跑 `claude` 这三种场景下 teammate 不可用，但 subagent 仍能跑 — 不留 fallback 等于把 skill 可用性砍掉一半
- **零成本兼容**：reviewer-{claude,codex}.md 的 frontmatter 没动，Claude Code 仍然把它们注册为 subagent；body 同时支持两种形态共用，没有维护两份的负担
- **轻量场景**：单次决策对抗（全局 CLAUDE.md「决策对抗」节那种 1-2 个问题就够的场景）开 teammate 是 over-engineering，subagent 更轻；deep-code-review 多轮才是 teammate 的甜点

### 为什么 teammate 模式下还把上轮 codex 输出塞 skip

- 外部 codex CLI 进程是 stateless 的（每次 Bash 起新 codex exec，外部 codex 不记得上轮）
- 但 reviewer-codex teammate 这一层在 wrapper session 里有 in-memory context（teammate 模式核心特性）
- wrapper 把这个 context 转化为 codex prompt 的 skip 字段 — 等于「让 stateless codex 享受到 teammate context 持久化的间接好处」
- subagent 模式下 wrapper 没有这层 in-memory，无法享受这个间接好处

### resume limitation 的真实影响

- 这是 Anthropic v2.1.32+ Agent Teams 实验特性的官方明确限制（不是 agent-deck 自加，[sdk-bridge.ts:196-204](../../src/main/adapters/claude-code/sdk-bridge.ts#L196-L204) 的 throw 只是早一道防线避免 CLI 状态机崩溃）
- 对 deep-code-review 的实际影响：用户中断 lead 会话 + CLI 重启后，新 SDK 会话不能 attach 回原 team；但 `.deep-code-review/round-N.md` + `state.json` 都落盘了，重新 §Step 2 起新一对 teammate + 喂上轮 finding 摘要 + skip 字段就能续上工作流（损失的是 teammate 自己 R1 的 in-memory context，不是工作进度）
- 对比 subagent 模式：subagent 模式中断后续接也是重 spawn 重读所有文件，没本质差别

## 不做的事 / 仍是 follow-up

- ❌ 不强制升级（fallback subagent 模式继续工作，老 CLI 用户无感）
- ❌ 不动 reviewer-{claude,codex}.md 的 frontmatter（保证向后兼容；用户调 `Task(subagent_type: "agent-deck:reviewer-claude")` 仍能工作）
- ❌ 不改任何代码（这次只改 plugin 内 markdown 文件）
- 后续 follow-up：等 Anthropic v2.2+ 补 teammate `/resume` 支持后，可以把 [sdk-bridge.ts:199-204](../../src/main/adapters/claude-code/sdk-bridge.ts#L199-L204) 的 throw 放开，deep-code-review 中断恢复就能完整复用 teammate context

## 验证

```bash
# 三个文件改动只是 markdown，typecheck / test 不会受影响，但跑一遍确认主代码没被误碰
zsh -i -l -c "pnpm typecheck"
zsh -i -l -c "pnpm build"
```

实测路径（手动跑）：
1. agent-deck 应用内开 `agentTeamsEnabled` toggle
2. 新建 SDK 会话，cwd 选要 review 的项目，teamName 填 `dcr-test`
3. 输入 `/agent-deck:deep-code-review` 触发
4. 验证 lead spawn 两个 teammate（reviewer-claude / reviewer-codex），TeamHub 看到团队 + TeamDetail 看到成员
5. Round 1 完成后，让 lead 进 Round 2 — 应该 sendMessage 同一对 teammate 而不是重新 spawn
6. 反驳轮触发时，lead 应该 sendMessage 对方 teammate（不是 spawn 新 teammate）
7. 收口后 cleanup 两个 teammate；如卡住用 TeamDetail force-cleanup 兜底

## 关联

- 上游决策对抗轮：spawn Explore (Opus 4.7) + Bash 调外部 codex (gpt-5.5 xhigh) 双 reviewer，初判 ❌ → 用户挑战 + 现场 grep 验证 → 翻为 ✅
- 上游 team 机制：[CHANGELOG_35](./CHANGELOG_35.md)（M1 sessions.team_name + 实验特性 + resume limitation）/ [CHANGELOG_36](./CHANGELOG_36.md)（plugin agents 第一次注入）/ [CHANGELOG_39](./CHANGELOG_39.md)（M2 fs 视图）/ [CHANGELOG_40](./CHANGELOG_40.md)（M3 hook event + force-cleanup 兜底）
- 上游 task manager（teammate 协作 task list 用得上）：[CHANGELOG_42](./CHANGELOG_42.md) 地基 / [CHANGELOG_43](./CHANGELOG_43.md) sdk-bridge 集成

## 后续追加（同一 PR）

### reviewer-codex.md 强调 codex CLI 必须后台运行

- §codex CLI 调用模板 顶部新增「**默认必须 `run_in_background: true`**」段落 + 解释：
  - subagent 模式：阻塞主 agent 几分钟会锁死并发对抗，reviewer-claude 同时跑不了
  - teammate 模式：wrapper teammate session 后台跑才不阻塞 lead；wrapper 自己也能并发拆批跑多份 codex
- 反模式表新增第一条：「同步阻塞跑 codex（不用 `run_in_background`）→ 阻塞主 agent / lead 几分钟，破坏并发对抗」放在表首（最严重）
- §大 scope 拆批 节呼应：每批仍走 `run_in_background: true` 多批并发，等 task-notification

### 三文件精简（-22% 行数）

去重 + 合并冗余，行为约束完全不变：

| 文件 | 之前 | 之后 | 削减 |
|---|---|---|---|
| SKILL.md | 409 行 | 312 行 | -24% |
| reviewer-claude.md | 151 行 | 118 行 | -22% |
| reviewer-codex.md | 217 行 | 172 行 | -21% |
| **总计** | **777** | **602** | **-22%** |

主要精简手法：
- **§使用形态识别 A/B 合并为单表**：原本 reviewer-{claude,codex}.md 各自分两节（A subagent / B teammate）反复说「行为约束完全相同」，压成一个 4 列表格（形态 / 起法 / lifecycle / 上轮 context）+ 一句关键差别说明
- **删除 reviewer-codex §一句话自检 节**：与 §核心纪律 / §codex CLI 调用模板 / §反模式 三处重复列同样规则（zsh -i -l / sandbox / xhigh / -C / -o / stdin / timeout），删后只在反模式表保留违反场景
- **SKILL.md §核心设计 / 为什么 teammate 段落**：从 3 条独立 gain 解释（多轮 context / 反驳精准 / token 省）压成 1 句（这三件事本来就是同一个 gain 的三种表现）
- **SKILL.md §常见反模式表合并**：13 条 → 12 条（合并相似的「Round 2+ 重新 spawn / 反驳轮 spawn 新」为一条）
- **SKILL.md §示例触发**：4 条 → 2 条（保留最典型 + 失败兜底两条；其他变种归到 §Step 0 续接 / §Step 6 收口）
- **SKILL.md §与全局 CLAUDE.md 节**：3 段 → 2 行表格

行为对齐：所有原有约束、模板、反模式、失败兜底**全部保留**，删的只是重复表述。reviewer-claude / reviewer-codex frontmatter 完全不动（向后兼容 subagent 注册）。

### 验证

```bash
zsh -i -l -c "pnpm typecheck && pnpm build"   # ✅
```

### resources/claude-config/CLAUDE.md「决策对抗」节加「单次 vs 多轮」分流 + 三级兜底链

之前同一应用内 SDK 会话同时收到这两份 system prompt + skill：
- `resources/claude-config/CLAUDE.md`「决策对抗」§主路径 写「subagent」（适用单次决策对抗）
- 刚改的 `SKILL.md` frontmatter 写「默认 Agent Teams teammate 模式」（适用多轮深度 review）

两者**不矛盾**（不同场景不同最优解），但 Claude 看到「主路径 subagent」vs「默认 teammate」会困惑。在 `resources/claude-config/CLAUDE.md`「决策对抗」节顶部（line 53「### 主路径」之前）加 ~3 行分流指引明示：

```markdown
**场景分流**（同样的「异构对抗 + 三态裁决」原则，按深度选实现路径）：

| 场景 | 走哪条 |
|---|---|
| **单次决策对抗**（1-2 个问题就够：单点判定 / plan 评审 / 约定升级）| 本节 §主路径 subagent —— 同步并发，零依赖，启动快 |
| **多轮深度 review**（多轮 review × fix 循环 + 反驳轮 + focus 切片）| `/agent-deck:deep-code-review` skill 的 teammate 模式 —— 跨轮 context 持久化、反驳轮被反驳方记得自己 R_N 推理链精准度更高 |

**三级兜底链**：teammate（skill 默认）→ subagent（plugin agents 可用，本节 §主路径）→ 手动并发（plugin agents 不可用，本节 §Fallback）。每级失败时可往下退，但同一场景最优解就一个，不要乱跨级。
```

不动 `SKILL.md`（其 §与全局 CLAUDE.md 决策对抗节的关系 节早已写明分工，本次只是从 `resources/CLAUDE.md` 那一端也明示出来形成双向引用）。

### resources/claude-config/CLAUDE.md 去 agent-deck 字眼 + 命名走环境替换 pattern

跟 `~/.claude/CLAUDE.md` 措辞对齐，让两份 CLAUDE.md 都用「裸名 + 环境注释」的统一 pattern：

- 头注释 `**与 ~/.claude/CLAUDE.md 的关系**` 段重写：去掉「Agent Deck 应用」「agent-deck 应用专属扩展」「agent-deck:reviewer-claude / agent-deck:reviewer-codex 全名」这些自我引用，改为「subagent / skill 等具体调用名按 plugin 注入环境的命名空间替换」
- 决策对抗 §主路径：`Task(subagent_type: "agent-deck:reviewer-claude")` → `Task(subagent_type: "reviewer-claude")`（裸名）；同样改 reviewer-codex
- §Fallback 标题 `agent 不可用 / 不在 agent-deck SDK 会话内` → `plugin agents 不可用时`；body 同步去 agent-deck 字眼
- 场景分流表里 `/agent-deck:deep-code-review` → `deep-code-review`
- 加引述说明：「subagent / skill 名字按 plugin 注入环境替换：本节用裸名 `reviewer-claude` / `reviewer-codex` / `deep-code-review`。具体环境的全名取决于装在哪：user / project scope → 用裸名；某 plugin → 实际名是 `<plugin-name>:<name>`」（与 `~/.claude/CLAUDE.md` 同款表述）

验证：`grep "agent-deck" resources/claude-config/CLAUDE.md` 返回空。

### 同步 `~/.claude/CLAUDE.md` 加场景分流段

把刚加进 `resources/claude-config/CLAUDE.md` 的「场景分流表 + 三级兜底链」也加到 `~/.claude/CLAUDE.md`「决策对抗」节顶部（line 26 §主路径 之前），措辞完全对齐。两份 CLAUDE.md 现在都让 Claude 看到同样的「单次 vs 多轮」分流 + 三级兜底链指引。
