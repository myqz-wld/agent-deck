# AGENTS.md

> 给 Codex 在本仓库工作时的硬性约定（Codex 入口）。
> **共享仓库规则以 [`CLAUDE.md`](CLAUDE.md) 为准**——仓库基础 / 改动后必做 / 项目特定触发 / 项目特定约定 / 验证流程都写在那里，本文件只补 **Codex 入口差异**，避免 Claude / Codex 两份项目约定双写漂移。
> 应用环境通用约定（输出 / 运行时 / review 对抗 / 工程地基）见 `resources/codex-config/CODEX_AGENTS.md`，与 Claude 端 `resources/claude-config/CLAUDE.md` 协议层语义对齐。

## 必读顺序

1. 先读 [`CLAUDE.md`](CLAUDE.md)，执行其中的仓库基础、项目特定触发、项目特定约定、验证流程（Claude / Codex 共用的项目 SSOT）。
2. 涉及应用内 Codex SDK 会话 / MCP / skill / prompt asset 时，再读 `resources/codex-config/CODEX_AGENTS.md`。
3. 涉及 Claude 对偶资产时对照 `resources/claude-config/CLAUDE.md`；adapter 工具差异允许措辞不同，协议语义不能单边漂移。

## Codex 操作要点（只补与 Claude 入口的工具差异）

- 改代码默认用 `rg` 搜索、`apply_patch` 手工编辑；不要用 shell 重定向或脚本临时写文件。
- Codex 没有 native EnterWorktree / ExitWorktree；plan worktree 进退走 Agent Deck MCP `enter_worktree` / `exit_worktree`，普通 shell 命令用 `git -C <worktree>` 或绝对路径。
- Codex SDK 是 turn-based：发出 `spawn_session` / `send_message` 后说明状态并结束当前 turn 等回复，不要用 `sleep` / 轮询在同一 turn 内等 teammate / reviewer / MCP reply。
- 改长生命周期 prompt 资产前先走提示词资产维护自检；改 Claude 侧规则时同步审计 Codex 对偶资产，反之亦然。

## 项目特定 Codex 差异（如有）

`CLAUDE.md` 是项目约定唯一 SSOT；仅当本项目存在 Claude / Codex **工具能力差异**时在此补一行，没有差异留空。

<!-- 模式（一行一条差异）：
- <例：本项目 X 校验 Codex 端走 shell `<cmd>`，对应 Claude 端 Bash 同命令——无语义差异时不必单列>
- <例：某 MCP 工具在 Codex sandbox 下需 approvalPolicy=on-request 才能跑>
-->
