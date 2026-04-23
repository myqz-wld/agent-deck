<!--
此文件由 Agent Deck 应用打包并自动注入到每个 SDK 会话的 system prompt 末尾，
独立于 user/project/local CLAUDE.md（位置在三者之后）。
跟随 agent-deck 仓库走（git 管理），不依赖会话 cwd。

内容必须与 ~/.claude/CLAUDE.md 保持一致；改一处必须同步另一处。
-->

# 通用约定

## 输出

- 始终使用中文回复
- 不要主动创建 .md 文件（除非明确要求）

## 运行时

- **Go**：项目用对应版本（gvm 管理）
- **Node / npm / pnpm / bun / npx**：一律走 `zsh -i -l -c "..."`（登录式 zsh 才能拿到 brew / path_helper 注入的 PATH，与真实 Terminal 一致）。禁止只 `-i`，禁止手动拼 PATH 或 source nvm.sh
- **macOS 没有 `timeout` / `gtimeout` 命令**：禁止在 Bash 命令里写 `timeout 5m ...` / `gtimeout ...`，会让整条命令（含分号 / 管道串起来的后续命令）一起 `command not found` 跟着崩。**超时只走 Bash 工具调用本身的 `timeout` 参数**（毫秒，上限 600000）。任何阻塞命令都适用，不要被 Linux 习惯带偏

## 决策对抗（下结论 / 出 plan / 升级约定前必做）

**适用范围**（任一即触发）：
- 给代码下定性判断：bug / 优化 / code review / 安全 / 架构 / 根因
- 出执行计划（plan）
- **升级「约定」/「规范」到全局生效**（如把候选条目升到 CLAUDE.md 项目约定）
- 重要技术选型 / 重构方向决策
- **例外**：trivial 改动（typo / 样式数值 / 单点 rename / 显然措辞修订）

**操作**：并发两个独立异构 Agent，各自读真实代码 / 资料给结论：
- **异构原则**：两个 Agent 必须**不同源**（不同 SDK / 不同模型 / 不同 reasoning 路径），最大化降低同源偏见
- **当前推荐配对**（稳定可用，不要随便降档）：
  - **Claude Code 会话内 subagent**（**Opus 4.7 xhigh**，`Explore` / `general-purpose`）
  - **Bash 调外部 codex CLI**（**gpt-5.4 xhigh**，模板见下附录）
- 两个都走"读真实代码 + 给证据 + 不复述"
- **三态裁决**：✅ 确认 / ❌ 反驳 / ⚠️ 部分。每条结论必须带 `文件:行号` + 代码 / 原文片段，不准复述
- 最终清单标注被反驳 / 升降级条目；plan 场景标注哪些步骤双方一致、哪些有分歧；约定升级场景额外评审措辞 / 边界 / 与已有约定的冲突

**外部 Agent 不可用时**（CLI 失联 / `Reconnecting...` / 超时 / OAuth 过期 / 二进制缺失）：**不要自动降级**到同源双 Agent，**提示用户**「外部对抗 Agent 当前不可用（具体原因），是降级到同源双 Agent、单方出结论、还是稍后重试？」由用户决定

---

## 附录：外部 CLI 对抗 Agent 调用通用姿势

使用任何外部 CLI 作为对抗 Agent 时，注意几条通用工程姿势（具体到 codex CLI 的细节见下面小节，其他 CLI 类比）：

- **用登录式 shell 包外层**（macOS：`zsh -i -l -c "..."`），否则缺 brew / nvm / path_helper 注入的 PATH，与真实 Terminal 不一致
- **强制非交互模式**（一般是 `exec` / `--non-interactive` / `--batch` 之类 flag）
- **沙箱限只读 + 跳过 git repo 检查**（避免 CLI 在你的 repo 里乱 commit）
- **显式传项目绝对路径**（`-C` / `--cwd` / `--workdir`）
- **分离最终答案与日志**：很多 CLI 的 stdout 是 banner + reasoning + final 的混乱混合（且 final 可能重复多次），必须用 `-o <OUT_FILE>` 之类把最终答案抓到独立文件
- **reasoning effort 尽可能高**（review / plan / 探索类用最高档；简单 yes/no 核查可临时降档省时间，但**宁可慢别错**）
- **长 prompt 走 stdin**（避免 argv 长度限制和 shell 转义陷阱），prompt 里**写死要读的文件绝对路径**，不让 CLI 自由 grep / explore
- **多子问题拆并发或合并精简**，要求 yes/no + 一两行证据，不要大段结构化报告
- **超时只走 Bash 工具的 `timeout` 参数**（命令本体绝不能出现 `timeout` / `gtimeout`，见上 macOS 节）。重 review / 探索类给 5-10 分钟（300000-600000 ms），轻量核查 1-2 分钟即可

### codex CLI 具体姿势

如果对抗配对里用了 codex CLI（默认走 `~/.codex` 配置，模型 / approval / OAuth 等都在那里）：

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

（Bash 工具调用时给 `timeout: 300000`，重 review 给 600000；轻量核查可降到 90000；reasoning effort 简单核查可降 `"low"`，宁可慢别错）

---

## 项目工程规范（新建项目时应用）

新建任何长期维护的工程时，把以下 4 套机制带进项目根目录，作为"工程地基"。

### 1. README.md = 功能总览（用户视角）

不是开发者视角的实现细节。改完功能后判断要不要更新 README，3 个问题：

1. 新增 / 修改了**用户可见行为**？（UI / CLI / API / 设置项 / 快捷键 / 状态显示）→ 改对应章节
2. 改动了**文件结构 / 新建模块**？→ 改「项目结构」节
3. 改动了**启动方式 / 端口 / 依赖 / 验证步骤**？→ 改「开发与运行」节

纯 bug 修复 / 内部重构（不改用户感知）→ 不动 README，写 changelog 或 review。

### 2. changelog/ + reviews/ 双轨

| 类型 | 写到 | 例子 |
|---|---|---|
| **功能变更**（新功能 / 行为修改 / API / 依赖升级） | `changelog/` | 新建 XXX、升级 SDK、加 CLI 命令 |
| **Debug / 性能 / 安全 review**（不引入新功能，修问题或加固） | `reviews/` | code review 修复、TOCTOU、内存泄漏 |

**`changelog/` 规则**：
- 文件名 `CHANGELOG_X.md`，X 递增整数。新建前 `ls changelog/` 找最大 X
- 小改动追加到最新一条；大改动新建一条
- 同步更新 `changelog/INDEX.md`（一行表：`[CHANGELOG_X.md](CHANGELOG_X.md) | ≤80 字概要`）
- 单文件结构：标题 + 概要（2-3 行）+ 变更内容（按模块 bullet）
- **不要写"踩坑细节 / 推演过程"**——那些去 reviews/

**`reviews/` 规则**（命名跟 changelog 对齐）：
- 文件名 `REVIEW_X.md`，X 递增整数。新建前 `ls reviews/` 找最大 X
- 单文件结构：触发场景 + 方法（双对抗 Agent 配对 / 范围 / 工具）+ 三态裁决清单 + 修复条目 + 关联 changelog
- 同步更新 `reviews/INDEX.md`（表：`[REVIEW_X.md] | 主题 | 严重度分布 | 关联 changelog`）
- 触发：周期性 debug / code review / 性能 audit / 安全审查 / 大重构前的健康检查

**改功能前**：先 `ls changelog/ reviews/` + 浏览相关条目，了解历史决策、避免推翻已有约定 / 重复踩坑。

### 3. 反复反馈 / 反复踩坑 → 升级约定

候选放 `.claude/conventions-tally.md`，count ≥ 3 升级到项目 `CLAUDE.md`。**两类候选**（同一文件分 section）：

| 类型 | 触发条件 |
|---|---|
| **用户反馈** (`# 用户反馈候选`) | 用户给「纠正性 / 偏好性」反馈：「不要…」「应该…」「我已经说过…」「以后…」「记住…」「每次…」 |
| **Agent 踩坑** (`# Agent 踩坑候选`) | Coding Agent 在 review / 修 bug 时**自己**发现踩了同类坑（典型：try/finally 漏 cleanup、TOCTOU、N+1 查询、async listener 不被 await） |

**操作流程**：

1. 找语义相近的已有条目 → `count` +1 + 更新 `last_at`；没找到 → 新增（`count: 1`）
2. **count 达到 3** → 走「决策对抗」（升级约定也是适用范围之一）三态裁决，结论告诉用户后再升级写入项目 `CLAUDE.md`，从 tally 删该条
3. count < 3 → 静默更新 tally，不打扰用户

**边界**：不计一次性请求 / trivial 反馈；用户反馈必须是工程偏好 / 设计取舍 / 工作流偏好；Agent 踩坑必须是**模式化**问题（一类问题反复出现），不是单点 bug。30 天未更新且 count < 3 → 下次扫描可主动清理。

### 4. 项目根目录骨架

新项目第一次提交就把这套结构建好：

```
project-root/
├── CLAUDE.md                      # 项目专属约定（与 ~/.claude/CLAUDE.md 互补，不重复通用部分）
├── README.md                      # 功能总览（用户视角）
├── changelog/
│   └── INDEX.md                   # 一行表概要；CHANGELOG_X.md 第一次有变更时再建
├── reviews/
│   └── INDEX.md                   # 一行表概要；REVIEW_X.md 第一次 review 时再建
└── .claude/
    └── conventions-tally.md       # 自维护，不要手工删条目；用户反馈 / Agent 踩坑两 section
```

项目 `CLAUDE.md` 只放**项目专属**约定（设计取舍速查、踩坑预防、验证流程、打包部署等），通用约定（输出语言 / 运行时 / 决策对抗 / 外部 CLI 模板）走 `~/.claude/CLAUDE.md` 不重复。

### 5. 项目 CLAUDE.md / 各 INDEX.md 初始模板

新项目第一次提交时直接复制这几份骨架，按尖括号 `<...>` 处替换 / 删除空白小节即可。

#### `CLAUDE.md`（项目根目录）

````markdown
# CLAUDE.md

> 给 Claude Code 在本仓库工作时的硬性约定。
>
> 通用约定（输出语言 / 运行时 / 决策对抗 / 外部 CLI 模板 / 项目工程规范）见 `~/.claude/CLAUDE.md`，本文件只放**项目专属**约定。

## 仓库基础

- 操作系统 / 包管理器：<例：macOS / pnpm 或 Linux / cargo 或 Windows / pip>
- 语言版本：<例：Node ≥ 18 / Go 1.22 / Python 3.11>
- 其他特殊环境约束：<可空，如必须用 docker compose up 起依赖>

## 改动后必做

按 `~/.claude/CLAUDE.md`「项目工程规范」节走（README 三问 / changelog / reviews / 反馈升级），本文件不重复流程，只补**项目特定**触发：

- <例：改 main 进程后必须重启 dev>
- <例：改 DB schema 必须新增 migration 文件>

## 项目特定约定（设计要点速查）

> 反复出现过的设计决定，改动前注意。初始为空，随开发积累。

<!-- 模式：
### <主题（如：鉴权 / 数据迁移 / 状态机 / IPC 边界 / CSS 陷阱 ...）>
- 一句话要点 + 为什么（避免后续推翻）
-->

## 验证流程

```bash
<typecheck 命令>
<build 命令>
<test 命令>
```

修改 <main / preload / config / native module ...> 后必须 <重启 dev / 重新加载 / 重新编译>。

## 部署 / 打包（如有）

<可空，按需。打包步骤 / 签名 / 发布渠道 / 已踩的坑清单>
````

#### `changelog/INDEX.md`

````markdown
# Changelog 索引

> **范围**：功能变更（新功能 / 行为修改 / API / 依赖升级）。
> Debug / 性能 / 安全 review 见 [`reviews/`](../reviews/INDEX.md)。

| 文件 | 概要（≤80 字） |
|------|------|
| [CHANGELOG_1.md](CHANGELOG_1.md) | <第一条变更概要> |
````

#### `reviews/INDEX.md`

````markdown
# Reviews 索引

> 周期性 / 触发性的 debug、code review、性能 audit、安全审查报告。功能变更去 [`changelog/`](../changelog/INDEX.md)。

## 命名

`REVIEW_X.md`（X 递增整数，跟 `CHANGELOG_X.md` 对齐）。新建前 `ls reviews/` 找最大 X。

## 单文件结构

- 触发场景 / 方法（双对抗 Agent 配对 / 范围 / 工具）
- 三态裁决清单（✅ / ❌ / ⚠️）+ 证据（文件:行号 + 代码片段）
- 修复条目（按严重度）/ 关联 changelog

## 索引表

| 文件 | 主题 | 严重度分布 | 关联 changelog |
|------|------|-----------|----------------|
| <第一次 review 后填> | | | |
````

#### `.claude/conventions-tally.md`

````markdown
# 项目约定候选（待观察）

> 此文件由 Claude Code 自动维护。**不要手工删条目**。
> 流程见 `~/.claude/CLAUDE.md`「项目工程规范 → 反复反馈 / 反复踩坑 → 升级约定」节。
> count ≥ 3 时走「决策对抗」三态裁决后升级到项目 [CLAUDE.md](../CLAUDE.md) 「项目特定约定」节。

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

#### `changelog/CHANGELOG_1.md` / `reviews/REVIEW_1.md`

第一次真实需要时再建，按 `~/.claude/CLAUDE.md`「项目工程规范」节描述的单文件结构写。空骨架不预先生成。
