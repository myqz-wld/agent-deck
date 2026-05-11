<!--
此文件由宿主应用打包并自动注入到每个 SDK 会话的 system prompt 末尾，
独立于 user/project/local CLAUDE.md（位置在三者之后），跟随仓库走（git 管理），不依赖会话 cwd。

内容与 ~/.claude/CLAUDE.md 保持一致即可，改一处必须同步另一处。
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

**场景分流**（同样的「异构对抗 + 三态裁决」原则，按深度选实现路径）：

| 场景 | 走哪条 |
|---|---|
| **单次决策对抗**（1-2 个问题就够：单点判定 / plan 评审 / 约定升级）| 本节 §主路径 subagent —— 同步并发，零依赖，启动快 |
| **多轮深度 review**（多轮 review × fix 循环 + 反驳轮 + focus 切片）| `deep-code-review` skill 的 teammate 模式（如安装了对应 plugin）—— 跨轮 context 持久化、反驳轮被反驳方记得自己 R_N 推理链精准度更高 |

**三级兜底链**：teammate（skill 默认）→ subagent（plugin agents 可用，本节 §主路径）→ 手动并发（plugin agents 不可用，本节 §Fallback）。每级失败时可往下退，但同一场景最优解就一个，不要乱跨级。

> **subagent / skill 名字按 plugin 注入环境替换**：本节用裸名 `reviewer-claude` / `reviewer-codex` / `deep-code-review`。具体环境的全名取决于装在哪：user / project scope（`~/.claude/agents/<name>.md` / `.claude/agents/<name>.md`）→ 用裸名；某 plugin（`<plugin-root>/agents/<name>.md`）→ 实际名是 `<plugin-name>:<name>`。

### 主路径：spawn 异构 reviewer 双 agent

**操作**：在同一 message 中并发起两个 Task call：

1. `Task(subagent_type: "reviewer-claude", prompt: <scope + focus + skip>)`
2. `Task(subagent_type: "reviewer-codex",  prompt: <scope + focus + skip>)`

两个 reviewer 完全独立（subagent 之间互相不知道存在 / 不沟通），各自从代码 / 资料出发得结论 → 各自回到主 agent。

两份结论返回后，**当前主 agent**（不是 reviewer 自己）做三态裁决。

### 反驳轮（针对单方独有 + HIGH 候选）

裁决时遇到「**单方独有 + HIGH**」候选 finding → spawn **对方** reviewer 反驳：

- reviewer-claude 提出的给 reviewer-codex 反驳；reviewer-codex 提出的给 reviewer-claude 反驳（保持异构）
- 反驳 prompt 必须明禁「借机提其他 finding」，专注单点
- 同一条 finding 只反驳一次（避免循环）
- 反驳后主 agent 推到 ✅ / ❌ / 仍 ❓ → 主 agent 自己 grep / 写 test 现场验证 → 还不行降级非 HIGH

不触发反驳轮的情形（直接走裁决，不浪费 token）：
- 双方一致 → ✅
- 双方都看到现场但角度不同 → ❓ 综合
- 单方独有 + MED → 主 agent 自己验证
- 单方独有 + LOW/INFO → 直接列 ❓
- 双方都说没问题 → ✅ 可合

### 三态裁决（每条 finding）

- ✅ **真问题**：双方独立提出 / 一方提出**且现场实践验证成立**（grep 出 N 处证据 / 写小 test 复现挂掉 / 跑命令确认）→ 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，记反驳依据
- ❓ **部分 / 未验证**：双方角度不同 / 一方提出但纯文本推理（含弱断言 "可能 / 也许 / 看起来 / 应该 / 大概"）尚未实践验证 → 综合后决定；未验证的**强制降级为非 HIGH 严重度**

### 强制约束

- 每条结论必须带 `文件:行号` + 代码 / 原文片段 + **验证手段**（如 "grep 出 3 处全无 null check" / "写 stateful mock 模拟双 disconnect 实测 abort 0 次"）
- 空泛 finding + 没验证 = 直接降 ❓ 或 ❌
- **不接受没验证的 ✅ HIGH**
- 弱断言关键词只允许出现在标注 *未验证* 的条目里
- 最终清单标注被反驳 / 升降级条目；plan 场景标注双方一致 / 分歧步骤；约定升级场景额外评审措辞 / 边界 / 与已有约定的冲突

### reviewer-codex 失败兜底

reviewer-codex agent 内部已实现失败模板化（codex 二进制缺失 / OAuth 过期 / 超时 / `$OUT` 空 等场景各自的输出格式见 agent body）。主 agent 收到失败模板后**严禁**自动降级到同源双 Claude，必须**提示用户决策**：等恢复 / 单方 reviewer-claude 出结论 / 稍后重试 / abort。

### Fallback：手动并发（plugin agents 不可用时）

如果当前会话拿不到 reviewer-claude / reviewer-codex（典型：plugin 注入开关关掉、用户独立终端跑 `claude`、或非 SDK 通道），按下面手动模板并发——这是原始姿势的备份，agent 路径优先。

<details>
<summary>展开手动模板（agent 不可用时用）</summary>

**操作**：并发两个**异构** Agent，各自读真实代码 / 资料给结论：

- **异构原则**：两个 Agent 必须**不同源**（不同 SDK / 不同模型 / 不同 reasoning 路径），最大化降低同源偏见
- **当前推荐配对**（稳定可用，不要随便降档）：
  - **Claude Code 会话内 subagent**（**Opus 4.7 xhigh**，`Explore` / `general-purpose`）
  - **Bash 调外部 codex CLI**（**gpt-5.5 xhigh**，模板见下）
- 两个都走「读真实代码 + 给证据 + **优先实践验证**（grep 调用点 / 写小 test / 跑命令 / 读真实文件）+ 不复述」

#### 外部 CLI 对抗 Agent 通用姿势

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

#### codex CLI 模板

默认走 `~/.codex` 配置（模型 / approval / OAuth 都在那）：

```bash
OUT=$(mktemp); PROMPT=$(mktemp)
cat > "$PROMPT" <<'EOF'
... 你的 prompt ...

约束：
- 只读、不要写文件、不要 commit、用中文输出
- **能验证的优先实践验证**：grep 调用点 / 读真实文件 / 跑测试 / 跑命令（read-only sandbox 允许）
- 纯文本推理结论必须自标 *未验证*，并自降级为弱断言（❓ + 非 HIGH）
- 弱断言关键词（"可能 / 也许 / 看起来 / 应该 / 大概"）只允许出现在 *未验证* 条目里
EOF
zsh -i -l -c "codex exec --sandbox read-only --skip-git-repo-check \
  -c model_reasoning_effort=\"xhigh\" \
  -C <REPO_ABS_PATH> -o '$OUT' - < '$PROMPT'"
cat "$OUT"; rm -f "$OUT" "$PROMPT"
```

Bash 工具调用时给 `timeout: 300000`，重 review 给 600000；轻量核查可降到 90000；reasoning effort 简单核查可降 `"low"`，宁可慢别错。

**大任务必须拆小批 + 后台并发跑**（codex CLI 实证教训）：单 prompt 文件清单 ≥ 15 个 / 总长 ≥ 80 行 + reasoning xhigh 时，codex 容易卡在初步扫描阶段（`wc -l` / `ls`）10+ 分钟没动——根因是 xhigh "研究阶段" 在大 context 下会无限延长，不是真死锁，但等不到答案。**正确姿势**：

- 按主题 / 目录拆 ≤10 个文件一批，单批 prompt ≤30 行（文件清单 + 输出格式 + skip 项足够）
- 每批用 Bash 工具的 `run_in_background: true` 起，多批并发，等 `task-notification` 通知
- 单批仍给 `timeout: 600000`（拆批是降低 stuck 概率，不是降本批耗时）
- prompt 顶部明确「只看下面文件，不要再读 REVIEW_X.md / CLAUDE.md」避免 codex 自己拉一堆背景把 context 撑大
- skip 项写在 prompt 里（如「skip REVIEW_1 已修过的 8 处：...」），不要让 codex 自己去读 reviews/ 推断
- 真卡了就 `TaskStop` 中止 + 拆更小批重试，不要傻等

</details>

---

## Agent Teams

### Teammate 权限审批由真人在宿主 UI 操作，lead 别插手

chat 里看到 stringified JSON 含 `type='permission_request'`（CLI 把 inbox 协议消息当 user message 推给你）：别 SendMessage 劝 teammate 放弃 / 改方法 / abort，也别 SendMessage 回 `permission_response`（协议只支持 `shutdown / plan_approval`）。等真人在宿主 PendingTab 批，期间做其他不依赖该 teammate 该 tool call 的工作。

### TeamDelete 异步延迟，首次失败别误判为 bug

shutdown 完所有 teammate 后立刻 `TeamDelete` 经常报 `Cannot cleanup with N active member(s)`——CLI 内部异步移除 `config.json` members 实测延迟可达几分钟。等几分钟重试通常成功，期间做其他不依赖该 team 的事。

### Lead 关 teammate 只发 `shutdown_request`，**严禁**发 `shutdown_response` —— 自杀

- **唯一姿势**：lead 调 `SendMessage(to: "<teammate-name>", message: {type: "shutdown_request", reason: "<原因>"})`，每个 teammate 各发一次（同一 message 多个 SendMessage 并发起即可）。teammate 收到后 SDK 自动走 response 自终止，lead **完全不参与 response 环节**，等 inbox 收 `shutdown_approved` 通知 → 再 `TeamDelete`
- **为什么不能发 `shutdown_response`**：CLI v2.x 端 `SendMessage.validateInput` 强校验 `shutdown_response.to === "team-lead"`（协议设计：response 仅 teammate → lead 方向，approve 触发的是**响应方**自身的 abortController）
  - lead 发 `shutdown_response` 到 teammate → SendMessage 直接拒
  - lead 改投 `to: "team-lead"`（自己）「绕开校验」→ SDK 端 handler 拿到当前 caller 的 abortController 就是 lead 自己的 → **lead 自我 abort、整个会话 sdk-stream-ended、cleanup 现场死亡**（实测）
- **典型踩坑链**：lead 发自然语言「请 cleanup」给 teammate → teammate 反向 originate `shutdown_request` 求许可 → lead 误以为要「approve shutdown」于是发 `shutdown_response` → 自杀。绕过路径：lead 永远只发 `shutdown_request` 主动方向，不接 teammate 的反向 request

---

## 复杂 plan：worktree 隔离 + 跨会话 hand off

单会话上下文容量有限（200K-1M token，溢出触发 compaction 把旧信息压缩丢失）。**预计跨多会话**的 plan 必须在动手**前**就设计成两层隔离：

- **空间**：git worktree 锁**代码改动**在 `.claude/worktrees/<plan-id>/`，主分支代码区零污染（plan 元文件本身落 main repo 的 `.claude/plans/`，与代码区互不干扰；按需 `.gitignore`）
- **时间**：plan 文件保留跨会话进度 / 决策 / 下一步，新会话 cold start 直接接力，不靠聊天历史重建 mental model

不要等 context 70%+ 才临时抢救——那时 hand off 必然丢上下文，下一会话拿到的 plan 只是后半段。

### 触发（任一核心信号即走）

- **预计跨 ≥ 2 个会话才能收口**（综合判断：≥ 5 个非 trivial step / 跨多模块 / ≥ 数百行代码 / 当前会话已吃 ≥ 40-50% 上下文，看 `/context`）
- **破坏性 / 实验性改动，希望失败时整片回退**

「非 trivial」沿用「决策对抗」节的 trivial 例外（typo / 样式数值 / 单点 rename / 显然措辞修订）的反义。

### Step 1. EnterWorktree（空间隔离）

`EnterWorktree(name: "<plan-id>")` 进新 worktree（自动 `.claude/worktrees/<plan-id>/` + 新 branch）。所有代码改动 / 测试 / 验证全在 worktree 里跑。

> `EnterWorktree` 工具默认禁用（仅当用户或 CLAUDE.md 显式要求才用），**本节即显式授权** —— 触发条件命中时直接进 worktree，不用问用户。

`<plan-id>` 命名建议 `<topic>-<YYYYMMDD>`（如 `mcp-server-rollout-20260511`），与 §Step 2 plan 文件 stem 严格一致。**字符集限 `[A-Za-z0-9._-]`、单 segment ≤ 64 字符**（EnterWorktree 工具校验，超出会被拒）。

### Step 2. Plan 文件 hand off（时间隔离）

新建 plan 文件，**用 main repo 的绝对路径写入**（不要写到 worktree working tree——worktree 是独立 branch，跨会话 main repo 看不到该 branch 的文件）：

`<main-repo-abs-path>/.claude/plans/<plan-id>.md`

内容：

- frontmatter: `plan_id` / `created_at` / `worktree_path`（绝对路径）/ `status: in_progress|completed|abandoned`
- **总目标 & 不变量**：要解决什么 / 已定决策 / 不能违反的约束
- **设计决策（不再争论）**：每条带简短理由
- **步骤 checklist**：`- [x] Step N — done by <session> on <date>，commit <hash|uncommitted>` / 未完成步骤标状态 + 已知风险
- **当前进度**：卡在哪 / 已验什么 / 未验什么
- **下一会话第一步**：具体到「先 read X / 跑 Y / 改 Z」级别，**不要泛指**
- **已知踩坑**（可选）

### Step 3. 接力姿势

- **会话结束前必须**更新 plan：打勾完成步骤 + 写「当前进度」+ 写「下一会话第一步」。未更新就停 = 下次会话啃哑谜
- **退出 worktree** 一律用 `ExitWorktree(action: "keep")`——见 §Step 4 cleanup 解释
- **新会话开场**：先 `Read` plan 文件全文（main repo 路径） → `EnterWorktree(path: <plan frontmatter 的 worktree_path>)` 进同一 worktree → 按「下一会话第一步」直接动手；**不重新讨论已记录的设计决策**
- **决策变更**必须开场明示用户征得确认，不默默改方向

### Step 4. plan 完成 / 中止 cleanup

> ⚠️ `ExitWorktree(action: "remove")` **只对当前会话自己创建的 worktree 有效**；用 `path` 参数进入的现有 worktree 上 CLI validateInput 直接拒（errorCode 4，强制 `keep`）。跨会话场景下接力 session 全部走 `path` 进入，所以**统一**走 `keep` + Bash 手动 `git worktree remove`，避免分两条路径。

- **完成**：worktree branch 合回主分支 → frontmatter 置 `status: completed` → 把 plan 在 `changelog/CHANGELOG_X.md` 引用归档（不抄全，引用 plan 路径 + 关键 commits）→ `ExitWorktree(action: "keep")` → Bash `git worktree remove <worktree_path>` + `git branch -D worktree-<plan-id>`
- **中止**：frontmatter 置 `status: abandoned` + 中止理由 → `ExitWorktree(action: "keep")` → Bash `git worktree remove --force <worktree_path>` + `git branch -D worktree-<plan-id>`

### 与其他机制的关系

- **载体分工**：本节 plan 文件 = 跨会话设计文档（滚动）；`changelog/` = 实施完成存档（plan 完成后引用归档，不抄全）；`mcp__tasks__*` = 单会话进度可见性通道（绑 SDK Task Manager），互补
- **决策流程分工**：本节进 plan + worktree 双隔离是「机械触发」**不**走对抗；plan 内的设计决策（架构 / 选型）该走还得走，结论记入 plan「设计决策」节。`ExitPlanMode` 是「单次实施前与用户对齐」的工具，输出**设计内容**进 plan 文件「设计决策」节（不替代 plan 文件本身）

> 区分 "plan" 一词两种用法：(a) 决策对抗 / `ExitPlanMode` 节里的 "plan" 指**决策内容**（需评审）；(b) 本节 "plan 文件" 指 **hand off 载体**（机械产出，不评审），载体内若含设计决策走 (a)

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

**已审文件过期**（File-level Review Expiry）：

`reviews/` 不是「审过即终身豁免」。Agent 决定下一轮 review 范围时**必须**先扫所有 `reviews/REVIEW_*.md` 的机器可读 `review-scope`，建 `file → 最新 REVIEW_X` 映射；同一路径多次审取最新。某文件自其最近一次 REVIEW 的「覆盖基线」起，**任一**命中即过期：

- **净 churn** `≥ min(200 行, 当前文件 LOC 的 30%)`：`git diff -w --numstat <BASE> -- <file>` 的 add+del
- **distinct commit 数 ≥ 3**：`git log -w --format=%H <BASE>..HEAD -- <file> | sort -u | wc -l`
- **距覆盖 ≥ 90 天 且期间该文件至少有 1 次代码变更**
- **frontmatter `expired: true`**（人工兜底，公共 API 改了 / 安全假设失效凭经验置位）

`<BASE>` = 该 REVIEW.md 文件首次加入 git 的 commit，自动取，不写在 frontmatter 里：

```bash
BASE=$(git log --diff-filter=A --format=%H -n 1 -- reviews/REVIEW_X.md)
```

**rename / move / split 出来的新路径不继承旧路径已审状态**，按未审处理（路径边界一变最稳妥就是重审）。

**本轮 review 强制最小范围 = 未审 ∪ 已审过期 ∪ scope_unknown**（解析不出 scope 的旧 review 不能拿来当豁免依据）。Agent 可因上下文再扩范围，但**不能因「之前审过」跳过已过期文件**。

**默认硬合并，不问要不要并入**——这正是机制存在的意义。仅当合并后 > 20 文件 / > 6000 行时问「拆批 / 先审哪批」（不是问跳过）。用户主动选择跳过某过期文件需写入本份 REVIEW frontmatter 的 `skipped_expired` 备注（含原因）便于下次回查。

调阈值（200 / 3 / 90）属约定升级，走双对抗三态裁决；过期检查本身**不走**对抗（纯机械计算）。

**自检命令**（agent 在「下一轮 review」第一步必跑）：

```bash
# 1) 列出所有 REVIEW 及其 review-scope（一行一个相对路径）+ 覆盖基线 commit
for f in reviews/REVIEW_*.md; do
  BASE=$(git log --diff-filter=A --format=%H -n 1 -- "$f")
  awk '/^```review-scope$/{s=1; next} /^```$/{s=0} s' "$f" \
    | while read p; do echo -e "${p}\t${f}\t${BASE}"; done
done

# 2) 单文件过期判定（churn / commit / 时间）
file=src/main/foo.ts
git diff -w --numstat "$BASE" -- "$file" \
  | awk 'NF==3 {add+=$1; del+=$2} END {print "churn="add+del}'
git log -w --format=%H "$BASE..HEAD" -- "$file" | sort -u | wc -l   # commits
git log -1 --format=%cs -- reviews/REVIEW_X.md                       # 覆盖日期
```

**改功能前**：先 `ls changelog/ reviews/` + 浏览相关条目，了解历史决策、避免推翻已有约定 / 重复踩坑。

### 单文件大小护栏（≤ 500 行）

任何代码源文件 LOC > 500 行触发拆分尝试（不含测试 fixture / 自动生成的 migration / lock / snapshot 等机器产物）。每次改完该文件 / commit 前必做一次，按**风险升序**逐档选：

1. **抽 module-level 纯函数 / 类型 / 常量** —— 风险最低，先做。原文件只 import 回来，调用点零改动
2. **目录化 + 同目录 sub-module / sub-component** —— `foo.ts → foo/index.ts + foo/bar.ts`，多数语言的 module resolution 自动透传 import，外部调用方不用动
3. **拆 class（合作 class + facade 委托 + 共享 ctx ref）** —— 最重风险，class state ownership 重组属架构决策，必须走 plan + 「决策对抗」节流程

**真不能拆**（race 极复杂 / state ownership 高度耦合 / 强行拆收益 < 风险）→ 写到对应 CHANGELOG 的「不动文件保护清单」+ 注明理由（class 性质 / 单飞 / cross-cutting state ...），下次拆分轮直接跳过。**不能默认沉默忽略**——必须显式登记并说理，否则下次还会被同一文件的拆分尝试重复打断。

阈值（500 行）调整属约定升级，走「决策对抗」三态裁决；触发判定本身（行数 > 阈值）不走对抗，纯机械计算。

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
- 三态裁决清单（✅ / ❌ / ❓）+ 证据（文件:行号 + 代码片段）
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
---
review_id: <X>
reviewed_at: <YYYY-MM-DD>
expired: false               # 人工兜底；置 true 强制下轮重新纳入
skipped_expired:             # 本轮算出过期但被用户裁掉的（可空），写原因便于下次回查
  # - file: src/some.ts
  #   reason: 仅格式化 / 注释批量改
---

# REVIEW_<X>: <主题>

## 触发场景

<用户主动 / 周期性 / 大重构前 / 安全审查 ...，一两句说明动机；如本轮含「过期文件复审」请显式说明>

## 方法

**双对抗配对**（见 `~/.claude/CLAUDE.md`「决策对抗」节）：
- <Agent A：模型 / reasoning effort / subagent 类型>
- <Agent B：模型 / reasoning effort / 超时设置>

**范围**：<N 个文件 / 模块清单 / 约多少行>

```text
<给人读的范围摘要；可按模块分组 / brace expansion，可读性优先>
```

**机器可读范围**（File-level Review Expiry 用；一行一个仓库相对路径，按字典序、去重；禁止目录 / glob / brace expansion）：

```review-scope
src/main/foo.ts
src/main/bar.ts
```

> 本文件**首次加入 git** 的 commit 视为该批文件的覆盖基线（自动取，不写 hash）。请与本轮结论 / 关联修复一同落地，不要预先创建空 `REVIEW_<X>.md`。

**约束**：<已知不再列的问题（如「CHANGELOG 1-N 已修过的不要再列」）/ 输出格式 / 严重度分级 (HIGH/MED/LOW)>

## 三态裁决结果

> 本节遵循全局「决策对抗」节的验证纪律：每条 ✅ 必须带**验证手段**（grep / 写小 test / 跑命令 / 读真实代码），未验证的 finding 强制降级 ❓ + 非 HIGH。弱断言关键词（"可能 / 也许 / 看起来"）只允许出现在 *未验证* 条目里。

### ✅ 真问题（双方独立提出 / 一方提出且现场实践验证成立）

| # | 严重度 | 文件:行号 | 问题 | A | B | 验证手段 |
|---|---|---|---|---|---|---|

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据（验证手段 + 结论） |
|---|---|---|

### ❓ 部分 / 未验证（双方角度不同 / 一方提出但未实践验证）

| 现场 | A 视角 | B 视角 | 是否已验证 | 结论 |
|---|---|---|---|---|

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
