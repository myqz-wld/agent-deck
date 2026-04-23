<!--
此文件由 Agent Deck 应用打包并自动注入到每个 SDK 会话的 system prompt 末尾，
独立于 user/project/local CLAUDE.md（位置在三者之后）。
跟随 agent-deck 仓库走（git 管理），不依赖会话 cwd。

内容必须与 ~/.claude/CLAUDE.md 保持一致；改一处必须同步另一处。
-->

# 通用约定

## 输出

- 始终使用中文回复
- 不主动创建 .md 文件（除非明确要求）

## 运行时

- **Go**：项目用对应版本（gvm 管理）
- **Node / npm / pnpm / bun / npx**：一律走 `zsh -i -l -c "..."`（登录式 zsh 才能拿到 brew / path_helper 注入的 PATH，与真实 Terminal 一致）。禁止只 `-i`，禁止手动拼 PATH 或 source nvm.sh
- **macOS 没有 `timeout` / `gtimeout`**：禁止在 Bash 命令体里写 `timeout 5m ...` / `gtimeout ...`，会让整条命令（含分号 / 管道串起来的后续命令）一起 `command not found` 跟着崩。**超时只走 Bash 工具调用本身的 `timeout` 参数**（毫秒，上限 600000），任何阻塞命令都适用，不要被 Linux 习惯带偏

---

## 决策对抗

下结论 / 出 plan / 升级约定前必做。

**适用范围**（任一即触发）：
- 给代码下定性判断：bug / 优化 / code review / 安全 / 架构 / 根因
- 出执行计划（plan）
- 升级「约定 / 规范」到全局生效（如把 tally 候选升到项目 CLAUDE.md）
- 重要技术选型 / 重构方向决策
- **例外**：trivial 改动（typo / 样式数值 / 单点 rename / 显然措辞修订）

**操作**：并发两个**异构** Agent，各自读真实代码 / 资料给结论：

- **异构原则**：两个 Agent 必须**不同源**（不同 SDK / 不同模型 / 不同 reasoning 路径），最大化降低同源偏见
- **当前推荐配对**（稳定可用，不要随便降档）：
  - **Claude Code 会话内 subagent**（**Opus 4.7 xhigh**，`Explore` / `general-purpose`）
  - **Bash 调外部 codex CLI**（**gpt-5.4 xhigh**，模板见下）
- 两个都走「读真实代码 + 给证据 + 不复述」
- **三态裁决** ✅ 确认 / ❌ 反驳 / ⚠️ 部分。每条结论必须带 `文件:行号` + 代码 / 原文片段
- 最终清单标注被反驳 / 升降级条目；plan 场景标注双方一致 / 分歧步骤；约定升级场景额外评审措辞 / 边界 / 与已有约定的冲突
- **外部 Agent 不可用时**（CLI 失联 / `Reconnecting...` / 超时 / OAuth 过期 / 二进制缺失）：**不要自动降级**到同源双 Agent，**提示用户**「外部对抗 Agent 不可用（具体原因），是降级到同源双 Agent / 单方出结论 / 稍后重试？」由用户决定

### 外部 CLI 对抗 Agent 通用姿势

任何外部 CLI 当对抗 Agent 都遵循（codex CLI 细节见下小节，其他 CLI 类比）：

- **登录式 shell 包外层**（macOS：`zsh -i -l -c "..."`），否则缺 brew / nvm / path_helper PATH，与真实 Terminal 不一致
- **强制非交互模式**（一般是 `exec` / `--non-interactive` / `--batch`）
- **沙箱限只读 + 跳过 git repo 检查**（避免 CLI 在 repo 里乱 commit）
- **显式传项目绝对路径**（`-C` / `--cwd` / `--workdir`）
- **分离最终答案与日志**：CLI stdout 常是 banner + reasoning + final 混合（且 final 可能重复多次），用 `-o <FILE>` 把最终答案抓到独立文件
- **reasoning effort 取最高档**（review / plan / 探索类用最高档；简单 yes/no 核查可临时降档省时间，但**宁可慢别错**）
- **长 prompt 走 stdin**（避免 argv 长度 / shell 转义陷阱），prompt 里**写死要读的文件绝对路径**，不让 CLI 自由 grep / explore
- **多子问题拆并发或合并精简**，要求 yes/no + 一两行证据，不要大段结构化报告
- **超时只走 Bash 工具的 `timeout` 参数**（命令体内绝不写 `timeout` / `gtimeout`，见上 macOS 节）。重 review / 探索类给 5-10 分钟（300000-600000 ms），轻量核查 1-2 分钟即可

### codex CLI 模板

默认走 `~/.codex` 配置（模型 / approval / OAuth 都在那）：

```bash
OUT=$(mktemp); PROMPT=$(mktemp)
cat > "$PROMPT" <<'EOF'
... 你的 prompt ...
EOF
zsh -i -l -c "codex exec --sandbox read-only --skip-git-repo-check \
  -c model_reasoning_effort=\"xhigh\" \
  -C <REPO_ABS_PATH> -o '$OUT' - < '$PROMPT'"
cat "$OUT"; rm -f "$OUT" "$PROMPT"
```

Bash 工具调用时给 `timeout: 300000`，重 review 给 600000；轻量核查可降到 90000；reasoning effort 简单核查可降 `"low"`，宁可慢别错。

---

## 新项目工程地基

新建任何长期维护工程时，第一次提交就把这套结构建好，作为「工程地基」。

### 目录骨架

```
project-root/
├── CLAUDE.md                     # 项目专属约定（与 ~/.claude/CLAUDE.md 互补，不重复通用部分）
├── README.md                     # 功能总览（用户视角）
├── changelog/INDEX.md            # 一行表索引；CHANGELOG_X.md 第一次有变更时再建
├── reviews/INDEX.md              # 一行表索引；REVIEW_X.md 第一次 review 时再建
└── .claude/conventions-tally.md  # 自维护，不要手工删条目；用户反馈 / Agent 踩坑两 section
```

### README.md = 功能总览（用户视角）

不是开发者视角的实现细节。改完功能 3 问：

1. 改了**用户可见行为**？（UI / CLI / API / 设置项 / 快捷键 / 状态显示）→ 改对应章节
2. 改了**文件结构 / 新建模块**？→ 改「项目结构」节
3. 改了**启动方式 / 端口 / 依赖 / 验证步骤**？→ 改「开发与运行」节

纯 bug 修复 / 内部重构（不改用户感知）→ 不动 README，写 changelog 或 review。

### changelog/ + reviews/ 双轨

| 类型 | 写到 | 例子 |
|---|---|---|
| **功能变更**（新功能 / 行为修改 / API / 依赖升级） | `changelog/` | 新建 XXX、升级 SDK、加 CLI 命令 |
| **Debug / 性能 / 安全 review**（不引新功能，修问题或加固） | `reviews/` | code review 修复、TOCTOU、内存泄漏 |

**通用规则**：

- 文件名 `CHANGELOG_X.md` / `REVIEW_X.md`，X 递增整数。新建前 `ls` 找最大 X
- 小改动追加最新一条；大改动新建一条
- 同步更新对应 `INDEX.md`（一行表概要 ≤80 字）
- changelog 单文件：标题 + 概要（2-3 行）+ 变更内容（按模块 bullet）；**不要写「踩坑细节 / 推演过程」**——那些去 reviews
- reviews 单文件：触发场景 + 方法（双对抗 Agent 配对 / 范围 / 工具）+ 三态裁决清单（带 `文件:行号` + 代码片段）+ 修复条目 + 关联 changelog

**改功能前**：先 `ls changelog/ reviews/` + 浏览相关条目，了解历史决策、避免推翻已有约定 / 重复踩坑。

### 反复反馈 / 反复踩坑 → 升级约定

候选放 `.claude/conventions-tally.md`，count ≥ 3 升级到项目 `CLAUDE.md`。两类候选同一文件分 section：

| 类型 | 触发条件 |
|---|---|
| **用户反馈**（`# 用户反馈候选`） | 用户给「纠正性 / 偏好性」反馈：「不要…」「应该…」「我已经说过…」「以后…」「记住…」「每次…」 |
| **Agent 踩坑**（`# Agent 踩坑候选`） | Coding Agent 在 review / 修 bug 时**自己**发现踩了同类坑（典型：try/finally 漏 cleanup / TOCTOU / N+1 查询 / async listener 不被 await） |

**流程**：

1. 找语义相近的已有条目 → `count` +1 + 更新 `last_at`；没找到 → 新增（`count: 1`）
2. **count = 3** → 走「决策对抗」三态裁决，结论告诉用户后写入项目 `CLAUDE.md`「项目特定约定」节，从 tally 删该条
3. count < 3 → 静默更新 tally，不打扰用户

**边界**：不计一次性请求 / trivial 反馈；用户反馈必须是工程偏好 / 设计取舍 / 工作流偏好；Agent 踩坑必须是**模式化**问题。30 天未更新且 count < 3 → 下次扫描可清理。

---

## 模板

按 `<...>` 处替换 / 删除空白小节。前 4 份（CLAUDE.md / 各 INDEX / tally）新项目第一次提交时建；后 2 份（CHANGELOG / REVIEW）第一次有变更 / review 时按模板新建，不预生成空骨架。

### `CLAUDE.md`（项目根）

````markdown
# CLAUDE.md

> 给 Claude Code 在本仓库工作时的硬性约定。
> 通用约定（输出 / 运行时 / 决策对抗 / 外部 CLI / 工程地基）见 `~/.claude/CLAUDE.md`，本文件只放**项目专属**。

## 仓库基础

- OS / 包管理器：<例：macOS / pnpm 或 Linux / cargo 或 Windows / pip>
- 语言版本：<例：Node ≥ 18 / Go 1.22 / Python 3.11>
- 其他特殊环境约束：<可空，如必须用 docker compose up 起依赖>

## 项目特定触发

`~/.claude/CLAUDE.md`「新项目工程地基」节定义了通用「改动后必做」流程（README 三问 / changelog / reviews / 反馈升级），本文件只补**项目特定**触发：

- <例：改 main / preload 后必须重启 dev>
- <例：改 DB schema 必须新增 migration 文件 + bump user_version>
- <例：改 IPC channel 后 preload facade 必须同步>

## 项目特定约定（设计要点速查）

> 反复出现过的设计决定，改动前注意。初始为空，按 `.claude/conventions-tally.md` 升级流程积累。

<!-- 模式（每个主题一节）：

### <主题（鉴权 / 状态机 / 数据迁移 / IPC 边界 / 事件去重 / CSS 陷阱 ...）>

- 一句话要点 + 为什么（避免后续推翻）
- 反例 / 已知踩坑 / 关联 CHANGELOG 编号
-->

## 验证流程

```bash
<typecheck 命令>
<build 命令>
<test 命令>
```

修改 <main / preload / native module / config ...> 后必须 <重启 dev / 重新加载 / 重新编译>。

## 部署 / 打包（如有）

<可空。每个步骤建议带 `#` 注释解释根因，便于将来 review 不退化。打包配置已踩的坑列清单，每条带 CHANGELOG 编号。>
````

### `changelog/INDEX.md`

````markdown
# Changelog 索引

> **范围**：功能变更（新功能 / 行为修改 / API / 依赖升级）。Debug / 性能 / 安全 review 见 [`reviews/`](../reviews/INDEX.md)。

| 文件 | 概要（≤80 字） |
|------|------|
| [CHANGELOG_1.md](CHANGELOG_1.md) | <第一条变更概要> |
````

### `reviews/INDEX.md`

````markdown
# Reviews 索引

> 周期性 / 触发性的 debug、code review、性能 audit、安全审查报告。功能变更去 [`changelog/`](../changelog/INDEX.md)。

## 命名

`REVIEW_X.md`（X 递增整数，跟 `CHANGELOG_X.md` 对齐）。新建前 `ls reviews/` 找最大 X。

## 单文件结构

- 触发场景（用户主动 / 周期性 / 大重构前 ...）
- 方法（双对抗 Agent 配对、范围、工具）
- 三态裁决清单（✅ / ❌ / ⚠️）+ 证据（文件:行号 + 代码片段）
- 修复条目（按严重度）
- 关联 changelog（本轮修复落地的 CHANGELOG 编号）

## 索引

| 文件 | 主题 | 严重度分布 | 关联 changelog |
|------|------|-----------|----------------|
| <第一次 review 后填> | | | |
````

### `.claude/conventions-tally.md`

````markdown
# 项目约定候选（待观察）

> 由 Claude Code 自动维护。**不要手工删条目**。
> 流程见 `~/.claude/CLAUDE.md`「反复反馈 / 反复踩坑 → 升级约定」节。
> count ≥ 3 时走「决策对抗」三态裁决后升级到 [CLAUDE.md](../CLAUDE.md)「项目特定约定」节。

---

# 用户反馈候选

按 `count` 倒序。

| ID | 描述 | count | first_at | last_at | 触发样例 |
|----|------|-------|----------|---------|----------|

---

# Agent 踩坑候选

按 `count` 倒序。

| ID | 描述 | count | first_at | last_at | 触发样例 |
|----|------|-------|----------|---------|----------|
````

### `changelog/CHANGELOG_<X>.md`

````markdown
# CHANGELOG_<X>: <一句话标题>

## 概要

<2-3 行：这次改了什么 + 为什么。重点放「为什么」，方便日后翻 INDEX 秒懂动机>

## 变更内容

### <模块 / 层名（相对路径）>

- <要点 1>
- <要点 2>

### <模块 / 层名（相对路径）>

- ...

## 备注（可选）

<已知取舍 / 后续待办 / 关联 REVIEW 编号 / 升级路径暂不做的理由>
````

### `reviews/REVIEW_<X>.md`

````markdown
# REVIEW_<X>: <主题>

## 触发场景

<用户主动 / 周期性 / 大重构前 / 安全审查 ...，一两句说明动机>

## 方法

**双对抗配对**（见 `~/.claude/CLAUDE.md`「决策对抗」节）：
- <Agent A：模型 / reasoning effort / subagent 类型>
- <Agent B：模型 / reasoning effort / 超时设置>

**范围**：<N 个文件 / 模块清单 / 约多少行>

```
<具体文件清单>
```

**约束**：<已知不再列的问题（如「CHANGELOG 1-N 已修过的不要再列」）/ 输出格式 / 严重度分级 (HIGH/MED/LOW)>

## 三态裁决结果

### ✅ 真问题（双方独立提出 / 一方提出但现场核实成立）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|

### ⚠️ 部分（双方都看到现场但角度不同）

| 现场 | A 视角 | B 视角 | 结论 |
|---|---|---|---|

## 修复（CHANGELOG_<Y> 落地）

### HIGH
1. **<文件:行号>** — <一句话修复方案>

### MED
...

### LOW
...

## 关联 changelog

- [CHANGELOG_<Y>.md](../changelog/CHANGELOG_<Y>.md)：本次修复落地

## Agent 踩坑沉淀（如有）

本次 review 提炼出 N 条 agent-pitfall 候选（见 `.claude/conventions-tally.md`「Agent 踩坑候选」section）。同主题再撞 2 次会触发升级到 CLAUDE.md 项目约定。
````
