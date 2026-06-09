# AGENTS.md

> Codex 项目入口。共享仓库规则以 [`CLAUDE.md`](CLAUDE.md) 为准；本文件只补 Codex 入口差异，避免 Claude / Codex 两份项目约定双写漂移。

## 必读顺序

1. 先读 [`CLAUDE.md`](CLAUDE.md)，并执行其中的仓库基础、改动后必做、项目特定约定、验证流程。
2. 涉及应用内 Codex SDK 会话 / MCP / skill / 打包 prompt 资产时，再读 [`resources/codex-config/CODEX_AGENTS.md`](resources/codex-config/CODEX_AGENTS.md)。
3. 涉及 Claude 对偶资产时，对照 [`resources/claude-config/CLAUDE.md`](resources/claude-config/CLAUDE.md)；adapter 工具差异允许措辞不同，协议语义不能单边漂移。
