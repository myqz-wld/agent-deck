# CHANGELOG_155: prompt-asset-review-optimize-20260527 plan 收口

## 概要

整理 agent-deck 提示词资产 SSOT 边界,实现 4 条用户需求:(1) 应用内 CLAUDE.md self-contained 不依赖 user CLAUDE.md;(2) user CLAUDE.md 不绑死 agent-deck;(3) 优先级链显式声明 `SDK preset 安全约束 > user CLAUDE.md > 应用 CLAUDE.md`(spike1 实证 SDK 0.3.144 无 prepend,走语义修法);(4) 信息密度精简(项目根 CLAUDE.md 248 → 194 行 -22%)。

3 轮决策对抗 review × 4 个修订轮(v1→v2→v3→v4→v5) + 1 轮 final review fix loop:v1 review 出 2 HIGH+6 MED→v2;v3 加 scope 项目根 CLAUDE.md→v4;v4 重审 0 HIGH+3 MED→v5;final review reviewer-codex 抓 codex-config 2 真 MED(hand_off_session 签名漏 team_task_policy + abandoned 手工流程 self-ref 空指针)→ surgical fix。0 HIGH 0 真 MED 收口。

## 变更内容

### 应用 claude 端 `resources/claude-config/CLAUDE.md`(654 → 649 行)

- 头部加 §优先级声明(必读) 节:显式三档优先级链(SDK preset 安全 > user CLAUDE.md > 本文件)+ 加载范围(`settingSources` 两档)+ self-contained 声明
- §应用环境差异 节首段重写为 §应用环境特有能力(不依赖 user CLAUDE.md)— 移除「与 user CLAUDE.md 互补」表述
- 10 处 `user CLAUDE.md` cross-ref 按 D2 (a)/(b) 分流处理:4 处真 cross-ref inline 改写措辞 + 6 处误命名 self-ref 改 `**详本文件** §X` 自指 link
- §task 进度跟踪 节合并三态分流重复段 + 删历史 plan id 引用(plan task-mcp-owner-session-id-rewrite-20260521 v023 / v024 等)
- §archive_plan + §hand_off_session 节删历史 plan id / followup id / Phase 演变史 / Round N 修法引用

### 应用 codex 端 `resources/codex-config/CODEX_AGENTS.md`(247 → 251 行)

- 头部加 §优先级声明(必读) 节(codex 视角独立措辞):codex SDK 内置安全约束 > caller 当下指令(developer message / per-turn user prompt) > 本文件 baseline;补 `~/.codex/AGENTS.md` marker 外用户段平等加载语义(实测 `agents-md-installer.ts` 有 marker pattern)
- 同款 cross-ref / self-ref 分流(L9 / L11 / L59 / L145 / L155 / L177 / L200 / L206 / L228 — 含 final review codex MED-1 修补 L155 abandoned)
- L228 「user CLAUDE.md §复杂 plan §Step 3」改 cross-ref claude-config CLAUDE.md(本来就指 claude 端应用约定不是 user)
- final review surgical fix:L199 `hand_off_session` 签名补 `team_task_policy?: 'clear-team' | 'preserve-team' | 'skip'`;3 处 §abandoned 手工流程 self-ref 空指针改 cross-ref `claude-config CLAUDE.md §复杂 plan workflow §Step 4 §中止 手工流程`(跨 adapter 通用 5 步)

### `resources/claude-config/README.md`(38 → 41 行)— M3 整体翻转

- 旧规则「绝不复制 user CLAUDE.md 任何通用约定」与 D2 inline 全部依赖**正反向** → 改写为「本应用 CLAUDE.md self-contained 不依赖 user CLAUDE.md 加载;inline 改写时不逐字粘贴而是按应用视角重新组织」
- 显式标 reviewer agent body 双 SSOT 独立维护(claude-config / codex-config 各自 agents/ 不镜像;sync-codex-skills.mjs 只同步 skills/)

### Plugin SKILL fix

- `agent-deck-plugin/skills/deep-review/SKILL.md` L17 self-ref 修法:`user CLAUDE.md §Step 1.5 Deep-Review` → `应用 CLAUDE.md §复杂 plan workflow §Step 1.5 Deep-Review`(实指应用 CLAUDE.md 内 §复杂 plan workflow §Step 1.5 节)
- `agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md` L35 / L43 / L148 「应用打包 CLAUDE.md」措辞精简为「应用 CLAUDE.md」
- 跑 `node scripts/sync-codex-skills.mjs` 自动同步 codex-config skills/ 镜像(rm-rf + cp 单向)

### 项目根 `agent-deck/CLAUDE.md`(248 → 194 行 -22%)

- 头部 callout 整段覆写:旧「与 `resources/claude-config/CLAUDE.md` 独立维护」 → 新 callout 明示节分类(项目专属 design invariant 保留 / 通用约定最低操作指南压缩)+ 单文件 ≤500 行护栏指 `~/.claude/SOPs/file-size-guardrail.md` + 应用 SDK 会话内额外加载应用 CLAUDE.md §新项目工程地基 详述
- §改动后必做 53 行(L14-64) → 13 行(改 §改动后必做(最低操作指南))— 压缩为 4 条 bullet:用户可见行为改 README / 写 changelog 或 review 二选一 / 改前先读 ref/ / 单文件 ≤500 行
- §反复反馈 / 反复踩坑 → 升级约定 28 行(L144-171) → 16 行(改 §反复反馈 / 反复踩坑 → 升级约定(最低操作指南))— 硬保留 4 项:tally.md 路径 / count=3 双对抗升级 / `<X>-<topic>.md` + INDEX.md 同步 / count<3 静默 + 30 天清理
- 保留项目专属节不动:§仓库基础(6) + §项目特定约定(75 9 个 sub) + §验证流程(11) + §打包与本地安装(48 含 SDK binary 踩坑)

### user `~/.claude/CLAUDE.md`(117 行 0 改动)

- D3 dry-run 验证 user CLAUDE.md 已不绑死 agent-deck(grep `agent-deck / mcp / spawn_session` 0 命中);4 处「应用环境 / SKILL / teammate / SDK 内」均为抽象描述合理保留
- D4 5 步自检命中 6 处全部在 §提示词资产维护 节内自检规则定义本身(meta 引用),按 D4 修订规则保留
- 信息密度已紧凑无重复约定,Step 5 判定 0 改动

## 不变量(plan v5)

1. SDK 字段不动(走 `systemPrompt: { type:'preset', preset:'claude_code', append }`)— spike1 H1 实证铁证 ✅
2. 应用 CLAUDE.md 头部统一声明(claude / codex 两端独立措辞)✅
3. inline 不等于复制粘贴(措辞按应用视角重新组织,保留原约束强度)✅
4. reviewer agent body inline 协议层不重写(仅修措辞 cross-ref)✅
5. 不动外部 CLI 模板 `~/.claude/templates/reviewer-{claude,codex}.sh.tmpl` ✅
6. 项目根 CLAUDE.md 纳入 scope(D5)— Step 6.7 落地 ✅

## 改动文件统计

- **5 SSOT 资产**:claude-config CLAUDE.md / codex-config CODEX_AGENTS.md / claude-config README.md / 2 SKILL(deep-review + flow-arch-plantuml)
- **1 项目根**:`agent-deck/CLAUDE.md`(248 → 194 -22%)
- **3 codex-config skills 镜像**(sync 脚本生成)
- **0 user 全局**:`~/.claude/CLAUDE.md` 0 改动(D3 决策)
- **1 plan 主体** + **1 spike**:`.claude/plans/prompt-asset-review-optimize-20260527.md` + spike-reports/spike1-sdk-system-prompt-injection.md(Phase 收口归档到 `ref/plans/`)
- **1 changelog**:本文

详 [`ref/plans/prompt-asset-review-optimize-20260527.md`](../plans/prompt-asset-review-optimize-20260527.md)
