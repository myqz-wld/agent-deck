# CHANGELOG_207

## Settings 默认值 + MCP 工具清单 / Claude-Codex 项目入口对偶

### 概要

本次把设置面板的关键默认值调到更适合 Agent Deck 当前工作流的取值：Issue 已解决保留 30 天、权限请求超时 30 分钟、活跃到休眠 1 小时、Agent Deck MCP server 默认开启。同步补齐根级 `AGENTS.md`，让 Codex 有项目入口，并修正 MCP 工具数量从 15 到 18 的文案漂移。

### 变更内容

#### Settings 默认值

- `DEFAULT_SETTINGS.activeWindowMs`：30 分钟 → 1 小时。
- `DEFAULT_SETTINGS.permissionTimeoutMs`：5 分钟 → 30 分钟；Settings UI 单位从秒改为分钟。
- `DEFAULT_SETTINGS.issueResolvedRetentionDays`：90 天 → 30 天。
- `DEFAULT_SETTINGS.enableAgentDeckMcp`：默认关 → 默认开。
- `settings-store` 增加一次性 value-uplift sentinel：旧安装里恰好等于旧默认的数值会升到新默认；用户之后手动改回旧值不会被反复覆盖。
- MCP 默认开启只作用于新安装默认值；已有新版 `enableAgentDeckMcp:false` 不被覆盖，legacy `enableTaskManager:false` 且无显式 `enableAgentDeckMcp` 时仍迁移为 `enableAgentDeckMcp:false`。

#### MCP 工具清单

- Settings 面板 Agent Deck MCP section 工具清单改为 18 个，并补上 `report_issue` / `append_issue_context` / `update_issue_status`。
- README、HTTP transport 注释、tool types/helper 注释、两端应用提示词资产统一为 18 tool 口径。
- README stdio external caller 说明同步为 3 个只读 allow tool + 15 个 deny external tool。

#### 提示词资产对偶

- 新增根级 `AGENTS.md`，作为 Codex 项目入口；共享仓库规则指向根级 `CLAUDE.md`，避免重复维护。
- 根级 `CLAUDE.md` 删除旧 inbox-based Agent Teams 权限段，改为当前 Universal Team Backend + Agent Deck MCP 边界。
- `resources/claude-config/CLAUDE.md` 与 `resources/codex-config/CODEX_AGENTS.md` 同步 MCP 18 tool 口径。

### 验证

- deep-review R1：
  - reviewer-codex 提出 `enableAgentDeckMcp:false` 被 value-uplift 覆盖的 MED，已修复。
  - reviewer-claude 提出 README external caller 3/15 边界写错的 MED，已修复。
- deep-review R2：reviewer-claude 读码确认两个修复已生效；Codex quota 恢复后重开 reviewer-codex，结论 PASS，无新增 / 残留 HIGH/MED。
- 本地验证：
  - `./node_modules/.bin/vitest run src/main/store/__tests__/settings-store.test.ts src/main/codex-config/__tests__/agent-deck-mcp-injector.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts src/main/agent-deck-mcp/__tests__/task-external-caller.test.ts` → 112 passed。
  - `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json` → pass。
  - `./node_modules/.bin/tsc --noEmit -p tsconfig.web.json` → pass。
