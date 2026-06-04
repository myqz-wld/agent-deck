# resources/claude-config/

应用打包时会把这两个目录的内容一起塞进 `.app/Contents/Resources/claude-config/`，运行时由主进程注入到每个应用内 SDK 会话的环境（system prompt / settings / plugin）。

## CLAUDE.md（应用环境约定）

`resources/claude-config/CLAUDE.md` —— 应用打包注入到每个 SDK 会话 system prompt 末尾，**位置在 user / project / local CLAUDE.md 之后**。

设计原则：

- **本应用 CLAUDE.md self-contained 不依赖 user CLAUDE.md 加载**。所有 agent-deck 应用环境需要的工程实践（§复杂 plan workflow / §新项目工程地基 / §核心流程架构变更必走 plantUML 等）已 inline 进本文件。`settingSources: []` 的内部 oneshot 会话（间歇总结等）不加载 user CLAUDE.md，本文件 inline 内容仍可用
- **优先级声明节（必读）**：本文件头部明确声明 SDK preset claude_code 内置安全约束 > user CLAUDE.md > 本文件的优先级链。本文件作为 agent-deck 应用专属 baseline 补充能力（mcp tool / plugin SKILL / cold-start 协议等），不替换 user 通用约定
- **inline 改写不逐字粘贴**：从 user CLAUDE.md inline 通用约定时按本应用场景重新组织语言（不简单复制）；保留原约束强度（「严禁 / 必须 / 禁止」类强约束字面强度不弱化）

### 改动维护

- 改 `resources/claude-config/CLAUDE.md` → 应用 build → 装新 .app（或 dev 模式重启），不要手动改打包后版本
- **不要**在 user CLAUDE.md / 项目根 CLAUDE.md 与本文件**双写同款通用约定**。本应用 CLAUDE.md 围绕「agent-deck 应用环境」组织，user CLAUDE.md 围绕「通用工程实践」组织 — 同主题在不同视角下措辞可不同，但不要逐字粘贴
- 改 `agent-deck-plugin/skills/*/SKILL.md` → **claude / codex 两端独立 SSOT 各自维护**：claude skills 在本目录 `resources/claude-config/agent-deck-plugin/skills/`，codex skills 在 `resources/codex-config/agent-deck-plugin/skills/`，两端不互相同步（adapter 工具差异决定 SKILL 措辞不同，详下方 §设计 SSOT）
- 改 `agent-deck-plugin/agents/reviewer-{claude,codex}.md` → **不需要镜像同步**。`reviewer-claude.md` 仅在 `resources/claude-config/agent-deck-plugin/agents/`；`reviewer-codex.md` 仅在 `resources/codex-config/agent-deck-plugin/agents/` — 两端独立 SSOT 各自维护

## agent-deck-plugin/

应用打包注入的 plugin 包（agents / skills / commands）：

- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md` / `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md` —— `simple-review` / `deep-review` SKILL 共用的两 reviewer teammate body（**两端独立 SSOT** 各自维护）
- `skills/simple-review/SKILL.md` —— 单次异构 review × 可选一轮 fix 的轻量 SKILL（**两端独立 SSOT**：claude-config + codex-config 各自维护）
- `skills/deep-review/SKILL.md` —— 多轮异构 review × fix 收口的 SKILL（**两端独立 SSOT**：claude-config + codex-config 各自维护）
- `skills/flow-arch-plantuml/SKILL.md` —— 核心流程 / 架构变更画 plantUML 的 SKILL（**两端独立 SSOT**：claude-config 用 Read/Write/AskUserQuestion，codex-config 用 shell/apply_patch + turn 边界）
- `skills/hello-from-deck/SKILL.md` —— plugin 自检 SKILL（**两端独立 SSOT**：claude-config + codex-config 各自维护）

设计 SSOT：

- 单次 / 单点对抗 review 走 `agent-deck-plugin/skills/simple-review/SKILL.md`（spawn 异构 reviewer 对，单次 full_review + 可选一轮 fix）
- 多轮深度 review 走 `agent-deck-plugin/skills/deep-review/SKILL.md` teammate 模式定义
- mcp 18 tool 协议 + Universal Team Backend 在 `resources/claude-config/CLAUDE.md` §Agent Deck Universal Team Backend 节定义
- reviewer body 行为契约在 `agent-deck-plugin/agents/reviewer-{claude,codex}.md`
- **SKILL 两端独立 SSOT**：claude skills（`resources/claude-config/agent-deck-plugin/skills/`）与 codex skills（`resources/codex-config/agent-deck-plugin/skills/`）各自维护,不互相同步。adapter 工具差异（claude `Read`/`Write`/`AskUserQuestion` vs codex `shell cat`/`apply_patch`/turn 边界）决定 SKILL 措辞本质不同,两端独立避免「写一份再同步」的漂移。codex skills 由 `src/main/codex-config/skills-installer.ts` 从 codex-config 读源安装到 `~/.codex/skills/agent-deck/`;claude skills 通过 SDK `plugins` 字段注入

reviewer agent body inline reviewer **角色专属规约**（核心纪律 / 输入识别 / 输出格式 / 重点维度 / 反模式 / 失败兜底）满足 plugin self-contained；**协议层 SSOT**（wire format / send_message / fresh session 自检 / scope 路径前缀 / NO MSG ANCHOR fallback）在应用打包 CLAUDE.md（claude 侧）/ CODEX_AGENTS.md（codex 侧）。
