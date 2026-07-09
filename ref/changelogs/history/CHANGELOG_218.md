# CHANGELOG_218 — Deepseek（Claude Code）会话 profile + 资产页切换防闪烁

## 变更类型
功能新增 + UI 修复

## 背景
用户反馈资产库「应用约定」页在 Claude / Codex 子视角切换时页面跳变闪烁；同时需要在新建会话与 Agents `agentName` 路径中支持 Deepseek 模型，但 Deepseek 不应拥有独立 agents/skills/CLAUDE.md 资产，除 URL / token / model 等 provider 配置外全部复用 Claude 侧资源。

## 实现
- 新增 `deepseek-claude-code` adapter：
  - 复用 `ClaudeSdkBridge`，不注册独立 hook / 资产 root。
  - 新建会话列表显示 `Deepseek (Claude Code)`。
  - 首次使用时创建 `~/.agent_deck/.deepseek/settings.json`，读取 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / model / 默认 Opus/Sonnet/Haiku / subagent model / effort level。
  - Deepseek profile env 只注入 SDK 子进程，不污染主进程 `process.env`。
- Claude bridge 支持 profile env/model overlay：
  - `SdkBridgeOptions.envProvider` 注入子进程 env overlay。
  - `defaultModelProvider` 在 caller / agent frontmatter 未指定 model 时提供默认模型。
- `spawn_session(agentName=...)` 支持 Deepseek：
  - `adapter='deepseek-claude-code'` 时仍从 Claude 侧 bundled agent 读取 body 和 frontmatter model。
  - 保留 Claude 侧 reviewer frontmatter `model: opus`，由 Deepseek Anthropic-compatible endpoint 做模型映射。
- UI 接入：
  - 新建会话 dialog / issue「起新会话解决」dialog 支持选择 Deepseek，并显示 Claude Code 同款权限模式与系统沙盒控件。
  - SessionDetail 输入区显示 Deepseek 短名，支持图片附件、权限模式、Claude Code 系统沙盒冷切。
  - 团队页 / 活动流 agent 标签显示 Deepseek，避免露出 raw adapter id 或误显示 Claude。
- 资产页防闪烁：
  - 「应用约定」页 ClaudeMdEditor / CodexAgentsMdEditor 改为常驻挂载，只切 `hidden` 可见性。
  - dirty 状态按 adapter 分桶；关闭资产库时拦截任一未保存草稿，切子视角时只拦截当前视角草稿。
  - 用户确认丢弃时才 reset 当前 editor，普通切换不再卸载重挂。
- CLI / MCP / README：
  - `agent-deck new --agent deepseek-claude-code` 与短名 `--agent deepseek`。
  - MCP `spawn_session` / `list_sessions.adapterFilter` / `hand_off_session.adapter` schema 支持 Deepseek。
  - README 说明 `.deepseek` 配置文件和 Deepseek 复用 Claude 侧资源的边界。

## 验证
- `pnpm typecheck`
- `pnpm vitest run src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts`
