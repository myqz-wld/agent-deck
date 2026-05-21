# CHANGELOG_142 — prompt 资产精简 + 对抗 review fix 闭环

## 概要

P0-P5 阶段精简 8 份 prompt 资产（user CLAUDE.md 494 行 / claude-config/CLAUDE.md 185 行 / claude-config/README.md 删历史节 / reviewer-{claude,codex} body / SKILL.md / CODEX_AGENTS.md / 项目 README）总计净削 ~14 行；P6 对抗 review（双 Bash 并发起 reviewer-claude Opus 4.7 xhigh + reviewer-codex gpt-5.5 xhigh）触发 2 HIGH (H1/H2) + 1 MED (M3) + 1 *未验证* (U1) 全部 fix 闭环。

详 [REVIEW_51.md](../reviews/REVIEW_51.md)（双对抗配对 + 三态裁决清单 + 验证手段）。

## 变更内容

### 精简（P0-P5 阶段）

- `~/.claude/CLAUDE.md`: 501 → 494 行（删 v2 历史叙事 / C1/D1 措辞精确化 / M3 callout 精简）
- `resources/claude-config/CLAUDE.md`: 187 → 185 行（缩减 §reviewer-codex 失败兜底节）
- `resources/claude-config/README.md`: 删「## 历史」节（纯 REVIEW_30/CHANGELOG_79/2026-05-13 历史叙事）
- `resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md`: 三态裁决节 SSOT 化（推到 user CLAUDE.md SSOT pointer + 1 行 summary 保留核心决策树 + 量化阈值 ≤ 5min / ≤ 5 grep / ≤ 1 test）
- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`: sandbox 限制说明节精简（从 3 bullet + 结论段压成段落）
- `resources/codex-config/CODEX_AGENTS.md`: 对称改 reviewer-claude 失败兜底节
- `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md`: sandbox 节 trivial 删字（「已 default 扩」→「default 扩」）
- `README.md`: 删多处 changelog 引用号（CHANGELOG_45/46/56 / CHANGELOG_57 / CHANGELOG_69 / CHANGELOG_74 / R3 起 / REVIEW_21 #A13 等历史标签）

### 对抗 review fix（P6 阶段，REVIEW_51）

- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md:18-29`: **H1 fix** — sandbox 节回退两层表述
  - **READ** 默认宽松：denyRead 含 `~/.ssh / ~/.aws / ~/.config / ~/.kube / ~/.npmrc / ~/.gnupg / ~/.docker / shell history / macOS Keychains/Cookies` 等敏感凭据（共 13 项；macOS-only 路径在 Linux 自动忽略）
  - **WRITE** 严格：仅 `[cwd, /tmp, ~/.cache/claude-code, extraAllowWrite]`
  - **macOS Seatbelt full-disk-access** 是 OS 层独立限制（非 SDK 层），`~/Documents/` 等 TCC-protected 目录受系统级阻拦，无关 SDK denyRead 配置
  - caller 责任分流措辞修订：明示 SDK denyRead（敏感凭据） vs OS 层 TCC 限制 两路兜底分流
- `README.md:19`: **H2 fix** — Universal Team Backend 节加回行为锚点
  - 加「**CLI 内自起的 inbox-only team 在 agent-deck UI 不可见**」（应通过 `mcp__agent-deck__spawn_session` 起 team 进 universal backend）
  - 老 `~/.claude/teams/<X>/` 数据 Settings 一次性 export 入口表述保留
- `resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md:185`: **M3 fix** — spot-check 加「代码/原文片段≤6行」必填项
  - reviewer body 强约束 finding 输出契约：文件:行号 + 代码/原文片段≤6行 + 验证手段
  - lead spot-check：缺定位 / 缺代码片段 / 缺验证手段任一项 → 降 ❓
- `README.md:23`: **U1 fix (optional)** — 多 Adapter 节去弱断言改事实陈述
  - 删「**主导会话推荐**」/「**手感生硬**」/「turn-based 在异步 reply 场景**不影响**」类用户感知评价
  - 改「Claude Code SDK 支持 streaming input 多轮交互 + Codex CLI turn-based 协议每轮等上一轮完成；常作 reviewer / 子任务 teammate，主导会话场景按个人偏好选」事实陈述

## verify

- `grep` 自检 4 处 fix 全落地：
  - H1: `reviewer-claude.md` 「Sandbox 限制说明」节两层表述（13 项 + TCC 独立标注）
  - H2: `README.md:19` 「CLI 内自起的 inbox-only」行为锚点
  - M3: `SKILL.md:185` 「代码/原文片段≤6行」必填项
  - U1: `README.md:23` 「turn-based 协议每轮等」事实陈述
- 弱断言关键词跨改动文件 grep 无新引入：
  - reviewer-claude.md:37 「弱信号」是名词术语（Fresh session 自检上下文，非弱断言）
  - README.md:358 「通常」 + 373 「建议」是 pre-existing 措辞，不在本次改动范围
- 没改 .ts 文件，不需 typecheck / build

## 触发

用户："对前面已经做的改动（精简多份 CLAUDE.md 及相关配置文件）进行对抗 review。然后 exit plan 选择 by pass 后，出现 SDK 流中断错误。"

review 部分本 commit 闭环；SDK 流中断错误（restart-controller.ts:182/331 漏 jsonl 预检 — 与 recoverer.ts:378 不对称）走独立 plan 修复（detail 详 task `7862790f-5aa9-492b-81ec-cfc4fd0f689d`，按 user CLAUDE.md §复杂 plan 流程 v2）。
