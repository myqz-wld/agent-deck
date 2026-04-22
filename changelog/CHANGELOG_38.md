# CHANGELOG_38: MCP 图片工具支持（ImageRead / ImageWrite / ImageEdit / ImageMultiEdit）

## 概要

接入「本地 MCP server 暴露的图片处理工具」端到端链路：识别 `mcp__<server>__Image*` 工具名 → 解析 `tool_result` 的结构化 JSON → 翻译成 `file-changed` 事件（payload 是 `ImageSource` 不带二进制）→ renderer 通过 `window.api.loadImageBlob` 按需读盘渲染。复用现有「文本工具 → DiffPayload → DiffRegistry」链路（`kind:'image'` 早就预留好），把占位的 `ImageDiffRenderer` 替换为真实的 side / after-only / slide 三视图实现，并新增 `ImageThumb` / `ImageBlobLoader` 通用组件 + `SessionContext` 把 sessionId 注入给图片渲染器。MCP server 单独维护（不在本仓库），按 `src/shared/types.ts` 的 `ImageToolResult` 协议实现即可被 agent-deck 自动接入。

## 变更内容

### 共享层（src/shared/）
- `types.ts` 新增三个类型：
  - `ImageSource = { kind:'path'; path } | { kind:'snapshot'; snapshotId }`（snapshot 二期预留）
  - `ImageToolResult` 联合类型（image-read / image-write / image-edit / image-multi-edit），含 `file`（用户视角真实路径）+ `beforeFile`/`afterFile`（server 自管快照路径）
  - `LoadImageBlobResult`：`{ok:true,dataUrl,mime,bytes} | {ok:false,reason:'enoent'|'too_big'|'denied'|'invalid_ext'|'io_error'|'unsupported_source',detail?}`
- `mcp-tools.ts`（新建）：`IMAGE_TOOL_SUFFIXES` 常量 + `isImageTool(name)` / `imageToolSuffix(name)`，main + renderer 共用
- `ipc-channels.ts`：新增 `IpcInvoke.ImageLoadBlob = 'image:load-blob'`

### 主进程翻译层（src/main/adapters/claude-code/）
- `translate.ts`：
  - 新增 `parseImageToolResult(content)`：兼容 `string` / `Block[]` 两种 `tool_result.content` 形态，找出第一个能 JSON.parse 出 `kind: 'image-*'` 的对象
  - 新增 `imageResultToFileChanges(result, toolUseId)`：按 4 种 kind 翻译成 0~N 条 file-changed payload
    - `image-read` → 0 条（不进 file_changes 表，由活动流缩略图覆盖）
    - `image-write` → 1 条：before=null, after={kind:'path', path:result.file}
    - `image-edit` → 1 条：before/after 各指向 server 快照路径
    - `image-multi-edit` → N 条，**filePath 都用 result.file**（让 SessionDetail 按文件分组聚合到一起，ChangeTimeline 展示演进），metadata 带 `editIndex/total/prompt`
  - `translatePostToolUse` switch 末尾追加 `else if (isImageTool(p.tool_name))` 分支（hook 通道入口）
- `sdk-bridge.ts`：
  - `InternalSession` 加 `toolUseNames: Map<string, string>`：SDK 的 `tool_result` block 只带 `tool_use_id` 不带 toolName，必须靠 `assistant.tool_use` 时记录、`tool_result` 时反查
  - `consume()` 把 `internal` 透传给 `translate()`，`translate()` 签名加第三个参数
  - `assistant.tool_use` 处理时 `internal.toolUseNames.set(block.id, block.name)`
  - `user.tool_result` 处理时新增 `maybeEmitImageFileChanged(emit, internal, tool_use_id, content)`：反查 toolName → `isImageTool` → `parseImageToolResult` → 逐条 emit `file-changed` → 消费后 `delete(toolUseId)` 防内存泄漏

### 主进程入库（src/main/session/manager.ts）
- `ingest()` 的 file-changed 入库块：把 before/after 的类型从 `string|null` 改成 `unknown`，新增 `serialize()` helper（字符串原样、对象 JSON.stringify、null 返 null）。`file_changes.before_blob/after_blob` 列已经是 TEXT，无需 migration

### 主进程 IPC（src/main/ipc.ts）
- 新增 `image:load-blob` handler + `loadImageBlob()` + `isPathInSessionWhitelist()` helper
- 安全门：
  - **白名单 1**：path 出现在该 session 的 `file_changes`（filePath 或 image kind blob 反序列化后的 ImageSource.path）
  - **白名单 2**：path 出现在该 session 任意 `tool-use-start` 事件的 `toolInput.file_path`（覆盖 ImageRead 这条不进 file_changes 的路径）
  - 扩展名 ∈ `{png, jpg, jpeg, gif, webp, bmp, heic, heif, svg}`
  - `realpath` 解符号链接，size ≤ 20 MB
  - 失败返回 `{ok:false, reason}` 不抛错（由 UI 显示「图片不可读」灰底兜底，覆盖 server 清理快照后的兼容场景）

### Preload（src/preload/index.ts）
- `window.api` 加 `loadImageBlob(sessionId, source: ImageSource): Promise<LoadImageBlobResult>`
- `AgentDeckApi = typeof api` 自动推断，d.ts 不用动

### Renderer 通用组件
- `src/renderer/components/diff/SessionContext.ts`（新建）：`createContext<string>('') + SessionIdProvider + useDiffSessionId()`，把当前 sessionId 注入给嵌套的 diff renderer，避免给所有 renderer 改签名
- `src/renderer/components/diff/renderers/ImageBlobLoader.tsx`（新建）：render-prop 模式 + 模块级 LRU 缓存（max 50，按 `sessionId|JSON.stringify(source)` key），effect 内带 abort flag
- `src/renderer/components/ImageThumb.tsx`（新建）：通用缩略图组件（xs/sm/md/lg 四种尺寸），包装 `ImageBlobLoader`，加载中脉冲灰底、失败显示 reason 文字

### Diff 层
- `src/renderer/components/diff/DiffViewer.tsx`：接受可选 `sessionId?: string`，用 `SessionIdProvider` 包裹具体 renderer
- `src/renderer/components/diff/renderers/ImageDiffRenderer.tsx`：替换占位为真实实现
  - 顶部 header：filePath、`NEW` 标签（before == null = ImageWrite 新增）、`#i/N` 标签（ImageMultiEdit 演进步骤）、prompt（来自 metadata）、模式切换按钮
  - **side** 模式（默认）：grid-cols-2 左右并排
  - **after-only** 模式：单图展示
  - **slide** 模式：占位「待实现」（二期接 react-compare-slider）
  - 内部 `useDiffSessionId()` 拿 sid 传给 `ImageBlobLoader`

### Renderer 工具卡片识别
- `ActivityFeed.tsx`：
  - `describeToolInput` switch 的 default 分支兜底：`if (isImageTool(toolName) && o.file_path) return o.file_path`
  - `toolInputToDiff` 改返回类型为 `DiffPayload<string|null> | DiffPayload<ImageSource|null> | null`，末尾追加 `if (isImageTool(toolName) && i.file_path) { ... }` 分支：
    - `endsWith('__ImageRead')` → 返回 `{ kind:'image', filePath, before:null, after:{kind:'path', path:i.file_path} }`，驱动 ToolStartRow 直接渲染缩略图
    - 其他图片工具 input 阶段无 beforeFile，返 null 等 file-changed 事件
  - `ToolStartRow` 加 `sessionId` prop，`ActivityRow` 透传
  - `ToolStartRow` 与 `PermissionRow` 的 `<DiffViewer payload={diff} />` 都加 `sessionId={sessionId}`
- `SessionCard.tsx` `summariseToolInput` switch 的 default 分支：`if (isImageTool(toolName) && o.file_path) return shortenPath(o.file_path)`
- `SessionDetail.tsx`：`diffPayload` 去掉 `<string|null>` 硬编码，新增 `decodeBlob(kind, blob)` helper（`kind === 'image'` 时 try JSON.parse，其余原样），`<DiffViewer>` 加 `sessionId={session.id}`

### 不动
- `db.ts`（TEXT 列够装 JSON.stringify(ImageSource)，无需 migration）
- `file-change-repo.ts`（业务层在 manager.ts ingest 已经 serialize 完）
- `hook-routes.ts`（translate.ts PostToolUse 已经覆盖 mcp 图片工具）
- `main/index.ts`（无需 startup 主动检测：dispatcher 看到工具名就接管，没装 MCP server 就根本不会出现这种工具调用）

## MCP server 协议契约（写给另一仓库的实现者）

### 工具命名（后缀匹配，server 名不锁死）
- `mcp__<server>__ImageRead` / `ImageWrite` / `ImageEdit` / `ImageMultiEdit`

### Input
- ImageRead: `{ file_path }`
- ImageWrite: `{ file_path, ...server 自定义 }`
- ImageEdit: `{ file_path, prompt }`
- ImageMultiEdit: `{ file_path, edits: [{ prompt }] }`（所有 edits 串行作用在同一张图上）

### Output（`tool_result.content` 里放一个 text block，text 是下面 JSON.stringify 的结果）
```ts
type ImageToolResult =
  | { kind: 'image-read';  file: string; mime?: string; width?: number; height?: number }
  | { kind: 'image-write'; file: string; mime?: string }
  | { kind: 'image-edit';  file: string; beforeFile: string; afterFile: string; prompt: string; mime?: string }
  | { kind: 'image-multi-edit'; file: string; edits: { beforeFile: string; afterFile: string; prompt: string }[] };
```
- 所有路径必须是**绝对路径**
- `beforeFile` / `afterFile` 是 server 自管快照目录里的副本（agent-deck 不复制不清理；快照保留时长建议至少到会话 closed）
- `image-multi-edit` 中第 i 条的 `beforeFile` == 上一条的 `afterFile`（i=0 时 = 原图快照），最终磁盘 `file` 内容 == 最后一条的 `afterFile`
