---
plan_id: prompt-asset-review-optimize-20260527
created_at: 2026-05-27
status: completed
completed_at: 2026-05-27
base_branch: main
base_commit: 03f2150
worktree_path: null
---

# Plan: 提示词资产对抗 review 优化

> 简化版工作流（不进 worktree，主仓库直接改 + plan 跟踪 + 决策对抗 review plan + user confirm + 收尾 commit）。

## 总目标

按用户 4 条需求重整提示词资产 SSOT 边界：

1. **应用内 CLAUDE.md self-contained**：不依赖 user CLAUDE.md（inline 全部依赖）
2. **user CLAUDE.md 解耦应用**：不提及应用内 CLAUDE.md（保持通用）
3. **agent-deck 优先级 < user**：在 agent-deck CLAUDE.md 头部加显式声明「user CLAUDE.md 优先级高于本文件，冲突时以 user 为准」（语义修法，spike 已证明 SDK 无物理 prepend）
4. **精简**：信息密度优先（按 §提示词资产维护 5 条硬约束 + 5 步自检）

## 不变量

1. **SDK 字段不动**：仍走 `systemPrompt: { type:'preset', preset:'claude_code', append }` + `settingSources: ['user','project','local']`。**Why**：spike1 实证 SDK 0.3.144 无 prepend 字段，string 形式整段替换 preset 会丢 baseline（safety / tools / env）+ 维护成本不可承受
2. **应用 CLAUDE.md 头部统一声明**：claude-config / codex-config 两份都加同款优先级声明节，措辞与角色对齐（claude 视角 / codex 视角分别表述但含义等价）
3. **inline 不等于复制粘贴**：从 user CLAUDE.md inline 内容时按本应用场景重新组织语言，去掉与 agent-deck 无关的通用约定细节（如 §运行时 §macOS timeout 等与 SDK 注入会话无关项）
4. **保留 reviewer agent body inline 协议**：reviewer body 已 inline 「核心纪律 / 输入识别 / 输出格式 / 重点维度 / 反模式 / 失败兜底」satisfies plugin self-contained；本次只调整对 user / app CLAUDE.md 的 reference，不重写 reviewer body 协议层
5. **不动外部 CLI 模板**：`~/.claude/templates/reviewer-{claude,codex}.sh.tmpl` 与单次决策对抗主路径绑定，与应用 SDK 注入无关 — 本次 scope 不含。**已 grep 验证** `.sh.tmpl` 现有措辞已是「示例参考 agent-deck 项目实例」(不绑死)无需改
6. **项目根 `agent-deck/CLAUDE.md` 纳入 scope**（v3 更新）：项目根 CLAUDE.md 248 行与应用 §新项目工程地基 节多处重叠（§README 维护 / §changelogs+reviews 双轨 / §单文件 500 行护栏 / §反复反馈升级），本次一并整合（详 D5）。**项目专属节** 保留：§仓库基础 / §项目特定约定 / §验证流程 / §打包与本地安装

## 设计决策（不再争论）

### D1：需求 3 实现路径 — 语义修法（Path A 升级版）

来源：RFC Q1 → spike1 → user 选 「语义修法」

- 不改 SDK 字段，仍 `systemPrompt: { type:'preset', preset:'claude_code', append }`
- **claude 端** agent-deck CLAUDE.md 头部加节（措辞示例）：
  > **优先级声明**：本文件是 agent-deck 应用环境的 baseline 约定。如同时加载了 user CLAUDE.md（`~/.claude/CLAUDE.md`），user CLAUDE.md 中的约定**优先级高于本文件**；与本文件冲突时**以 user CLAUDE.md 为准**。本文件提供的能力（mcp tool / plugin SKILL / cold-start 协议等）是 agent-deck 应用专属补充，不替换 user 通用约定。**但 SDK preset 内置安全约束（IMPORTANT 节）始终最高优先级**，本文件 + user CLAUDE.md 都不替代。优先级链：SDK preset 安全约束 > user CLAUDE.md > 本文件
- **codex 端** CODEX_AGENTS.md 头部加节（v5 修订 — 补 `~/.codex/AGENTS.md` marker 外用户段语义；v4 已去掉「user 级 AGENTS.md 全局节」未验证假设）：
  > **优先级声明**：本文件是 agent-deck 应用环境的 baseline 约定（codex 视角，注入 `~/.codex/AGENTS.md` 内由 Agent Deck installer marker 包裹的段）。codex SDK 内置安全约束（sandbox / approval policy / system rules）**始终最高优先级**，本文件不替代。**developer message / per-turn user prompt 中的指令优先级高于本文件 baseline**；与本文件冲突时**以 caller 当下指令为准**。如 `~/.codex/AGENTS.md` 内有 marker 之外的用户自加段，**该用户段与本文件 baseline 平等加载到 codex system prompt**（同 baseline 层级，无强优先级关系；与本文件冲突时建议 user 显式选边或重审约定一致性）。本文件提供的能力（mcp tool / plugin SKILL / cold-start 协议等）是 agent-deck 应用专属补充

⚠️ v4 → v5 修订（claude *未验证-2*）：补「`~/.codex/AGENTS.md` marker 外用户段」加载语义（实测 `src/main/codex-config/agents-md-installer.ts` 有 marker pattern 让 user 在 marker 之外加段，该段与 Agent Deck baseline 段平等加载）— 避免 user 加段时不知优先级关系

⚠️ v4 修订（claude *未验证-1*）：codex 端措辞**移除** v3「user 级 AGENTS.md 优先」表述 — codex SDK 加载链中 `~/.codex/AGENTS.md` = 本应用 build-time installer 写入本文件本身（详 `src/main/codex-config/agents-md-installer.ts`），不存在独立 user 级 AGENTS.md 合并机制；改用「caller 当下指令（developer message / per-turn user prompt）优先于本文件 baseline」精确表述

### D2：需求 1 实现 — inline 全部 user 依赖（分两类 ref 分流）

来源：RFC Q2 → user 选「inline 全部依赖」+ review HIGH-1+2 修正

**⚠️ Review 关键修正**：现 `resources/claude-config/CLAUDE.md` 多处「user CLAUDE.md §X」字样**不全是真 cross-ref**，部分是**误命名为 user 的本文件 self-ref**。grep 验证：user CLAUDE.md 117 行只有 §通用约定 / §决策对抗 / §提示词资产维护 三大节，**无** §Step 1/2/3/4 / §复杂 plan / §EnterWorktree / §archive_plan 节 — 这些节物理位置都在 **app-claude-config-claude.md 自己内部** §复杂 plan workflow（L169-356）。

**修订**：D2 分两类 ref 分流处理：

**Type (a) — 真 cross-ref 指向 user 真实节**（user 真有对应内容）：
- §应用环境差异 节首段「与 user CLAUDE.md 互补不冲突」→ 重写为 self-contained 描述（不提互补）
- L44「user CLAUDE.md 默认机制（原生 TaskCreate/TaskUpdate）」→ inline 简短「原生 TaskCreate/TaskUpdate 是 Claude Code CLI 内置」
- L50「通用 user CLAUDE.md §reviewer-codex 失败兜底「严禁同源化降级」」→ inline 改写措辞（不逐字粘贴，重新组织成应用视角；保留原「严禁」字面强度）
- L97「详 user CLAUDE.md §提示词资产维护 约束 1 SSOT」→ inline 一句话「SSOT 单源不复制」

**Type (b) — 误命名 user 实指本文件 self-ref**（必修 — review HIGH-2）：
- L566「user CLAUDE.md §Step 2 EnterWorktree §EnterWorktree CLI stale base bug」→ 改「**详本文件** §Step 2 §EnterWorktree CLI stale base bug callout」
- L574 / L584 「user CLAUDE §Step 4」→ 改「**详本文件** §Step 4」
- L595 「user CLAUDE.md §Step 4 5 步手工归档」→ 改「**详本文件** §Step 4 §完成 5 步」
- L606 同款
- L629 「user CLAUDE §Step 3」→ 改「**详本文件** §Step 3」
- L635 「详细约定见本应用打包 CLAUDE.md §复杂 plan workflow §Step 3 接力姿势节」→ 已对，但「本应用打包 CLAUDE.md」措辞累赘，改「**详本文件** §Step 3 接力姿势节」

**共享 SSOT 规则**：
- 本应用 CLAUDE.md 与 user CLAUDE.md **不再保持双 SSOT 关系**
- 共享主题（如同源化禁令）inline 时**重新组织措辞**（不逐字粘贴），保留 user 那份作为通用 SSOT 不被本应用引用（符合不变量 3「inline 不等于复制粘贴」）
- 应用 CLAUDE.md 围绕「agent-deck 应用环境」组织，user CLAUDE.md 围绕「通用工程实践」组织

### D3：需求 2 实现 — user CLAUDE.md 去应用引用

来源：RFC Q2 → user 选「inline 全部依赖」（含 user 解耦）

- 当前 `~/.claude/CLAUDE.md` 117 行未直接提 agent-deck。grep 命中「应用 / SKILL / teammate / SDK 内」4 处都是**抽象描述**（不是直接绑死 agent-deck），符合需求 2「不提应用」可保留：
  - L32 §决策对抗 表「应用环境若提供多轮 review 编排能力（teammate / SKILL 模式）则走之」
  - L41 callout「SDK 内可能挂载的同名 `reviewer-{claude,codex}` agent body（teammate 模式，属环境专属编排）」
  - L88 §reviewer-codex 失败兜底「环境若提供多轮 review 编排能力（teammate / SKILL 模式），可能在该环境内 SKILL 定义『合规兜底』分支」
  - L96 §提示词资产维护 适用范围「会注入模型的 tool description」
- ⚠️ `~/.claude/CLAUDE.md` 删除/精简属 user 全局资产改动；展示形式 = 完整 diff patch + 按节分组列每节改动总结，user 可按节 approve / reject

⚠️ Review 修正（H1+LOW-3）：原 D3 第二点「`.sh.tmpl` 注释改通用『项目实例参考』措辞不绑死 agent-deck」**已撤销** — 实测 .sh.tmpl L8-9 已是「示例参考 agent-deck 项目实例」措辞**已合规**无需改 + 与不变量 5「不动外部 CLI 模板」冲突

### D5：项目根 `agent-deck/CLAUDE.md` 处理（v3 新增）

来源：v2 review 后 user 加 scope

**Why**：项目根 CLAUDE.md 248 行与应用 §新项目工程地基 节多处重叠（README 维护 / changelogs+reviews 双轨 / 单文件 500 行护栏 / 反复反馈升级机制）。不处理 → 应用精简后两份 SSOT 漂移；放任不管 → 不变量 6 删了「不动项目根」的事实需要面对。

**节分类清单**：

**项目专属节**（**必保留**项目根 — 应用 CLAUDE.md 不该有项目专属内容）：
- §仓库基础（macOS / pnpm / Node ≥ 18）
- §项目特定约定（鉴权与会话边界 / Teammate 权限边界 / 事件去重 / 会话恢复 / 总结调度 / IPC 边界 / 资源清理 / 弃用字段 / 毛玻璃 CSS）
- §验证流程（pnpm typecheck / 重启 dev / pkill 命令）
- §打包与本地安装（pnpm dist / electron-builder / SDK binary 踩坑）

**与应用 §新项目工程地基 重叠节**（**整合**）：
- §改动后必做 §1 README.md 维护
- §改动后必做 §2 写 changelog 或 review
- §改动后必做 §3 改功能前先读 changelog + reviews
- §改动后必做 §4 单文件 ≤ 500 行
- §反复反馈 / 反复踩坑 → 升级约定

**整合策略**（v5 修订 — 双方独立 M1 finding）：项目根 CLAUDE.md 重叠节**压缩为关键约束 bullet**（保留普通终端 `claude` 跑 agent-deck 项目时**最低操作指南**让 user 不失去基本约定）。callout cross-ref 目的地按主题精确区分（**不再统一指 user CLAUDE.md** — 实测 user CLAUDE.md 117 行不承载这些主题）：

| 主题 | 详细约定位置 | cross-ref 目的地（普通 claude 端） |
|---|---|---|
| 单文件 ≤ 500 行护栏 | `~/.claude/SOPs/file-size-guardrail.md`（真实存在）+ 应用 CLAUDE.md §单文件大小护栏 | `~/.claude/SOPs/file-size-guardrail.md` |
| README 维护 / changelogs+reviews 双轨 / 反复反馈升级 | **应用 CLAUDE.md §新项目工程地基（仅应用 SDK 会话加载）+ 本项目根文件的最低操作指南**（user CLAUDE.md / SOPs 无等价物） | **不**对外 cross-ref — 直接在本文件保留最低操作指南；应用 SDK 会话内额外加载应用打包 CLAUDE.md §新项目工程地基 |

**项目根 CLAUDE.md 头部 callout 措辞示例**（v5 修订 — M1 修法 + LOW-2 资源指针）：
> 本文件保留 **agent-deck 项目专属 design invariant**（§项目特定约定 / §仓库基础 / §验证流程 / §打包与本地安装）+ **通用工程约定的最低操作指南**（§改动后必做 §1-4 / §反复反馈升级 — 这三块在 user CLAUDE.md / SOPs 无等价 SSOT，本文件保留最低指南给普通终端 claude；应用 SDK 会话内额外加载应用打包 CLAUDE.md §新项目工程地基 获取详细约定）。**单文件 ≤ 500 行护栏** 详见 `~/.claude/SOPs/file-size-guardrail.md`。另：仓库内 `resources/claude-config/CLAUDE.md` 是应用打包后注入 SDK 会话的应用级约定，与本文件独立维护。

⚠️ v4 → v5 修订（双方独立 M1 finding）callout 目的地精确化：
- 项目根 CLAUDE.md 改动**同时影响**应用 SDK 会话（settingSources='project' 加载）+ 普通终端 `claude` 跑 agent-deck 项目场景
- callout 不再统一指「user CLAUDE.md」 — 实测 user CLAUDE.md 117 行**不承载** §README 维护 / §changelog 双轨 / §反复反馈升级 三块详细约定；仅 §单文件 500 行护栏可指 SOPs
- 这三块在 user 端**没有** user-loadable 等价 SSOT — 本文件保留最低操作指南就是 SSOT 主指针；应用 SDK 会话内额外加载应用 CLAUDE.md 详述节是补充
- 压缩 bullet 必须保留**最低操作指南**让普通 claude 在项目下不失去基本约定

参照 user CLAUDE.md §提示词资产维护 5 条硬约束 + 5 步自检：

- 约束 1 信息密度：grep `<关键短语>` 命中 ≥ 2 处即合并
- 约束 2 当前事实不写兼容/预测：grep `兼容|FUTURE|TODO|未来|向后|deprecated|过渡期|老版本` 命中 → **人工分类**：未来预测/兼容噪音 → 删；当前状态枚举（plantUML INDEX 用 active/deprecated/draft）/ 迁移边界（Breaking 历史）/ 恢复语义 → **保留并压缩**
- 约束 3 可执行性 > 描述性：grep `建议|应该考虑|最好|可以(用|走|考虑)|大概率?|通常|一般` 命中 → 改可执行（user §约束 3 同款完整模板，含模糊副词）
- 约束 4 范围与失败兜底显式：每节有「何时适用 / 失败走哪」
- 约束 5 示例克制：3+ 个同款示例 → 删 2/3

⚠️ Review 修正（M6）：约束 2 不再机械删 grep 命中（plantUML INDEX 状态字段 `deprecated` / Breaking 历史是当前事实非「兼容废话」） — 人工分类
⚠️ Review 修正（M4）：约束 3 grep 模板补齐为 user §约束 3 完整版，加「大概率? / 通常 / 一般」模糊副词

精简幅度目标（按 5 步自检走完，能压多少压多少；以下数字仅 spot-check 上限）：
- `claude-config/CLAUDE.md` 649 行 → 期望 < 500 行（约 -23%）；空间在历史 plan id 引用 / Breaking 历史压缩 / 三态分流 task policy 重复段合并
- `codex-config/CODEX_AGENTS.md` 247 行 → 期望 < 240 行（**容忍 -10% 上限**，避免越压越掉关键 codex 差异点 — 如 `~/.codex/AGENTS.md` 加载 / sandbox / per-session token / 无 native EnterWorktree 等必要冗余）
- SKILL / agent body：检查 reference user / inline 短引用 + 精简反例 + 合并重复段

## 步骤 checklist

- [x] Step 1：决策对抗 review 本 plan（双 Bash 起外部 CLI 评审 plan 文件本身）— **3 轮 review** 完成：v1 出 2 HIGH + 6 MED 修到 v2；v3 加 scope 重审 0 HIGH + 3 MED 修到 v4；v4 重审 0 HIGH + 2 MED 修到 v5；当前 v5 0 HIGH 0 真 MED 可收口
- [ ] Step 2：user confirm v5（看 review finding + 修订 plan，明确允许进 Step 3 起改）
- [ ] Step 3：改 `resources/claude-config/CLAUDE.md`：
  - [ ] 3.1 头部加 D1 优先级声明节（claude 视角措辞）
  - [ ] 3.2 grep `user CLAUDE.md` 命中按 D2 (a)/(b) 分流处理：(a) inline 替代 / (b) 改本文件 self-ref
  - [ ] 3.3 §应用环境差异 节首段重写（self-contained，不写「与 user CLAUDE.md 互补」）
  - [ ] 3.4 按 D4 5 步自检 + 精简（约束 2 人工分类 / 约束 3 完整模板 / 合并冗余 / 删历史 plan id 引用）
- [ ] Step 4：改 `resources/codex-config/CODEX_AGENTS.md`：
  - [ ] 4.1 头部加 D1 优先级声明节（codex 视角独立措辞 — v4 修订移除「user 级 AGENTS.md」未验证假设）
  - [ ] 4.2 grep `user CLAUDE.md` / `CLAUDE.md §` 命中按 D2 (a)/(b) 分流处理 — **v5 列具体命中清单**（codex MED-1 + v4 重审 M2 补 L155）：
    **⚠️ 实施前先跑 `grep -n 'user CLAUDE' app-codex-config-agents.md` 实地确认命中数与本清单对齐**（避免清单维护 drift）
    - L9 「与 claude SDK `settingSources: ['user','project','local']` 自动加载 `~/.claude/CLAUDE.md` 是平行机制」→ (a) cross-ref（描述 claude SDK 行为，合理保留）
    - L11 「## 应用环境差异（Δ user CLAUDE.md）」→ (a) inline 改写措辞为「应用环境与通用约定的差异」
    - L59 「按 user 全局模板 `~/.claude/templates/reviewer-claude.sh.tmpl` 填」+ 「通用 user CLAUDE.md §reviewer-codex 失败兜底」→ (a) 简短 inline
    - L145「user CLAUDE §Step 4 5 步」→ (b) self-ref 误命名 — 改「**详本文件** §plan hand-off 自动化:archive_plan 完成节」
    - **L155「user CLAUDE §Step 4 §中止 手工流程」**（v5 补，v4 重审 M2）→ (b) self-ref — 改「**详本文件** §plan hand-off 自动化 archive_plan §abandoned 手工流程」
    - L166 long matching line → grep 验证后按 (a)(b) 规则处理
    - L177「user CLAUDE.md §Step 4 5 步手工归档」→ (b) self-ref — 改「**详本文件** §plan hand-off 自动化 archive_plan 节」
    - L200「new session 自己按 user CLAUDE §Step 3 cold-start」（v5 修正 v4 行号 L201→L200 LOW-1）→ (b) self-ref — 改「**详本文件** §plan cold-start protocol 节」
    - L206 long matching line → grep 验证后按 (a)(b) 规则处理
    - L228「claude 视角的对应 protocol 在 user CLAUDE.md §复杂 plan §Step 3」→ 实际指 claude 端**应用** CLAUDE.md §复杂 plan §Step 3 — 改「claude 视角对应 protocol 详 claude-config CLAUDE.md §复杂 plan workflow §Step 3」
  - [ ] 4.3 按 D4 自检 + 精简（容忍 -10% 上限）
- [ ] Step 5：改 `~/.claude/CLAUDE.md`（仅 D4 自检 + 精简）：
  - [ ] 5.1 grep 验证 user 内不含直接绑死 agent-deck 引用（D3 已 grep 仅 4 处抽象描述，可保留）
  - [ ] 5.2 按 D4 自检 + 精简（user CLAUDE.md 117 行已较紧凑 — 重点 §决策对抗 + §提示词资产维护 节）
  - [ ] 5.3 展示形式：完整 diff patch + 按节分组改动总结，user 按节 approve / reject
- [ ] Step 6：检查 + 精简 SKILL / agent body：
  > **⚠️ 双 SSOT 边界提示**：
  > - SKILL：单源在 `claude-config/`，codex-config/ 是 sync-codex-skills.mjs 自动生成镜像（rm-rf + cp 单向），**只改 claude-config**，跑 Step 7 自动同步
  > - agent body：`reviewer-claude.md` **仅在** claude-config / `reviewer-codex.md` **仅在** codex-config，两端**独立维护不同步**（详「已知踩坑」节）
  - [ ] 6.1 `agent-deck-plugin/skills/deep-review/SKILL.md`（SSOT 单源在 claude-config）
  - [ ] 6.2 `agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md`（仅 claude 端有）
  - [ ] 6.3 `agent-deck-plugin/skills/hello-from-deck/SKILL.md`（SSOT 单源在 claude-config）
  - [ ] 6.4 `claude-config/agent-deck-plugin/agents/reviewer-claude.md`（claude 端独立 SSOT）
  - [ ] 6.5 `codex-config/agent-deck-plugin/agents/reviewer-codex.md`（codex 端独立 SSOT，**不**镜像 6.4）
  - [ ] 6.6 `resources/claude-config/README.md` 维护说明 **整体翻转**（M3 修正）：
    - 旧规则「绝不复制 user CLAUDE.md 任何通用约定」与 D2 inline 全部依赖 **正反向**
    - 改写为「本应用 CLAUDE.md self-contained 不依赖 user CLAUDE.md 加载；inline 改写时不逐字粘贴而是按应用视角重新组织」
  - [ ] 6.7 **项目根 `agent-deck/CLAUDE.md`**（v3 新增，按 D5 处理；v4 调整压缩边界 + 影响面）：
    - 头部 callout **整段覆写**（旧 L1-5 callout 删 + 新 callout 按 D5 措辞示例写）— v4 LOW-1 修订
    - 删除 §改动后必做 §1-4 详述内容（**实测 51 行**，L14-64）→ 压缩为关键约束 bullet（**≤ 10 行 — 实施前先 draft sample bullet 给 user 看是否能保留最低操作指南 *未验证-2***）
    - 删除 §反复反馈 / 反复踩坑 → 升级约定 详述（**实测 28 行**，L144-171）→ 压缩为**关键流程 bullet（≤ 12 行，参照应用 §反复反馈升级 14 行精简版）**，**硬性保留 4 项**（v4 MED-2/MED-3 修订；v5 *未验证* 标注 — 实施前先 draft sample bullet 给 user 看是否能保留 4 项硬约束）：
      - tally.md 路径（`ref/conventions/tally.md`）
      - count = 3 阈值 + 走双对抗三态裁决评审升级
      - 升级落点 `ref/conventions/<X>-<topic>.md` + 同步 `ref/conventions/INDEX.md`
      - count < 3 静默更新 / 30 天清理
    - **保留**项目专属节：§仓库基础（6 行）/ §项目特定约定（75 行）/ §验证流程（11 行）/ §打包与本地安装（44 行 — 含 SDK binary 踩坑）— 这些是 agent-deck 独有 design invariant 应用 CLAUDE.md 不应有
    - 按 D4 自检 + 精简（项目专属节本身已较紧凑；约束 5 命中 0；约束 2 命中 2 都是「老版本」context 保留）
    - 期望行数：248 → ~185-200 行（v4 修正 LOW-3：删 51+28=79 行 + 加 head callout ~5 行 + 压缩 bullet ~22 行 = 净减 52 行 → 196 行）
    - **6.7.x 展示形式**（v4 LOW-2 修订）：完整 diff patch + 按节分组改动总结（删除节标注「删 X 行」/ 压缩节标注「N → M 行」），user 按节 approve / reject — 与 Step 5.3 user CLAUDE.md 改动护栏对齐
- [ ] Step 7：跑 codex-config skills 镜像同步脚本（按项目运行时约定 `zsh -i -l -c "node scripts/sync-codex-skills.mjs"`）
- [ ] Step 8：deep-review SKILL 跑一遍最终 review（kind='mixed'，scope 含所有改后的资产 + 本 plan）
- [ ] Step 9a：fix loop（直到 0 HIGH 0 真 MED）
- [ ] Step 9b：user confirm 收尾（fix 后大改 / HIGH 引入新依赖时主动 ping user 单独 confirm，不在 9a 内自决）
- [ ] Step 10：commit + changelog（`ref/changelogs/CHANGELOG_X.md` 新 entry）
- [ ] Step 11：归档本 plan 到 `ref/plans/`（手工 mv + 同步 INDEX，本 plan 无 worktree 不走 archive_plan tool）

## 当前进度

- ✅ RFC 完成（3 个 design 决策已对齐）
- ✅ spike1 完成（SDK 注入行为铁证）
- ✅ plan 文件 v1 写完
- ✅ Step 1 决策对抗 review v1 完成（2 HIGH + 6 MED + 6 LOW + 4 INFO + 3 未验证）
- ✅ plan v2 修订完成（吸收 2 HIGH + 6 MED）
- ✅ user confirm v2 → 加 scope（项目根 CLAUDE.md）→ plan v3 + D5 + Step 6.7
- ✅ Step 1' 决策对抗 review v3 完成（0 HIGH + 3 MED 重叠 + 5 LOW + 2 未验证）
- ✅ plan v4 修订完成（吸收 3 MED 重叠 + LOW + *未验证-1* codex priority chain）
- ✅ Step 1'' 决策对抗 review v4 完成（0 HIGH + 2 MED 双方独立 + 2 LOW + 2 未验证）
- ✅ plan v5 修订完成（吸收 2 MED 双方独立：D5 callout 目的地空指针 / Step 4.2 漏 L155 + 行号修正 + codex marker 外用户段语义补充）
- ⏳ 待 user confirm v5 进 Step 3

## 下一会话第一步

如本会话被中断，新会话 cold start 步骤：
1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/prompt-asset-review-optimize-20260527.md`（**注**：因本 plan 不进 worktree，plan 文件在主仓库内，cat 主仓库路径即可）
2. 看 §当前进度 节判断卡在哪一步
3. 按 §步骤 checklist 推进

## 已知踩坑

- 改 `~/.claude/CLAUDE.md` 是 user 全局资产，每条改动必须 user 按节 approve / reject；不能默认静默修改
- agent-deck 应用 SDK 注入是 user/project/local 加载完之后 append；语义优先级声明依赖模型遵循软约束，**user 后续若发现冲突场景模型不听 user CLAUDE.md** → 走措辞强化迭代（不可走物理 prepend 路径，spike 已否决）
- skills 是 SSOT 在 claude-config 镜像到 codex-config（`scripts/sync-codex-skills.mjs`），改 claude-config skill 后必须跑同步脚本；**改 codex-config skill 镜像无效**（rm-rf + cp 重新覆盖）
- agent body 不需要镜像同步：`reviewer-claude.md` **仅在** `resources/claude-config/agent-deck-plugin/agents/`；`reviewer-codex.md` **仅在** `resources/codex-config/agent-deck-plugin/agents/` — 两端独立 SSOT 各自维护，不互相 cp
- **inline 改写强度回归**（review *未验证* INFO-1）：每条 inline 改写后对照原 user CLAUDE.md 措辞，确认「严禁 / 必须 / 禁止」类强约束字面强度未被弱化为「优先 / 应该 / 建议」
- **Step 6 改 SKILL + Step 7 sync 后**：如 dev 模式跑着 → SDK 已加载的旧 SKILL 在内存中 hot reload 行为未实测，重启 dev 才能确认看到改动生效；纯 build / dist 路径正常
- **D1 优先级链不替代 SDK 内置安全约束**：claude-code SDK preset 内置 IMPORTANT 安全约束 / codex SDK 内置 sandbox 安全规则始终最高优先级，本文件 + user CLAUDE.md 都不替代
