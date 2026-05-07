# CHANGELOG_60: 输入框图片附件支持（粘贴 / 拖放 / 上传 三件套）

## 概要

ComposerSdk（会话主输入框）+ NewSessionDialog（新建会话首条 prompt）支持「粘贴 / 拖放 / 上传按钮」三件套发图。Claude SDK 直接走 base64 image content block；codex SDK 只接 `local_image` path，主进程把 base64 落盘到 `<userData>/image-uploads/<uuid>.<ext>` 喂下游。历史 user message 在 detail view 里能看到自己发了什么图。

## 变更内容

### 共享类型 (`src/shared/types/`)

- 新建 `attachment.ts`：`UploadedAttachmentInput`（renderer→IPC，base64+mime+bytes）+ `UploadedAttachmentRef`（落盘后引用，path+mime+bytes）+ `UserMessageEnvelope`
- `types.ts` barrel re-export 接入

### 主进程基础设施 (`src/main/`)

- 新建 `paths.ts` 集中管理 userData 子路径（`getImageUploadsDir`），不主动迁移现有 `app.getPath('userData')` 调用方
- 新建 `store/image-uploads.ts`：
  - `writeUploadedImage` — base64 → 落盘到 `<userData>/image-uploads/<uuid>.<ext>`
    - 校验链：mime 反查 ext（不接 renderer 传 ext，杜绝 `.png\x00.exe` 注入）+ base64 实测字节对账 + 单图 ≤ 20MB
  - `loadUploadedImage` — 严格五步加载：realpath → `real.startsWith(uploadsDir + sep)` 严格前缀（防 `<dir>image` 误通过）→ ext 白名单 → 单 fd open/stat/readFile
  - `reapStaleUploads` — bootstrap 启动时按 mtime > 14 天清孤儿
  - `deleteUploadIfExists` — 失败兜底删（仅清 image-uploads 下文件）
- 新建 `ipc/_image-constants.ts` 抽出 `ALLOWED_IMAGE_EXTS / MIME_BY_EXT / MAX_IMAGE_BYTES`（旧 `ipc/images.ts` 与新 `image-uploads.ts` 共享一份事实）+ `ALLOWED_UPLOAD_MIMES`（用户上传收紧到 4 种：png/jpeg/gif/webp，与 Claude SDK Base64ImageSource 限制对齐）+ `PREFERRED_EXT_BY_MIME` + `MAX_TOTAL_ATTACHMENTS_BYTES = 30MB`
- `index.ts` bootstrap 后 `void reapStaleUploads()`（fire-and-forget）

### IPC 层 (`src/main/ipc/`, `src/preload/`, `src/shared/ipc-channels.ts`)

- 新增 `IpcInvoke.UploadedImageLoad` channel
- `images.ts`：注册新 IPC handler
- `adapters.ts`：
  - `AdapterCreateSession` 接 `opts.attachments` → `persistAttachments` 写盘 → 透传给 adapter；createSession throw 时回滚已写文件
  - `AdapterSendMessage` 第三参从 `text: string` 扩成 `string | {text, attachments?}`（向后兼容老调用方）；sendMessage throw 时回滚已写文件
  - `persistAttachments` helper：校验数组 / 元素 shape / 总字节 ≤ 30MB / ≤ 20 张
- `preload/index.ts`：`sendAdapterMessage` 签名扩 envelope；新增 `loadUploadedImage(path)`

### Adapter 层 (`src/main/adapters/`)

- `types.ts`：`AgentAdapter.sendMessage` 加第三参 `attachments?: UploadedAttachmentRef[]`；`CreateSessionOptions.attachments?` 字段
- `claude-code/sdk-bridge/`:
  - `types.ts` `pendingUserMessages` 类型从 `SDKUserMessage[]` 改 `PendingUserMessage[]`（thunk: `() => Promise<SDKUserMessage>`）
  - `stream-processor.ts` `makeUserMessage(sessionId, text, attachments?)` 返回 thunk —— **HIGH-2 修法**：纯文本同步 resolve，带图 thunk 内 `await fs.readFile + base64`，consumer `createUserMessageStream` yield 前 `await thunk()`。保证：① 队列内存只存 path 不常驻 30MB×N base64 ② SDK consume 完即 GC base64 ③ FIFO 顺序保留（thunk 入队同步）
  - `recoverer.ts` **HIGH-1 修法**：`SendMessageThunk` 三参签名 + `recoverAndSend(sessionId, text, attachments?)` + 第二条等待者 `sendThunk(sessionId, text, attachments)` 透传 + createThunk attachments 透传（jsonl 缺失 fallback + 正常 resume 两路均带）
  - `index.ts` `sendMessage / createSession` 接 attachments + emit message event payload 加 attachments 字段
  - `claude-code/index.ts` adapter facade 同步扩签名
- `codex-cli/sdk-bridge/`:
  - `types.ts` `pendingMessages: Input[]`（codex SDK 原生类型 `string | UserInput[]`）
  - `index.ts` `sendMessage / createSession` 接 attachments → `packCodexInput(text, attachments)` 包成 Input（带图时 `[{type:'local_image', path}, ..., {type:'text', text}]`）。MAX_MESSAGE_BYTES 仅算 text 节字节
  - `index.ts` `closeSession` 抽队列残留 attachments path → fire-and-forget unlink（reduce 孤儿，reaper 14 天兜底）
  - `thread-loop.ts` `runStreamed(input)` 自动适配 Input 类型；startNewThreadAndAwaitId 新增 `promptText` + `attachments` 参数，emit message event payload 带 attachments
  - `codex-cli/index.ts` adapter facade 同步扩签名
- 落盘后路径喂下游：claude SDK lazy readFile + base64；codex SDK 直接 path

### Renderer 层 (`src/renderer/`)

- 新建 `hooks/useImageAttachments.ts`：粘贴 / 拖放 / 上传按钮三件套统一 hook
  - state: `{id, thumbnailDataUrl, mime, bytes}`（缩略图 200px canvas-resize，gif 跳过 resize 保留动图）
  - **完整 base64 通过 useRef Map 持有不进 React state**（HIGH-2 配套 renderer 端：避免 30MB×N 进 state 触发整组件 re-render）
  - mime 收口在 hook 层（4 种支持格式 + 单图 20MB / 总图 30MB）；IPC 层会再校验
  - `toIpcInputs()` send 时取 fullBase64 转 IPC 入参
- 新建 `hooks/useImageBlob.ts`：抽出 `ImageBlobLoader` 的 cache + loading + abort 状态机为通用 hook（`createImageBlobCache` 工厂建独立 namespace；`useImageBlob(loader, key, cache)`）。`ImageBlobLoader` 重构走新 hook
- 新建 `components/UploadedImageThumb.tsx`：用户上传图片的缩略图组件，走 `loadUploadedImage(path)` IPC + 独立 cache + 失败灰底（图片已被 reaper 清 / 用户磁盘删 / etc）
- `SessionDetail/ComposerSdk.tsx` 接入 hook：textarea `onPaste/onDrop/onDragOver` + 缩略图 strip（删除按钮）+ 上传按钮（hidden file input + label）；send 失败回填文字但 attachments 不回填（base64 已 clear）
- `NewSessionDialog.tsx` 接入同款；缩略图 strip + 「🖼 添加图片」按钮单独一行避免挤压首条消息区
- `activity-feed/rows/message-row.tsx` MessageBubble：`role='user'` 且 `payload.attachments?.length > 0` 时文字下方栅格渲染缩略图。**无 schema migration**：老 events 行 `payload.attachments=undefined`，optional chaining 自然等价于无图

## 验证

- `pnpm typecheck` 全过（node + web）
- `pnpm build` 全过（main 305KB / preload 19KB / renderer 1.2MB）
- 手测 golden path 待用户重启 dev 后跑（main / preload 改动必须重启）：
  1. ComposerSdk 粘贴截图 → 缩略图出现 → 发送 → Claude 回复描述图片内容
  2. ComposerSdk 拖放磁盘图片 / 上传按钮选 PNG → 同上
  3. NewSessionDialog 三件套同款验证（先 codex 再 claude）
  4. 切到 codex agent 重做 1-3
  5. 历史 detail view 翻刚发的 user message → 缩略图正确显示
  6. SDK 子进程 kill 后再发一条带图 → 自动恢复 + attachments 透传到第二条（HIGH-1 验证）

## 备注

- **不在范围**：SendToTeammate（lead 通常文字描述任务即可，对称改未来需要时补）；大图 lightbox（MVP 不做）
- **设计取舍**：
  - 落盘扁平 `<userData>/image-uploads/<uuid>.<ext>`（不按 sessionId 分目录）— 因 NewSessionDialog 路径 attachments 在 sessionId 存在前就要落盘喂 SDK，扁平避免「先写 _pending → 拿到 realId 再 mv」复杂度
  - cleanup 仅 bootstrap reaper（14 天 mtime）+ codex closeSession 残留 unlink。session delete 不主动清（events CASCADE 删 payload，path 没人引用 → reaper 兜底）
  - 单消息 100KB text 上限不动（attachments 走 30MB 独立 cap），保持 grep 站点稳定
- **mime 收紧到 4 种**（png/jpeg/gif/webp）：Claude API Base64ImageSource 限制；codex 同款实际接受（非官方 doc，但 vision 模型支持的常见格式）。未来扩支持需双 SDK 实测验证
