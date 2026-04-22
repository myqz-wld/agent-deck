# CHANGELOG_39: 图片工具语义修正（vision / 文生图 / 图生图）+ ImageRead UI

## 概要

CHANGELOG_38 把 mcp 图片工具语义猜成「读元数据 / 写 base64 / 编辑文本水印」，与真实意图（**ImageRead = vision LLM 理解图片；ImageWrite = 文生图；ImageEdit = 图生图；ImageMultiEdit = 同图多次图生图**）完全错开。本次：

1. **修订 `ImageToolResult` 协议**：`image-read` 加 `description: string`（LLM 描述）；所有 4 个 kind 加可选 `provider` / `model` 字段便于 UI 标注
2. **ToolEndRow 新增 ImageRead 卡片渲染**：在收到 `image-read` 结果时左 `ImageThumb` 缩略图、右 LLM 描述并排展示，header 标 `[provider · model]`
3. **`imageResultToFileChanges` 把 prompt / provider / model 透传到 metadata**，让 `ImageDiffRenderer` 之后能在 header 显示完整上下文
4. 新增独立仓库 [`agent-deck-image-mcp`](../../agent-deck-image-mcp/)（在 `~/Repository/personal/` 下）实现真正的工具：Gemini provider 落地（vision = `gemini-2.5-flash`，生图 / 编辑 = `gemini-2.5-flash-image-preview`），通过 `IMAGE_READ_PROVIDER` / `IMAGE_GEN_PROVIDER` / `IMAGE_EDIT_PROVIDER` ENV 路由，预留 OpenAI / OpenRouter 扩展位

## 变更内容

### 共享层（src/shared/types.ts）
- `ImageToolResult.image-read` 加 `description: string`（必填）
- 4 个 kind 都加可选 `provider?: string` 与 `model?: string`
- `ImageWrite` 协议明确：input 是 `(file_path, prompt)`，**不再有 `image_data`**；output 加 `prompt: string`（透传给 UI）
- `ImageEdit` / `ImageMultiEdit` 同上加 `provider` / `model`，整体 schema 与 [agent-deck-image-mcp/src/protocol.ts](../../agent-deck-image-mcp/src/protocol.ts) 一致

### 主进程翻译层（src/main/adapters/claude-code/translate.ts）
- `imageResultToFileChanges` 把 `result.provider` / `result.model` / `result.prompt` 全部透传到 file-changed payload 的 `metadata`
- `image-write` 现在也带 `prompt` metadata（CHANGELOG_38 漏了，那时以为 input 是 `image_data` 没有 prompt）

### Renderer（src/renderer/components/ActivityFeed.tsx）
- `ToolEndRow` 加 `sessionId` prop，`ActivityRow` 透传
- 新增 `parseImageReadResult()` 函数：从 `tool_result.content` 里宽松提取 ImageRead 的结构化数据
- 当 toolResult 解析为 `image-read` 时：header 显示 `🖼 ImageRead [provider · model] 完成`，下方布局 `<ImageThumb size="md">` + 滚动描述区
- 复用 `ImageThumb`（CHANGELOG_38 已建）+ `loadImageBlob` 白名单（路径已经在 `tool-use-start` 事件里出现过，自动通过）
- import 加 `ImageThumb`

### 配套 MCP server（agent-deck-image-mcp，独立仓库）
路径：`~/Repository/personal/agent-deck-image-mcp/`，与本仓库**无源码耦合**，仅按协议契约对接。
- `src/lib/providers/types.ts`：`VisionProvider` / `ImageGenProvider` / `ImageEditProvider` 三个接口
- `src/lib/providers/gemini.ts`：Gemini 三合一实现（共用 `GEMINI_API_KEY`，vision 用 `gemini-2.5-flash`，生图 / 编辑用 `gemini-2.5-flash-image-preview`）
- `src/lib/providers/index.ts`：按 ENV 路由（默认全 gemini，可独立配 read/gen/edit）
- `src/tools/image-read.ts`：调 vision provider，返回 `description`
- `src/tools/image-write.ts`：调 gen provider，写盘
- `src/tools/image-edit.ts`：snapshot before → 调 edit provider → 写回 + snapshot after
- `src/tools/image-multi-edit.ts`：链式 edit
- `src/snapshots.ts`：自管 `~/.agent-deck-image-mcp/snapshots/<sha256>.<ext>`，去重 + 原子写

注册方式（写到 `~/.claude/settings.json`）：
```json
{
  "mcpServers": {
    "agent-deck-image": {
      "command": "node",
      "args": ["/Users/.../agent-deck-image-mcp/dist/index.js"],
      "env": { "GEMINI_API_KEY": "..." }
    }
  }
}
```
注册后工具名 = `mcp__agent-deck-image__ImageRead` 等，agent-deck 按后缀识别（`endsWith('__ImageRead')` 等），server 名不锁死。

### 不动
- `mcp-tools.ts` `IMAGE_TOOL_SUFFIXES`（CHANGELOG_38 已建好）
- `ImageDiffRenderer` / `ImageBlobLoader` / `SessionContext`（CHANGELOG_38 已建好，复用没改）
- DB schema、IPC handler、SDK bridge tool_result 反查（CHANGELOG_38 框架仍然适用）
- README「MCP 图片工具支持」节内容仍准确（描述的是协议 + 渲染 hooks，没提具体语义）

## 验证

1. `cd ~/Repository/personal/agent-deck-image-mcp && pnpm install && pnpm build`
2. 把 dist 路径写进 `~/.claude/settings.json` 的 `mcpServers`
3. `cd ~/Repository/personal/agent-deck && pnpm dev` 起 agent-deck
4. 新建会话，prompt：「用 ImageRead 读 /tmp/test.png」→ 活动流出现「🖼 ImageRead [gemini · gemini-2.5-flash] 完成」+ 缩略图 + 描述
5. prompt：「用 ImageWrite 在 /tmp/cat.png 生成一只橘猫」→ file-changed 出现，DiffViewer 显示新图（before=null，NEW 标签）
6. prompt：「用 ImageEdit 把 /tmp/cat.png 改成黑白」→ DiffViewer 左右对比 before/after，header 显示 prompt
7. 安全验证仍生效：DevTools 调 `window.api.loadImageBlob('xxx', {kind:'path', path:'/etc/passwd'})` 仍返回 `{ok:false, reason:'denied'}`
