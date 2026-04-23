# CHANGELOG_43: Claude thinking（内部推理）单独识别并弱化渲染

## 概要

修「Claude assistant 消息里把模型的内部推理（thinking）当成普通 final answer 渲染」的 bug。截图现象：同一帧 SDK assistant message 里出现两个 type='text' content block，前者是模型的推理 prelude（`**Responding to a casual greeting**\n\nI think the user just said hello...`），后者才是真正的 final answer（`Hello. What do you need help with?`）。当前 `sdk-bridge.ts` 逐 block emit 'message'，UI 把这两条都渲染成同等地位的 `MessageBubble`，用户感知"Claude 自言自语了一段然后才回答"。

新增 `AgentEventKind = 'thinking'` 第一公民类型贯通 SDK 翻译 → 状态机 → DB → UI 全链路。`sdk-bridge` 双重识别：(1) 标准 Anthropic API 的 `BetaThinkingBlock { type:'thinking', thinking }` 走专用分支；(2) 同一帧出现连续 type='text' block 时，前 N-1 个判定为 thinking-prelude（这是 Claude Code 把 extended thinking 压平成 text 推给 SDK 用户的实际产物形态）。UI 新增弱化样式的 `ThinkingBubble`（dashed 边框 + 暗背景 + 斜体淡灰文字 + 头部标 `thinking`），与 final answer 的 `MessageBubble`（实线边框 + 不淡化）视觉上区分但同时间线展示。

## 变更内容

### shared 类型（`src/shared/types.ts`）

- `AgentEventKind` 加 `'thinking'` 联合分支，与 `'message'` 平级
- 不改 payload 结构：thinking event 的 payload 形如 `{ text: string }`，与 message 共用 `{ text }` 字段约定（少一个 `role`，因为 thinking 永远是 assistant）

### SDK bridge（`src/main/adapters/claude-code/sdk-bridge.ts:880-940`）

`msg.type === 'assistant'` 分支重写 content block 循环：

- **真 thinking block**：`block.type === 'thinking'` → emit `'thinking' { text: block.thinking }`；`'redacted_thinking'` → emit `'thinking' { text: '[redacted thinking]' }`（按 Anthropic API 规范字段名）
- **多 text block 启发式**：`block.type === 'text'` 时，看下一个紧邻 block 是不是另一个 text block——是 → 当前是 thinking-prelude（emit `'thinking'`）；否 → final answer（emit `'message'`）
- **判断条件覆盖矩阵**（已注释在代码里）：
  - `[text, text]` → `[thinking, message]` ✅（用户截图场景）
  - `[text, tool_use]` → `[message]` ✅（"我去查一下" + 工具调用，前面那段不算 thinking）
  - `[text, tool_use, text]` → `[message, message]` ✅（被 tool_use 隔开的两段都是 message）
  - `[text, text, tool_use]` → `[thinking, message]` ✅
  - `[thinking_block, text]` → `[thinking, message]` ✅（真 thinking block 走第一条规则）

### 主进程状态机（`src/main/session/manager.ts:344-347`）

- `nextActivityState` switch 加 `case 'thinking':` 与 `'message' / 'tool-use-start' / 'file-changed'` 同处理 → `'working'`
- 语义：模型在思考 = 在工作，与 final answer 同等触发 active 状态推进

### renderer UI（`src/renderer/components/ActivityFeed.tsx`）

- `MessageRow` 加 `event.kind === 'thinking'` 分支 → `<ThinkingBubble event={event} />`
- 新增 `ThinkingBubble` 组件（紧跟 `MessageBubble` 后面）：
  - 视觉差异：`border-dashed border-deck-border/40 bg-white/[0.02]` + `italic text-deck-muted` —— dashed 边框、更暗背景、斜体淡灰文字
  - 头部 `thinking` 标签代替 `Claude`（uppercase + tracking-wider 等宽字体），时间戳同样位置
  - MD/TXT toggle 复用与 `MessageBubble` 同样的 plaintext / markdown 切换（thinking 也可能是 markdown）
  - 默认展开，不引入折叠（暂时；如果后续用户嫌长再加）

### 不动的地方（写明避免后人重新评估）

- **hook 通道**：双对抗 Agent 已核实 hook 通道（`hook-routes.ts` / `hook-server/`）只处理 6 类 hook 事件 + Notification → waiting-for-user / PostToolUse → tool-use-end，**不解析 transcript 内容**，thinking 永远不会从 hook 通道进入。无需改动。
- **summarizer**（`src/main/session/summarizer.ts`）：thinking 不被 `events.find((e) => e.kind === 'message')`（line 145）匹配，不会被误当成 final answer 拼进 LLM 总结上下文（line 169 `formatEventsForPrompt` 也只 if 'message'）。**有意为之**：thinking 是模型的草稿，已经被 final answer 浓缩，再让总结 LLM 读 thinking 既冗余又会推高 token 成本
- **SessionCard 卡片概要**（`src/renderer/components/SessionCard.tsx:166-193`）：`formatEventLine` switch 没匹配 thinking → 落到 `default: return null`，循环找下一条更具体的事件。语义合理（thinking 不是有信息量的活动，不应抢卡片摘要的位置）
- **DB 持久化**（`src/main/store/event-repo.ts:30`）：generic insert，`kind` 直接存字符串字段，不需要改 schema

## 设计取舍

- **判断条件用「下一个紧邻是不是 text」而不是「数 text block 总数」**：后者会把合理的 `[text, tool_use, text]` 模式（中间被工具隔开的两段说明）误判为「前面是 thinking」；前者只命中真正的连续 text 序列，对所有合理形态都正确
- **不靠文本特征启发式（如 markdown bold 标题前缀）识别 thinking**：模型 final answer 也可能以 `**...**` 标题开头（结构化回答常见），靠文本特征会有误判；而「同一帧多 text block」是 SDK 层面的结构信号，更稳
- **UI 默认展开 thinking 不折叠**：用户现状是看不见 thinking 被独立标记 → 改后能看见且与 final answer 区分开就解决了主要痛点；折叠会引入「点开才能看」的额外操作成本，先观察用户实际反馈再决定要不要加（避免过度设计）
- **不修改 shared payload 结构（不加 `role: 'thinking'`）**：用 kind 字段区分 thinking / message 比 role 字段更对称（kind 是联合类型有 TS 穷举检查，role 加新值要改更多地方）
- **状态机让 thinking 算 'working'**：模型在思考期间，session 应保持 active；如果让 thinking 不切状态，会出现「最后一个事件是 thinking 但 activity 没变 working」的违反直觉行为
- **hook 通道不需要改**：双对抗 Agent 已核实 hook 通道完全不解析 transcript，thinking 不会从那条路径进来。如果后续真的把 hook 改成解析 transcript（未来需求），那时再考虑加 thinking 翻译

## 验证

- `pnpm typecheck` 通过（main + web 两份 tsconfig）
- 用户手动重启 dev（`pnpm dev`），新建一个会话发 `hello`，应该看到：
  - 第一条：`thinking` 弱化气泡（dashed 边框 + 斜体淡灰），内容是模型的推理 prelude
  - 第二条：`Claude` 实线气泡，内容是 final answer
- 旧 DB 里历史 message 不会回追改写（迁移会很贵）：已有的 thinking 内容仍然存在 `kind='message'` 行，只对新会话生效。可接受（最多看着旧会话双 bubble 怪异，不影响功能）

## 追加：codex 也走 thinking + 气泡头部按 agentId 显示对方名

### 起因

CHANGELOG_43 主体只覆盖了 Claude 通道，但用户切到 codex 会话后立即暴露两个遗漏：

1. **Codex（GPT-5）reasoning 没走新通道**：`codex-cli/translate.ts:105` 原本 `emit('message', { text, role:'assistant', reasoning: true })`，UI 完全不读 `reasoning` 字段（rg 全 src 只在 translate.ts 自己写入和注释），全部当 final answer 渲染。GPT-5 reasoning 与 Claude extended thinking 是同一产品语义，应共用 `ThinkingBubble`
2. **MessageBubble 头部 hardcoded 'Claude'**（[ActivityFeed.tsx:281](src/renderer/components/ActivityFeed.tsx#L281)）：codex 会话里对方名仍显示 "Claude"，与 SessionDetail 的 placeholder「给 Codex 发消息」（[SessionDetail.tsx:339](src/renderer/components/SessionDetail.tsx#L339)）不一致

### 改动

#### `src/main/adapters/codex-cli/translate.ts`

- L105 `case 'reasoning':` 从 `emit('message', { text, role:'assistant', reasoning: true })` 改为 `emit('thinking', { text })`，与 Claude 路径统一
- 文件顶部事件映射注释 L15 同步更新：`item.completed{reasoning} → thinking`
- `reasoning: true` 字段没别处依赖，删除安全

#### `src/renderer/components/ActivityFeed.tsx`

- 顶部新增 `getAgentShortName(agentId): string` helper：`'codex-cli' → 'Codex'`、`'aider' → 'Aider'`、`'generic-pty' → 'Shell'`，default `'Claude'`。注释说明：`adapter.displayName`（'Claude Code' / 'Codex CLI'）是长名给 NewSessionDialog 选 adapter 用，气泡头部需要更短的人称
- `MessageBubble` 加 `agentId` props，第 281 行 `{isUser ? '你' : 'Claude'}` → `{isUser ? '你' : otherName}`（`otherName = getAgentShortName(agentId)`）
- `ThinkingBubble` 加 `agentId` props，头部由单独 `'thinking'` 标签改为「{otherName} · thinking · {ts}」三段式（与 MessageBubble 头部「{otherName} · {ts}」结构对齐，多一段 thinking 状语让用户知道这是推理而非 final answer）
- `MessageRow` 调用 `<MessageBubble />` / `<ThinkingBubble />` 时把已有的 `agentId` 透下去

### 不动的地方

- **`SessionDetail.tsx:339` 的 inline ternary 不重构**：只此一处用，重构成调 helper 收益小；未来如果第 4 处需要再统一抽
- **`adapter.displayName` 保留长名**：'Claude Code' / 'Codex CLI' 在 NewSessionDialog 列表里需要让用户分辨「Claude Code (CLI 工具)」vs「Codex (GPT-5)」，与气泡头部的人称短名是两套语境，各自为政更清晰

### 验证补充

- 新建 codex 会话发任意消息，应看到：
  - reasoning 段：`Codex · thinking · {ts}` 弱化 dashed 气泡
  - final answer：`Codex` 实线气泡
- 同时新建 claude 会话验证未受影响：`Claude · thinking · {ts}` / `Claude` 两种气泡都正常

## 再追加：修 pin 模式文字残影补 one-shot 强刷

### 起因

CHANGELOG_35 通过 pin 态 `display:none ::before` 治掉 `mix-blend-mode + isolation + backdrop-filter` 三件套缓存的 group surface 后，仍有用户反馈：进入 pin 模式那一瞬间的旧帧（含全量文字）会"印"在玻璃上，必须人工拖一下窗口大小才消失。

双对抗 Agent（Claude Explore + Codex CLI xhigh）独立读 `window.ts / globals.css / App.tsx / FloatingFrame.tsx` 共识根因（按概率）：

1. **进入 pin 时没有 one-shot 强刷**（最高）：[window.ts:135-138](src/main/window.ts#L135) `setAlwaysOnTop(true)` → `stopInvalidateLoop()` → `startInvalidateLoop()` 只等 100ms 定时器自然刷新。期间旧帧的 Chromium compositor cache / NSWindow native surface 没被冲掉，单靠 `webContents.invalidate()` 也不一定刷得掉这层缓存。完美解释「拖动窗口大小（=resize 触发完整 ViewSizeChanged → relayout/repaint，等价于 native surface tree rebuild）后残影消失」
2. **`setVibrancy(null)` 与 loop 启动同 tick**（次）：[window.ts:114](src/main/window.ts#L114) vibrancy 系统级切换是异步的，定时器立刻在跑，前几帧叠加未完成的 vibrancy 切换

排除：「setBackgroundThrottling 被重新打开节流」❌（双 Agent 核实无路径再开）；FloatingFrame 子组件 transform/opacity ⚠️ 无证据；定时器误启动/误停 ⚠️ 无实锤。

### 改动

#### `src/main/window.ts`

- `setAlwaysOnTop(value)` 进入 pin 分支（`value && darwin`）从只 `startInvalidateLoop()` 改为先 `kickRepaintAfterPin()` 再 `startInvalidateLoop()`
- 新增 `private kickRepaintAfterPin()`：模拟一次 resize 触发完整 layout/repaint
  - 同步 `setContentSize(width, height + 1)` → 让 Chromium 走 ViewSizeChanged 路径
  - `setImmediate(() => setContentSize(width, height))` 下一个 macro task 调回原值
  - 跨 macro task 防 Chromium 同帧 size 去重合并；1px 高度变化在 setImmediate 一个 runloop 内完成，肉眼难察
  - 双重 isDestroyed 守卫（同 startInvalidateLoop 风格）

### 不动的地方

- **解 pin 不 kickRepaint**：`setAlwaysOnTop(false)` 走 `vibrancy: 'under-window'` 重启用，macOS 系统层会做完整重新合成，不需要额外强刷。仅在用户报问题的「进入 pin」一侧加修复，避免过度
- **`webContents.invalidate()` 不再额外调一次**：双 Agent 共识 invalidate 只触发 NSWindow 与桌面合成，刷不掉 Chromium 内部 compositor cache，加这一发对当前症状无帮助；100ms loop 维持下层桌面感知率（CHANGELOG_35）的语义不变
- **不发 IPC 让 renderer 强制 reflow**：双 Agent 没在 FloatingFrame 子组件里看到 pin 专属的 transform/opacity/filter 切换，问题在窗口 native surface 层而非 renderer 合成层，纯主进程一招解决最小侵入
- **不调 `setBounds(b)` 同尺寸**：Chromium 对 setBounds 同尺寸去重，必须 ±1px 才真触发 ViewSizeChanged
- **不用 `hide()/show()`**：会有可见闪烁，比 ±1px 更难看

### 验证

- `pnpm typecheck` 通过
- 用户重启 dev（改 main，需重启），按 Cmd+Alt+P 切到 pin 模式（或点 header 📌 按钮），观察：
  - 切到 pin 那一瞬间不再看到上一帧的文字"印"在玻璃上
  - 不需要拖动窗口大小就能干净显示
  - 1px 高度的瞬时抖动应肉眼难察（在 setImmediate 一个 runloop 内 ≈ <16ms）
- 反向验证：从 pin 切回非 pin（vibrancy 回 'under-window'）行为不变

## 再再追加：修打包后 codex agent 启动报 `spawn ENOTDIR`

### 起因

`pnpm dev` 下应用内 codex agent 工作正常；`pnpm dist` 打包成 .app 后，新建 codex 会话立即报 `⚠ Codex 启动失败：spawn ENOTDIR`。错误文案出自 [sdk-bridge.ts:330](src/main/adapters/codex-cli/sdk-bridge.ts#L330) 的 `earlyErrCb` 路径——SDK 透传子进程 spawn 错误。

### 双对抗 Agent 共识根因

Claude Explore + Codex CLI（xhigh）独立读 `node_modules/@openai/codex-sdk/dist/index.js` + 解析 `app.asar` 头部 + ls `app.asar.unpacked`，4 个 yes/no 问题答案完全一致：

1. **SDK 二进制定位链**：[index.js:421-433](node_modules/@openai/codex-sdk/dist/index.js#L421-L433) `moduleRequire.resolve('@openai/codex/package.json')` → `createRequire(...).resolve('@openai/codex-darwin-arm64/package.json')` → `path.join(dir, 'vendor', triple, 'codex', binName)` 拼出绝对路径，最终 [index.js:238](node_modules/@openai/codex-sdk/dist/index.js#L238) `spawn(this.executablePath, ...)`
2. **打包后物理分布**：`app.asar` 列表里同时有 `@openai/codex` 和 `@openai/codex-darwin-arm64`（含 vendor/codex 二进制）；但 `app.asar.unpacked/node_modules/@openai/` 只有 `codex-darwin-arm64`（electron-builder 智能 unpack 含原生二进制的目录），`@openai/codex` 这个 launcher 包没被 unpack
3. **spawn 不走 asar shim**：`child_process.spawn` 直接系统 fork/exec，传一个含 `app.asar/` 段的二进制路径给 spawn，OS 因为 `app.asar` 是普通文件而非目录，报 ENOTDIR
4. **当前 package.json 无 `asarUnpack` 配置**：electron-builder 默认行为没把 launcher + 平台子包都 unpack 出来

→ 链路成因：SDK 起点 `@openai/codex/package.json` 只能在 asar 内拿到（unpacked 没复制），返回字符串 `.../app.asar/node_modules/@openai/codex/package.json`；createRequire 沿这个 path 解析子包也只能拿到 asar 内字符串；最终 `binaryPath` 落在 `.../app.asar/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`，spawn 给系统 → ENOTDIR。dev 模式没 asar 所以没事。

### 改动（双管齐下）

#### `package.json`

新增 `build.asarUnpack`，把 `@openai/codex` launcher + 4 个平台子包（darwin/linux/win32 × arm64/x64）都纳入 unpacked。仅添加，不动其他打包字段。

```json
"asarUnpack": [
  "node_modules/@openai/codex/**/*",
  "node_modules/@openai/codex-darwin-*/**/*",
  "node_modules/@openai/codex-linux-*/**/*",
  "node_modules/@openai/codex-win32-*/**/*"
]
```

这一步保证 `app.asar.unpacked/node_modules/@openai/codex*` 物理文件齐全。

#### `src/main/adapters/codex-cli/sdk-bridge.ts`

新增 `resolveBundledCodexBinary()` helper + 改写 `ensureCodex` 优先级。**为什么不能只靠 asarUnpack 让 Electron 的 require 自动重写到 unpacked？** 不可靠：SDK 用的是 `createRequire(asar内path).resolve(子包)` 链，Electron asar shim 对子包 resolve 的路径重写行为没有强保证；最稳的是主进程自己拼 unpacked 物理路径传给 SDK 的 `codexPathOverride` 短路 SDK 内部 resolve。

- 顶部新增 `PLATFORM_BINARY_MAP`：`{ pkgDir, triple, binName }` 6 行映射，照搬 SDK `dist/index.js:144-150` 的 `PLATFORM_PACKAGE_BY_TARGET` + `findCodexPath` 平台分支，覆盖 darwin/linux/win32 × arm64/x64 共 6 种，windows 二进制名 `codex.exe`，其余 `codex`
- `resolveBundledCodexBinary()`：`app.isPackaged` 为 false → 返回 null（dev 模式让 SDK 自己 resolve，本来就好的）；packaged 时按 `process.platform-process.arch` 查表拼 `process.resourcesPath/app.asar.unpacked/node_modules/@openai/${pkgDir}/vendor/${triple}/codex/${binName}`，`existsSync` 校验后返回；表 miss 或文件不存在都返回 null 退回 SDK 默认（让用户至少看到 SDK 自己的错误而不是 silent fail）
- `ensureCodex`：优先级 `用户填的 codexCliPath > resolveBundledCodexBinary() > SDK 默认`。CHANGELOG_41 设计的「设置面板可覆盖外部 codex」语义保留——用户主动填的最高优

### 不动的地方

- **不改 SDK 自己**：动 node_modules/@openai/codex-sdk 是脏改、`pnpm install` 必丢，靠 `codexPathOverride` 这个 SDK 公开的覆盖入口最干净
- **不删 asar 里的 codex 副本**：electron-builder 的 asar+unpack 策略是双份保留（asar 列表里有 entry + unpacked 里有物理文件），改这个会破坏 Electron asar 的内部约定
- **不为 dev 模式做特殊路径**：`app.isPackaged === false` 直接 return null，让 SDK 走原本工作的链路，避免 dev/prod 双套逻辑漂移
- **PLATFORM_BINARY_MAP 不抽公共模块**：6 行 const，目前只此一处用；未来若 aider/其他 adapter 也需要类似机制再抽

### 验证

- `pnpm typecheck` 通过（main + web 两份 tsconfig）
- 用户按 README 「打包与本地安装」全流程跑（`pkill 旧进程 → rm -rf release && pnpm dist → 重装到 /Applications → ad-hoc codesign → xattr 清 quarantine`），打开新 .app 新建 codex 会话发 `hello`，应正常拿到 GPT-5 回应（不再 spawn ENOTDIR）
- 反向：dev 模式（`pnpm dev`）codex 会话不应受影响（resolveBundledCodexBinary 在 `!app.isPackaged` 直接 return null）
- 设置面板填 codexCliPath 走自装 codex 这条路径不应受影响（优先级最高，bundled 路径不会盖掉用户配置）


