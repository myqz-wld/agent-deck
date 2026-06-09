# AGENTS.md

> Codex 项目入口。共享仓库规则以 [`CLAUDE.md`](CLAUDE.md) 为准；本文件只补 Codex 入口差异，避免 Claude / Codex 两份项目约定双写漂移。

## 必读顺序

1. 先读 [`CLAUDE.md`](CLAUDE.md)，并执行其中的仓库基础、改动后必做、项目特定约定、验证流程。
2. 涉及应用内 Codex SDK 会话 / MCP / skill / 打包 prompt 资产时，再读 [`resources/codex-config/CODEX_AGENTS.md`](resources/codex-config/CODEX_AGENTS.md)。
3. 涉及 Claude 对偶资产时，对照 [`resources/claude-config/CLAUDE.md`](resources/claude-config/CLAUDE.md)；adapter 工具差异允许措辞不同，协议语义不能单边漂移。

## Codex 操作要点

- 改代码默认用 `rg` 搜索、`apply_patch` 手工编辑；不要用 shell 重定向或脚本临时写文件。
- Codex 没有 native EnterWorktree / ExitWorktree；plan worktree 进退必须走 Agent Deck MCP `enter_worktree` / `exit_worktree`，普通 shell 命令用 `git -C <worktree>` 或绝对路径。
- Codex SDK 是 turn-based：等待 teammate / reviewer / MCP reply 时，发出 `spawn_session` 或 `send_message` 后说明状态并结束当前 turn；不要用 `sleep` / `get_session` 循环在同一 turn 等。下一条 wire-prefixed teammate reply 会作为下一轮 user input 注入后再继续裁决。
- 改长生命周期 prompt 资产前，先执行当前可用的 prompt-asset 维护流程；无专用 skill 时按 `CLAUDE.md` 的内置资产自闭环原则人工审计。新增或修改 Claude 侧规则时同步审计 Codex 对偶资产，反之亦然。
- changelog / review / convention / flow-architecture diagram 等项目产物按 `CLAUDE.md` 的最小闭环规则和 `ref/` 现有格式执行；用户环境 project skills 只作增强层。本文件只补 Codex 工具差异。
