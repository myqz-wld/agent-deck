# CHANGELOG_36: Agent Deck 自带 CLAUDE.md + Skill 注入机制

## 概要

让 agent-deck 应用层自带一套 CLAUDE.md + skill 配置（`resources/claude-config/`），通过 SDK 的 `systemPrompt.append` 与 `plugins` 字段注入到**所有应用内会话**，与 cwd 无关。CLAUDE.md 内容首版直接复制 `~/.claude/CLAUDE.md`（5 条用户全局工程偏好）；skill 仅放一个占位 `hello-from-deck` 验证链路。同步去掉用户自定义 systemPrompt 功能（避免 isolation mode 与 agent-deck 约定冲突）。

## 变更内容

### 资源骨架（resources/claude-config/）
- 新增 `resources/claude-config/CLAUDE.md`：暂时复制 `~/.claude/CLAUDE.md`（5 条全局工程偏好），头部加 HTML 注释说明用途与注入位置
- 新增 `resources/claude-config/agent-deck-plugin/.claude-plugin/plugin.json`：最小 manifest（name `agent-deck`、version `0.1.0`、description）
- 新增 `resources/claude-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md`：占位 skill，触发时回 `Agent Deck 自带 skill 已就绪：hello-from-deck`，仅用于验证 plugin 加载链路

### SDK 注入工具（src/main/adapters/claude-code/sdk-injection.ts，新增）
- `getAgentDeckPluginPath()`：返回 plugin 根绝对路径，用 `app.isPackaged` 分流 —— prod 走 `process.resourcesPath/claude-config/agent-deck-plugin`，dev 走 `app.getAppPath()/resources/claude-config/agent-deck-plugin`
- `getAgentDeckSystemPromptAppend()`：读 `claude-config/CLAUDE.md` 文本，包成「---  Agent Deck 应用约定（随应用打包，独立于 user/project/local CLAUDE.md）---」前缀的字符串，缓存到内存（只读一次）；失败兜底返回空字符串 + console.warn，不阻塞会话创建
- 选 extraResources 而不是 asar 内嵌的理由：SDK CLI 子进程会扫描 plugin 目录的 SKILL.md / plugin.json 等文件，asar fs 行为依赖 Electron 自带 patch，在 spawn 出来的 CLI 子进程里不一定可靠

### SDK Bridge 注入（src/main/adapters/claude-code/sdk-bridge.ts）
- `createSession` opts 接口删 `systemPrompt?: string`
- query options 删 `systemPrompt: opts.systemPrompt`，改用 `systemPrompt: { type: 'preset', preset: 'claude_code', append: getAgentDeckSystemPromptAppend() }` —— 保留 Claude Code 默认 system prompt（工具描述/tone/安全约定），把 agent-deck 自带 CLAUDE.md 追加到末尾
- query options 新增 `plugins: [{ type: 'local', path: getAgentDeckPluginPath() }]` —— 把 agent-deck 自带 skill 注入到所有会话
- 在 import 区段补 `getAgentDeckPluginPath, getAgentDeckSystemPromptAppend`
- **CLAUDE.md 实际位置**：在 user/project/local 三层 CLAUDE.md 全部加载完之后；SDK 不支持中间插入，但 LLM 上下文末尾位置 instruction following 最强
- **Skill 命名空间**：`agent-deck:<skill-name>`，与用户 `~/.claude/skills/` + 项目 `.claude/skills/` 不冲突（plugin 强制命名空间前缀）

### Summarizer 边界对照（src/main/session/summarizer.ts，**未改动**）
- 保持 `settingSources: []` + 自己的精心设计 systemPrompt 的 isolation 模式
- 不加 plugins、不改 systemPrompt：多余 skill 会引诱模型乱调，多余 CLAUDE.md 会污染总结质量

### 去掉自定义 systemPrompt 功能
- `src/main/adapters/types.ts`：`CreateSessionOptions` 删 `systemPrompt?: string`
- `src/main/cli.ts`：删 `CliNewSession.systemPrompt`、`--system-prompt` flag 解析、传给 createSession 的字段
- `src/renderer/components/NewSessionDialog.tsx`：删 `systemPrompt` state、`setSystemPrompt`、IPC 提交字段、整个「System Prompt（可选）」Field UI
- `src/main/ipc.ts` 与 `src/preload/index.ts`：**未改动**（用的是泛型 `Parameters<NonNullable<typeof adapter.createSession>>[0]` / `Record<string, unknown>`，自动跟着 adapter 接口走）
- 理由：用户传 string 模式 systemPrompt 会进 SDK isolation mode（完全替换默认 system prompt），与 agent-deck 自带 CLAUDE.md 注入直接冲突；与其加分支处理两种语义，不如索性砍掉

### 打包配置（package.json）
- `build.extraResources` 数组追加 `{ "from": "resources/claude-config", "to": "claude-config", "filter": ["**/*"] }` —— 与现有 `resources/bin → bin` 同模式，让 `claude-config` 出现在 `.app/Contents/Resources/claude-config/`

### 文档（README.md）
- 「应用内新建会话」节去掉「System Prompt（可选）」字段描述，加一行说明「不再支持自定义 systemPrompt」
- 「命令行新建会话」节 CLI 用法表去掉 `[--system-prompt "..."]`
- 「Claude Code SDK 通道」节加一句指向新章节，新增独立小节「Agent Deck 自带 CLAUDE.md + skill 注入」详述机制
- 「项目结构」节 sdk-bridge 同级补 sdk-injection.ts；resources/ 部分加 claude-config/ 树
