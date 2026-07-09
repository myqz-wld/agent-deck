# CHANGELOG_249: 设置面板 MCP 介绍补齐与 Claude Agent SDK 升级

## 概要

补齐设置面板 Agent Deck MCP server 介绍里的 `request_plan_review` 语义，并把 `hand_off_session` 从 Worktree 分组移回会话编排分组。同步升级 Claude Agent SDK 到 `0.3.175`；Codex CLI 与 Anthropic SDK registry `latest` 仍为当前版本。

## 变更内容

### 设置面板 MCP 介绍

- 「Agent Deck MCP server」短介绍补上请求计划检阅和 issue 上报能力，避免只写“管理其他会话和团队任务”导致 `request_plan_review` 看起来缺失。
- 完整工具清单中，`hand_off_session` 归入「会话编排」；「Worktree」分组只保留 `enter_worktree` / `exit_worktree`。
- 介绍里的 adapter 范围补上 Deepseek，与 README 的跨工具协作描述一致。

### 依赖升级

- `@anthropic-ai/claude-agent-sdk`: `0.3.170` -> `0.3.175`，随包 native binary 版本同步更新。
- `@anthropic-ai/sdk`: registry `latest` 仍为 `0.104.1`，未变化。
- `@openai/codex`: registry `latest` 仍为 `0.139.0`，未变化；未采用 `0.140.0-alpha.14`。

## 验证

- `pnpm typecheck` 通过。
- `pnpm test:node` 通过（SQLite 真测因本机 better-sqlite3 Electron ABI 与系统 Node ABI 不匹配按既有 guard 跳过）。
- `pnpm build` 通过。
- `git diff --check` 通过。
