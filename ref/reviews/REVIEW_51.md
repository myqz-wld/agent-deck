---
review_id: 51
reviewed_at: 2026-05-21
expired: false
---

# REVIEW_51: prompt 资产精简后异构对抗 review — 2 HIGH + 1 MED + 1 *未验证* 合规闭环

## 触发场景

用户主动触发「对前面已经做的改动（精简多份 CLAUDE.md 及相关配置文件）进行对抗 review」。本轮改动 P0-P5 涉及 8 份 prompt 资产精简（user CLAUDE.md / 应用打包 CLAUDE.md / CODEX_AGENTS.md / 项目 README / claude-config/README / reviewer-{claude,codex}.md / SKILL.md），目标删历史叙事 + SSOT 化 + 信息密度提升。改完需对抗 review 验证有无引入用户感知信息丢失 / 技术不准确 / 维护漂移。

## 方法

**双对抗配对**（单轮异构主路径，详 `~/.claude/CLAUDE.md` §决策对抗 §主路径 双 Bash 并发起外部 CLI）：
- reviewer-claude: Claude Opus 4.7 xhigh, `claude -p --permission-mode plan --allowedTools 'Read,Grep,Glob,Bash(...)'`，timeout 600000
- reviewer-codex: Codex gpt-5.5 xhigh, `codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=xhigh`，timeout 600000

两个进程完全独立（互不知道对方存在 / 不沟通），各自 stdout 落到 `/tmp/agent-deck-prompt-asset-review-{claude,codex}-out.md`，主 agent 做三态裁决。

**范围**: 8 文件 + 7 文件 git diff (253 行 unified diff `/tmp/agent-deck-prompt-asset-diff.patch`) + user CLAUDE.md fs current state (494 行)

```text
/Users/apple/.claude/CLAUDE.md                                                   # user global, 494 行
README.md                                                                         # 项目根, 373 行
resources/claude-config/CLAUDE.md                                                # 应用打包, 185 行
resources/claude-config/README.md                                                # plugin doc, 38 行
resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md               # 136 行
resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md             # 207 行
resources/codex-config/CODEX_AGENTS.md                                           # codex 对偶, 227 行
resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md                 # 140 行
```

**focus** (5 个维度):
- F1: 改动是否丢失「用户应知的当前行为」(non-history user-facing info)
- F2: 改动是否引入技术不准确措辞（重点 reviewer-claude.md sandbox 节）
- F3: 约束 6 (plugin 资产 self-contained) 是否破坏（SKILL.md SSOT 推到 user CLAUDE.md 是否丢关键操作）
- F4: 对偶 / 镜像资产同步（claude-config ↔ codex-config / reviewer-claude ↔ reviewer-codex）
- F5: 整体 SSOT 健康（grep 「三态裁决」5 处现身是否真冗余）

## 三态裁决清单

### ✅ 双方独立提出 HIGH×2

#### H1 — reviewer-claude.md sandbox 节技术不准确（双错）

- **文件:行号**: `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md:18-24`
- **双方一致**: reviewer-claude H1 + reviewer-codex H2 独立提出，都引用 sandbox-config.ts:92-110 实测
- **原文（fix 前）**:
  ```md
  claude-code SDK 默认 `workspace-write` 档（详 `src/main/adapters/claude-code/sandbox-config.ts`）：READ 默认宽松（仅 deny `~/.ssh / ~/.aws / ~/.config` 凭据 + macOS TCC 保护目录）；WRITE 严格（仅 `[cwd, /tmp, ~/.cache/claude-code, extraAllowWrite]`）。
  ```
- **错误**:
  1. denyRead 列表 understated — 仅列 3 项（`~/.ssh / ~/.aws / ~/.config`），实际 sandbox-config.ts:92-110 `buildSensitiveDenyReadPaths()` 返回 13 项（含 `~/.kube / ~/.npmrc / ~/.netrc / ~/.pypirc / ~/.gnupg / ~/.docker / ~/.zsh_history / ~/.bash_history / ~/Library/Keychains / ~/Library/Cookies` 这 10 项漏列）；用「**仅** deny X」误暗示穷尽。原版用「`~/.ssh / ~/.aws / ~/.config` **等** 敏感凭据」 — 「等」字明确非穷尽
  2. macOS TCC 与 SDK denyRead 混成同一层 — TCC 是 OS 层独立限制（macOS Seatbelt full-disk-access），sandbox-config.ts 0 处 TCC/Documents 命中；新版「+ macOS TCC 保护目录」误导 reviewer 以为 SDK 配置覆盖 TCC（实际不在 SDK 层）；下游 caller responsibility 句「**仅**当路径在敏感凭据 / TCC 保护范围内时 caller cp」基于错误前提推导分流
- **验证手段**:
  - `Read sandbox-config.ts:92-110` 实测 buildSensitiveDenyReadPaths 返回 13 项
  - `grep TCC|Documents sandbox-config.ts` 0 处命中
  - diff `-` 行（被删原版）明示「macOS Seatbelt full-disk-access **是 OS 层独立限制(非 SDK 层)**」 — 原版精确，新版退化
- **影响**: agent body 是 spawn-time 注入到 reviewer SDK system prompt 的硬契约。当前措辞会让 reviewer 漏算 `~/.kube / ~/.gnupg / ~/.docker / ~/.zsh_history` 等场景；同时 caller 看到 「+ macOS TCC 保护目录」会误以为可以靠 SDK 配置绕过 TCC（实际 OS 层不归 SDK 管，绕不了）

#### H2 — README.md 行 19 永久失明边界丢失

- **文件:行号**: `README.md:19`
- **双方一致**: reviewer-codex H1 (HIGH) + reviewer-claude M1 (MED) 严重度分歧；lead 取 HIGH（项目 ADR docs/agent-deck-team-protocol.md:962 明确承诺 README 必须显式说明）
- **原文（fix 前）**:
  ```md
  - **Universal Team Backend**：... `mcp__agent-deck__send_message` 走 DB queue 投递并自动把 reply 注入 lead conversation。Settings 提供 `~/.claude/teams/<X>/` 一次性 export 入口
  ```
- **错误**: 删除「CLI 内自起的 team 在 agent-deck UI 永久失明」是**当前用户行为锚点**而非历史叙事；用户用 CLI inbox file 自起 team 时撞 silent failure 没有任何提示
- **验证手段**:
  - `docs/agent-deck-team-protocol.md:962` 「README + 启动 dialog 必须显式说明」（项目 ADR 承诺）
  - `docs/agent-deck-team-protocol.md:966-972` 永久失效清单第 1 条 + 第 3 条
  - `src/shared/types/permission.ts:98-100` + `src/shared/types/agent-deck-team.ts:13` 多处确认 UI 完全失明的当前事实
  - `src/renderer/components/settings/sections/ExperimentalSection.tsx:17` 「R3.E7：删 Agent Teams toggle」

### ✅ 单方 + lead 现场验证 MED×1

#### M3 — SKILL.md spot-check 漏代码片段必填项

- **文件:行号**: `resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md:185`
- **单方**: reviewer-codex M1 单方提出
- **原文（fix 前）**:
  ```md
  reviewer body 已强约束 finding 输出契约（文件:行号 + 验证手段 / 弱断言关键词只允 *未验证* 条目）。lead spot-check：缺定位 / 缺验证手段 → 降 ❓
  ```
- **Lead 现场验证**: `Read user CLAUDE.md:73-76` Finding 输出契约要求 3 项（文件:行号 + 代码 / 原文片段 ≤ 6 行 + 验证手段），SKILL.md 新版 spot-check 只检查「缺定位 / 缺验证手段」漏「缺代码片段」第三项
- **影响**: SKILL.md 单读时 lead 按 spot-check 列表抽查 reviewer reply，会漏「reviewer 没贴代码片段」这一类缺定位证据的低质量 finding

### ❓ *未验证* ×1

#### U1 — README.md +23 行 codex turn-based 描述含弱断言

- **文件:行号**: `README.md:23`
- **单方**: reviewer-claude 单方提出，自标 *未验证*
- **原文（fix 前）**:
  ```md
  - **多 Adapter**：Claude Code（hook + SDK 双通道，**主导会话推荐**，SDK 支持 streaming input 流畅多轮）+ Codex CLI（单 SDK 通道；**codex SDK 不支持 streaming input（turn-based）**，当主导会话切**手感生硬**，**仅作 reviewer / 子任务 teammate 用** — turn-based 在异步 reply 场景**不影响**）
  ```
- **状态**: 「手感生硬 / 不影响」类用户感知评价不可实证；违反提示词资产维护 §约束 3「可执行性 > 描述性」（模糊副词「通常 / 大概」类只允出现在标 *未验证* 条目，本节没标 *未验证*）
- **现场实测**: `grep streamingInput|streamInput|incremental @openai/codex-sdk` 0 处命中（间接支持 turn-based 事实），但「主导会话推荐 claude-code / 手感生硬」是判断性陈述非纯技术事实，不阻塞合并
- **降级**: *未验证* 强制非 HIGH。修法 optional：去弱断言改事实陈述

### ❌ 反驳

无（双方共识高，未触发反驳轮）

### LOW / INFO

- **L1/L2** (reviewer-claude 单方): SKILL.md 三态裁决 + 强制约束节 SSOT 化合规（约束 6 self-contained 通过；核心决策树 + 量化阈值仍 inline）
- **I1**: 「三态裁决」跨资产 5 处现身非冗余 — 各处语境正交（user CLAUDE.md SSOT / SKILL.md 流程编排 / reviewer body finding 输出契约 / 项目 + 应用 + README reference 入口）
- **I2**: claude-config/README.md 删「## 历史」节合理（plugin 维护文档纯历史标签 REVIEW_30/CHANGELOG_79/2026-05-13 按约束 2 应删）
- **I3**: claude-config/CLAUDE.md ↔ CODEX_AGENTS.md「reviewer-{codex,claude} 失败兜底」节对偶同步
- **I4**: README.md 多处 changelog 数字删除合规（用户文档不需历史 CHANGELOG_X 可读性）

## 修复条目（按严重度）

- **H1** ✅ fix: `reviewer-claude.md:18-29` sandbox 节回退两层表述
  - READ 默认宽松：denyRead 含 13 项（关键凭据列举 + 注释「共 13 项」明示总数）
  - WRITE 严格：仅 4 项 allowWrite
  - macOS Seatbelt full-disk-access 是 OS 层独立限制（非 SDK 层），TCC-protected 目录受系统级阻拦无关 SDK denyRead 配置
  - caller 责任分流措辞修订（明示 SDK denyRead vs OS TCC 两路兜底分流）
- **H2** ✅ fix: `README.md:19` Universal Team Backend 节加回「CLI 内自起的 inbox-only team 在 agent-deck UI 不可见」行为锚点 + 引导走 `mcp__agent-deck__spawn_session`
- **M3** ✅ fix: `SKILL.md:185` spot-check 加「代码/原文片段≤6行」必填项 + 三项检查（缺定位 / 缺代码片段 / 缺验证手段任一项 → ❓）
- **U1** ✅ fix (optional 已采纳): `README.md:23` 多 Adapter 节去「主导会话推荐 / 手感生硬 / 不影响」类弱断言，改事实陈述（codex SDK turn-based 协议每轮等上一轮完成 / 主导会话场景按个人偏好选）

## verify

- `grep` 自检 4 处 fix 全落地
- 弱断言关键词跨改动文件 grep 无新引入（reviewer-claude.md:37 「弱信号」是名词术语 / README.md:358 + 373 「通常 / 建议」是 pre-existing）
- 没改 .ts 文件，不需 typecheck / build
- `heterogeneous_dual_completed: true`

## 关联 changelog

[CHANGELOG_142.md](../changelog/CHANGELOG_142.md)
