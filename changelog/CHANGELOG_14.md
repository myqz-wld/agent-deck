# CHANGELOG_14: Adapter / 自带 CLAUDE.md / Codex / 图片工具

## 概要

合并原 CHANGELOG_36（自带 CLAUDE.md + skill 注入）+ CHANGELOG_38（MCP 图片工具支持）+ CHANGELOG_39（图片工具语义修正：vision/文生图/图生图）+ CHANGELOG_41（Codex CLI adapter）+ CHANGELOG_42（CLAUDE.md UI 编辑 + 异构对抗 + 修 PendingTab 跳转）+ CHANGELOG_43（thinking 单独识别 + pin one-shot 强刷 + 修打包 codex spawn ENOTDIR）。一组扩展能力线：Adapter 抽象 → 自带 CLAUDE.md/skill → Codex CLI 接入 → MCP 图片工具 → thinking 类型 → 各类追加修复。

## 变更内容

### 自带 CLAUDE.md + skill 注入（原 CHANGELOG_36）

- 新增 `resources/claude-config/` 资源骨架：`CLAUDE.md`（首版复制 `~/.claude/CLAUDE.md`） + `agent-deck-plugin/.claude-plugin/plugin.json`（最小 manifest） + `skills/hello-from-deck/SKILL.md`（占位验证链路）
- 新文件 `src/main/adapters/claude-code/sdk-injection.ts`：`getAgentDeckPluginPath()` 用 `app.isPackaged` 分流（prod `process.resourcesPath/claude-config/...`，dev `app.getAppPath()/resources/...`）+ `getAgentDeckSystemPromptAppend()` 读 CLAUDE.md 包成「---  Agent Deck 应用约定 ---」前缀缓存到内存
- `sdk-bridge.ts` query options：删 `systemPrompt: opts.systemPrompt` 改用 `systemPrompt: { type: 'preset', preset: 'claude_code', append: getAgentDeckSystemPromptAppend() }`；新增 `plugins: [{ type: 'local', path: getAgentDeckPluginPath() }]`
- 同时**砍掉用户自定义 systemPrompt 功能**：用户传 string 模式 systemPrompt 会进 SDK isolation mode（完全替换默认 system prompt），与自带 CLAUDE.md 注入直接冲突；与其加分支处理两种语义不如索性砍掉
- `package.json build.extraResources` 加 `{from:'resources/claude-config', to:'claude-config', filter:['**/*']}`

### MCP 图片工具支持（原 CHANGELOG_38）

- 接入「本地 MCP server 暴露的图片处理工具」端到端链路：识别 `mcp__<server>__Image*` 工具名 → 解析 `tool_result` 的结构化 JSON → 翻译成 `file-changed` 事件（payload 是 `ImageSource` 不带二进制）→ renderer 通过 `window.api.loadImageBlob` 按需读盘渲染
- shared：`ImageSource` / `ImageToolResult`（image-read/write/edit/multi-edit 联合）/ `LoadImageBlobResult`；`mcp-tools.ts` 新建 `IMAGE_TOOL_SUFFIXES` + `isImageTool(name)` / `imageToolSuffix(name)`；`ipc-channels.ts` 加 `ImageLoadBlob`
- 主进程翻译：`translate.ts` 新增 `parseImageToolResult` + `imageResultToFileChanges`（4 种 kind 翻译成 0~N 条 file-changed payload；`image-multi-edit` 全部 filePath 用 `result.file` 让 SessionDetail 按文件分组聚合）；`sdk-bridge.ts` 加 `toolUseNames: Map<id, name>` 反查（SDK 的 `tool_result` block 只带 tool_use_id 不带 toolName）
- 主进程 IPC `image:load-blob`：白名单 1（path 出现在该 session 的 `file_changes`）+ 白名单 2（path 出现在任意 `tool-use-start` 事件的 `toolInput.file_path`）+ 扩展名 + `realpath` 解符号链接 + size ≤ 20 MB
- Renderer 通用组件：`SessionContext`（`createContext<string>` + `SessionIdProvider` + `useDiffSessionId()`） + `ImageBlobLoader`（render-prop + 模块级 LRU 50） + `ImageThumb`（xs/sm/md/lg 四种尺寸）
- `ImageDiffRenderer.tsx` 替换占位为真实实现：side（grid-cols-2）/ after-only / slide（待实现）三视图

### 图片工具语义修正（原 CHANGELOG_39）

- CHANGELOG_38 把 mcp 图片工具语义猜成「读元数据 / 写 base64 / 编辑文本水印」，与真实意图（**ImageRead = vision LLM 理解图片；ImageWrite = 文生图；ImageEdit = 图生图；ImageMultiEdit = 同图多次图生图**）完全错开
- `types.ts`：`image-read` 加 `description: string`（必填 LLM 描述）；4 个 kind 都加可选 `provider?: string` / `model?: string`；`ImageWrite` input 是 `(file_path, prompt)` 不再有 `image_data`
- `translate.ts imageResultToFileChanges` 把 provider/model/prompt 全部透传到 metadata
- `ToolEndRow` 加 `sessionId` prop，新增 `parseImageReadResult()`，当 toolResult 为 `image-read` 时左 `<ImageThumb size="md">` + 右滚动描述区，header 标 `[provider · model]`
- 配套独立仓库 `agent-deck-image-mcp`（不在本仓库）：Gemini provider 落地（vision = `gemini-2.5-flash`，生图/编辑 = `gemini-2.5-flash-image-preview`），按 ENV 路由

### Codex CLI adapter（原 CHANGELOG_41）

- 把 `src/main/adapters/codex-cli/` 从 30 行占位填实为可用 adapter，基于 `@openai/codex-sdk`。"诚实对等"实现：能做的全做，SDK 物理不支持的（工具批准回调 / AskUserQuestion / ExitPlanMode / 运行时切权限模式 / hook 安装）capabilities=false UI 自动隐藏
- 真实能力（双对抗 Agent 直接读 codex 源码核实）：`canCreateSession=true / canInterrupt=true / canSendMessage=true / canInstallHooks=false / canRespondPermission=false / canSetPermissionMode=false`
- 4 个新文件：`sdk-loader.ts`（复刻 claude-code 同名文件）/ `translate.ts`（codex `ThreadEvent` / `ThreadItem` → `AgentEvent` 纯函数，覆盖 8 种事件 + 8 种 item）/ `sdk-bridge.ts`（`CodexSdkBridge`：同 thread 串行 turn `pendingMessages` 队列，每 turn 一个 `AbortController` SIGTERM 中断；新建路径 thread_id 同步用 tempKey + 30s fallback；resume 路径直接拿 id）/ `index.ts`（`CodexCliAdapterImpl`，capabilities 按真实能力填，默认安全策略写死 `approvalPolicy='never' + sandboxMode='workspace-write'`）
- Adapter 接口加 `setCodexCliPath?(path: string|null)`；`AppSettings.codexCliPath: string|null`（默认 null 用应用内置 codex）
- IPC：`DialogChooseExecutable`；preload `chooseExecutableFile`；`SettingsSet` 分发
- Renderer：SettingsDialog 新加「外部工具」section 含 `ExecutablePicker`；NewSessionDialog 加 `selectedAdapter` 计算 + `showModel`（仅 claude-code）/ `showPermissionMode`（按 capabilities）；SessionDetail ComposerSdk 加 `agentDisplayName` (`'Codex'`/`'Claude'`)；SessionList 欢迎文案补「点 ＋ 新建会话（可选 Claude / Codex）」
- 包体积 +150MB（darwin-arm64 vendored binary）

### CLAUDE.md UI 编辑 + 异构对抗（原 CHANGELOG_42）

- 自带 CLAUDE.md 原本只能改源码 + 重新打包，现在通过设置面板新 Section「应用约定（CLAUDE.md）」直接编辑
- `sdk-injection.ts` 新增 `getActiveAgentDeckClaudeMd()`（用户副本优先 → 内置回落） / `getBuiltinAgentDeckClaudeMd()`（恢复默认按钮用） / `saveUserAgentDeckClaudeMd(content)` 写 `userData/agent-deck-claude.md` + 清缓存 / `resetUserAgentDeckClaudeMd()` 删用户副本 + 清缓存 / `invalidateAgentDeckSystemPromptAppend()` 内部用
- IPC 新增 `ClaudeMdGet` / `ClaudeMdSave` / `ClaudeMdReset`
- SettingsDialog 新增 `ClaudeMdEditor` 组件：textarea + 等宽字体 + 保存（无 dirty disabled）/ 撤销（dirty 时显示）/ 恢复默认（isCustom 时显示，destructive 二次确认）
- 内置 CLAUDE.md「对抗 Agent」改为异构：默认一个 Claude（Explore/general-purpose subagent）+ 一个 Codex（Bash 直接调 codex CLI），异构对抗最大化降低同模型偏见
- 同时把「codex CLI 调用约定」整套模板（必加 `--sandbox read-only` + `--skip-git-repo-check` + `-C <项目绝对路径>` + `-o <OUT_FILE>` + `-c model_reasoning_effort="xhigh"` + 长 prompt 走 stdin + macOS 没有 `timeout` 命令必须走 Bash 工具参数）抽出独立 bullet 写入两份 CLAUDE.md
- 追加修复：**修「在会话详情页时点击『待处理』tab 无法跳转」**——「待处理」TabButton onClick 改为 `setView('pending'); select(null);`（不清 selectedSessionId 会被 SessionDetail 优先级盖掉）
- 追加修复：**修「Codex SDK 30 秒未发出 thread_id」误导文案**——`startNewThreadAndAwaitId` 改为三态结算（success / early error / 30s fallback），`runTurnLoop` 加 `onEarlyError` 回调把 SDK 真实 stderr 立即透出，不再等满 30s 显示固定误导文案

### thinking 单独识别（原 CHANGELOG_43）

- 修「Claude assistant 消息里把模型的内部推理（thinking）当成普通 final answer 渲染」的 bug。SDK 同一帧 assistant message 里出现两个 type='text' content block，前者是 prelude（推理草稿），后者才是 final answer
- shared `AgentEventKind` 加 `'thinking'` 联合分支，与 `'message'` 平级；payload 形如 `{ text: string }`
- `sdk-bridge.ts:880-940` `msg.type === 'assistant'` 重写 content block 循环：
  - 真 thinking block：`block.type === 'thinking'` → emit `'thinking' { text: block.thinking }`；`'redacted_thinking'` → `[redacted thinking]`
  - 多 text block 启发式：`block.type === 'text'` 时看下一个紧邻是否另一 text block —— 是 → 当前是 prelude（emit `'thinking'`）；否 → final answer（emit `'message'`）
- `manager.ts nextActivityState` switch 加 `'thinking'` → `'working'`
- `ActivityFeed.tsx`：`MessageRow` 加 `event.kind === 'thinking'` 分支 → `<ThinkingBubble>`：dashed 边框 + 暗背景 + 斜体淡灰文字 + 头部标 `thinking`
- 追加：**codex 也走 thinking** —— `codex-cli/translate.ts` `case 'reasoning'` 从 `emit('message', {...reasoning:true})` 改为 `emit('thinking', {text})`；`MessageBubble` / `ThinkingBubble` 加 `agentId` props，新增 `getAgentShortName(agentId)` helper（codex-cli→'Codex'、aider→'Aider'、generic-pty→'Shell'，default 'Claude'）
- 追加：**修 pin 模式文字残影补 one-shot 强刷** —— `setAlwaysOnTop(value)` 进入 pin 分支从只 `startInvalidateLoop()` 改为先 `kickRepaintAfterPin()`：同步 `setContentSize(width, height + 1)` → `setImmediate` 调回原值，跨 macro task 防 Chromium 同帧 size 去重合并；治 CHANGELOG_11 后仍残留的「进入 pin 那一瞬间旧帧印在玻璃上必须人工拖窗才消失」
- 追加：**修打包后 codex agent 启动报 `spawn ENOTDIR`** —— SDK 二进制定位最终落 `app.asar/.../codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`，spawn 给系统 → ENOTDIR；package.json 新增 `build.asarUnpack` 把 `@openai/codex` launcher + 4 个平台子包都 unpack；`sdk-bridge.ts` 新增 `resolveBundledCodexBinary()` 主进程自己拼 unpacked 物理路径传给 SDK 的 `codexPathOverride` 短路 SDK 内部 resolve；优先级 `用户填的 codexCliPath > resolveBundledCodexBinary() > SDK 默认`

## 备注

- 不持久化「按 message id 存偏好 map」（thinking 默认展开不折叠，先观察用户实际反馈）
- hook 通道不需要改 thinking：双对抗 Agent 已核实 hook 通道完全不解析 transcript
- summarizer 不读 thinking：已经被 final answer 浓缩，再让总结 LLM 读会冗余
- 同 thread 并发限制（codex）：用户多设备同时操作同一会话会撞 `~/.codex/sessions` 文件，MVP 不防护
- interrupt 杀整个进程树：SIGTERM codex 子进程会同时杀正在跑的 shell（`npm install` 等）
- file-changed 无 diff（codex `FileChangeItem` 不暴露 before/after，UI 只能显示「修改了 X 文件」+ changeKind）
