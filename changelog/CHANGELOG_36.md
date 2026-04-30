# CHANGELOG_36: agent-deck-plugin 注入对抗 reviewer agents + 决策对抗解耦

## 概要

把「决策对抗」机制的两个独立 reviewer（Claude 这一路 + codex CLI 这一路）封装成 agent-deck-plugin 提供的 subagent，调用方在同一 message 里起两个 Task call 即可获得真正异构的对抗证据；新增「反驳轮」机制（针对单方独有 + HIGH 候选）。同步改 `deep-code-review` skill 委托新 agent + 加 Step 2.5 反驳轮，从 277 行精简到 ~270 行（迁出对抗细节，加入反驳轮 + 委托）。两份 CLAUDE.md 决策对抗节同步更新，**解耦**：`~/.claude/CLAUDE.md`（用户全局）用裸名 `reviewer-claude` / `reviewer-codex` + 环境替换说明，`resources/claude-config/CLAUDE.md`（应用注入到 SDK 会话）用 `agent-deck:reviewer-claude` / `agent-deck:reviewer-codex` 全名（plugin 注入路径）。

为什么做：原方案让单 agent 内部 spawn 双 reviewer + 自己裁决 = 主体既是 reviewer 又是裁判，违反「异构对抗」原则。改成 2 个独立 subagent + 主 agent 调度裁决后，两份证据完全独立（subagent 之间不沟通），主 agent 才能拿到真正的对抗证据；反驳轮针对单方独有 HIGH 候选 spawn 对方 reviewer 求证，避免假阳性 / 漏报。

## 变更内容

### plugin agents 注入（新增能力，0 应用代码改动）

`@anthropic-ai/claude-agent-sdk` 的 plugin 协议（`plugins: [{ type: 'local', path }]`）原生支持 `<plugin>/agents/<name>.md` 子目录自动扫描（与 `skills/` 同模式）。本次第一次在 `agent-deck-plugin/` 下加 `agents/` 目录，SDK 自动以 `agent-deck:<agent-name>` 命名空间注册到每个 SDK 会话。注入开关复用现有的 `injectAgentDeckPlugin`（agents 是 plugin 一部分，不再分新 toggle）。

### `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`（新）

Claude 这一路对抗 reviewer（Opus 4.7）。两种 prompt 模式：

- **模式 A 全量 review**：输入 scope + focus + skip → 输出结构化 finding 列表
- **模式 B 反驳模式**：输入对方一条 finding → 独立判断同意/反对/不确定 + 证据，**专注单点禁止借机提其他 finding**

frontmatter：`tools: Read, Grep, Glob, Bash`（只读，无 Edit/Write/MultiEdit），`model: opus`。body 含验证纪律（能验证的优先实践验证 / 弱断言降级 / 文件:行号必带 / *未验证* 标记）+ 输出格式 + 重点维度速查 + 反模式 + 失败兜底。

### `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`（新）

Codex CLI 这一路 reviewer wrapper（`model: sonnet` — wrapper 不需要深度思考，省 token）。核心纪律：**不是 reviewer 是 wrapper**，搬运 codex gpt-5.5 xhigh 的结论，**codex 失败 = 直接报错给上层，绝不降级到自己 review**（同源 = 同盲区破坏异构原则）。

frontmatter：`tools: Bash, Read`（Bash 跑 codex；Read 取 codex 输出文件）。body 含：
- 完整 codex CLI 调用模板（zsh 登录 shell + sandbox=read-only + skip-git-repo-check + xhigh + `-o $OUT` + stdin prompt）
- 关键参数解释表（每个参数漏掉的后果）
- **大 scope 拆批跑**段（codex 实证教训：≥15 文件/≥80 行 + xhigh 容易卡在初步扫描；≤10 文件一批 + 后台并发 + 600000 timeout）
- 失败兜底模板化（codex 二进制缺失 / OAuth 过期 / 超时 / `$OUT` 空 / 其他错误 → 5 套输出模板让主 agent 直接转给用户决策）
- 调用前一句话自检 8 项

### `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`（重写）

skill 从「内联跑双 reviewer + 三态裁决」改造成**编排器**——委托给两个新 agent，本身只管多轮循环：

- **Step 2 并发 review**：改为同 message 起 `Task(agent-deck:reviewer-claude)` + `Task(agent-deck:reviewer-codex)`；prompt 模板用「scope + focus + skip + repo_abs_path」结构化字段；明确**不要在 prompt 里再写异构原则 / 验证纪律 / 弱断言降级**（已固化在 reviewer agent body 里）
- **Step 2.5 反驳轮**（新增）：触发条件矩阵（仅「单方独有 + HIGH」触发；其他类型直接走裁决不浪费 token）；做法：spawn **对方** reviewer 反驳，反驳 prompt 模板含「严禁借机提其他 finding」专注度约束；反驳后主 agent 推到 ✅/❌/❓
- 删除：原 `### 异构原则` 段、原 codex CLI 完整模板段（迁到 reviewer-codex.md body）、`### 三态裁决`详细规则部分（精简，agent 已固化）
- 收口报告新增「反驳轮触发: K 次（推到 ✅ X / ❌ Y / 仍 ❓ Z）」字段

### `resources/claude-config/CLAUDE.md`「决策对抗」节（重写）+ 头部注释

主路径切到「同 message 起 2 个 Task call (`agent-deck:reviewer-claude` + `agent-deck:reviewer-codex`)，主 agent 自己做三态裁决」；新增「反驳轮（针对单方独有 + HIGH 候选）」节；新增「reviewer-codex 失败兜底」节（强禁降级到同源双 Claude）；保留原手动并发模板 + codex CLI 模板 + 大任务拆批跑 → 折叠到 `<details>` 区块作为 fallback。

头部注释从「内容必须与 ~/.claude/CLAUDE.md 保持一致」改为「通用约定必须保持一致；决策对抗节是 agent-deck 应用专属扩展，本文件用全名 `agent-deck:*` / `~/.claude/CLAUDE.md` 用裸名 + 环境替换说明」。

### `~/.claude/CLAUDE.md`（用户全局，仓库 git 不跟踪）「决策对抗」节（重写）

与 `resources/claude-config/CLAUDE.md` 等价改造，但**不出现 `agent-deck` 字眼**（解耦：用户全局约定不绑定到具体应用）：

- 主路径用裸名 `reviewer-claude` / `reviewer-codex`
- 新增提示：「subagent 名字按环境替换」表（user/project scope = 裸名；plugin scope = `<plugin>:<name>`）
- 反驳轮节用通用「Claude subagent / codex CLI」描述（不引用具体 plugin 名）
- Fallback 折叠区命名改为「subagent 不可用时」（不绑定 agent-deck）

## 备注

- **0 应用代码改动**：plugin agents 注入是 SDK 协议原生支持，只需在 plugin 目录下加 `agents/` 子目录 + `<name>.md` 文件，无需改 `sdk-injection.ts` 或主进程代码
- **解耦设计**：`~/.claude/CLAUDE.md` 是跨项目通用约定，不绑定 agent-deck；`resources/claude-config/CLAUDE.md` 是 agent-deck 应用注入到 SDK 会话的，绑定 `agent-deck:*` 全名前缀（plugin 命名空间约定）
- **subagent 不互相沟通**（设计核心）：Task 工具 spawn 的 subagent 各自独立 context window，互相不知道存在；这正是「异构对抗」想要的——双方提供完全独立的证据，主 agent 才能拿到真正的对抗判断（不受锚定效应影响）
- **反驳轮触发收敛**：仅「单方独有 + HIGH」触发反驳；MED 主 agent 自验证；LOW/INFO 直接列 ❓；双方一致直接 ✅；双方都看到角度不同直接 ❓ 综合 → 反驳轮的 token 成本可控
- **真实 verify 方式**（用户重启 dev 后跑）：在 agent-deck SDK 会话里让 Claude `请 mention 名为 agent-deck:reviewer-claude 的 subagent` 看 SDK 是否报「subagent 不存在」错；不报就说明 plugin agents 自动加载成功
- 关联：本次只做 agent + 文档抽取，**不做 deep-code-review 多轮跑通的端到端验证**——验证是用户后续在真实 review 场景中触发；如果 agent body 有问题（输出格式不对 / codex 模板错误等）按 review 报告调整
- **Settings 文案 + JSDoc 同步**（小尾巴）：plugin 整体注入语义（skills + agents 绑定生效）原本在 UI 文案、`AppSettings.injectAgentDeckPlugin` JSDoc、`getAgentDeckPluginsForSession` JSDoc 三处都只提了 skill；同步改为「skill 与 agents 绑定生效，plugin 整体注入或整体不注入」，并在 SettingsDialog 副本里列出两类内容（含具体名字 `agent-deck:deep-code-review` / `agent-deck:reviewer-claude` / `agent-deck:reviewer-codex`）让用户清楚 toggle 影响的全部范围。typecheck 通过，无逻辑改动（plugin 注入函数本身已经是「整体放行 / 整体禁掉」语义）
