---
plan_id: "handoff-render-and-image-batch-20260521"
created_at: "2026-05-21T11:50:00+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-render-and-image-batch-20260521"
status: "completed"
base_commit: "619dca703eaa56e39497bdac80e5daa5253b53bb"
base_branch: "main"
final_commit: "955fbe7b9b95455bfc0ef7b192e7e6c1d135c6b9"
completed_at: "2026-05-24"
---
# Plan: hand off 实时渲染 / cold-start prompt 特殊渲染 / create session 图片不显示 / 图片放大

> **R1 → R2 → R3 deep-review 后修订**（reviewer-claude + reviewer-codex 多轮异构对抗 + lead 现场实测）：
> - **Phase 1 P0/P1 删除**（reviewer 双方实证 + lead 现场实测确认 backend 完整、P0 修法是 cosmetic 不修任何 bug；如真有 race 是 IPC 跨 channel ordering 短暂闪烁，最终一致，修法成本远大于价值）
> - **Phase 2 plumbing 补完整 10 步链路**（含 `buildCreateSessionOptions` builder + **adapter facade wrapper**（claude-code/index.ts + codex-cli/index.ts）+ codex-cli `ThreadLoop.startNewThreadAndAwaitId` 函数签名 + 真正 first-user-message emit **3 处**：claude finalize × 1 + codex thread-loop fallback :91-99 + thread-loop success :166-173 + sdk-bridge resume :506-516 — **绝不**塞 `thread-loop.ts:103-110` error emit + **绝不**塞 `sdk-bridge/index.ts:728-735` sendMessage）
> - **Phase 3 加 codex-cli 对偶状态声明** + 修正 line reference (`441-487` → `503-510` + claude finalize 调用 `:419-428` → `:443-453`)
> - **Phase 4 改用 `useImageBlob(() => window.api.loadUploadedImage(path), path, sharedImageBlobCache)` + 项目自实现 `fixed inset-0 z-50` overlay**（删 shadcn-ui Dialog + `agent-deck-image://` 协议，两者都不存在）+ **shared cache 抽 `src/renderer/lib/image-blob-cache.ts`** 仅 thumb + lightbox 共享，**ImageBlobLoader 独立 cache 不合并**
> - §下一会话第一步 补可执行 EnterWorktree 具体形式 + claude 端 vs codex 端**互斥二选一**
> - §已知踩坑 9 条覆盖（含 codex-config protocol layer 无需同步 / IPC race 不修留观察 / shared cache 隔离边界 / Esc keydown 项目首引入等）

## 总目标

修 3 个 UX 缺陷（hand off cold-start prompt 在会话详情平铺成一大坨 + create session 附带的图片不显示 + 图片不可放大），让 hand off / image 流程的视觉表达回到设计预期。原 Phase 1（hand off adopt 实时渲染）经 R1 deep-review 双对抗 + lead 现场实测排查确认 backend 完整，无真 bug，已从本 plan 删除。

## 不变量

1. **events.payload 是 free-form JSON（payload_json 列）**：optional 字段加减无需 schema migration，老 events 行 `payload.handOff === undefined` 自然兼容。
2. **finalizeSessionStart 是 spawn 主路径专用**（session-finalize.ts:30-34 jsdoc 明确）：jsonl-missing fallback 路径不调本 helper（fresh fallback 复用 applicationSid 行 + 走 sessionManager.updateCliSessionId 黑名单链，不需 emit session-start 撞唯一索引）。本 plan 改动只覆盖 spawn 主路径，不动 fallback。
3. **wire prefix 与 hand-off marker 是正交关系**：wire prefix 只在 send_message 路径出现（cross-session teammate message 入 events 时由 adapter.receiveTeammateMessage 拼前缀）；hand-off marker 在 spawn handler 拼 lead context block 时插入 + hand-off-session handler adopt 路径拼 adoptedBlock 时插入。两条路径独立，可单独命中（adopt 路径有 marker 无 wire prefix）。
4. **`UploadedImageThumb` 是纯展示组件**，**当前生产调用方只有 `message-row.tsx`**（grep 实证：renderer 内仅 1 处 import；NewSessionDialog 与 ComposerSdk 用各自 inline `<img>` 渲染 pending attachment thumbnail，不复用本组件）。Phase 4 新增 onClick prop **保持 optional**（向后兼容未来其他 callsite 复用本组件不需放大的场景；当前无 onClick 的现有 callsite 也不受影响）。如想统一三处缩略图组件，另开 refactor plan，不混入本 plan。
5. **HandOffMetadata plumbing 必须 cross-adapter 对偶**：claude-code 与 codex-cli 两套 adapter 在 hand-off cold-start prompt emit 路径上必须同时携带 handOff metadata。**真实 first-user-message emit 位置**（grep `role: 'user'` 实测排除 sendMessage 后续路径）：
   - claude-code: `session-finalize.ts:147-154` finalizeSessionStart × 1 emit
   - codex-cli: `thread-loop.ts:91-99` (fallback) + `thread-loop.ts:166-173` (success) + `sdk-bridge/index.ts:506-516` (resume) **共 3 处**
   - **`thread-loop.ts:103-110` 是 error message emit（payload `{text:errorText, error:true}` 无 `role:'user'`），不是 user prompt** — Phase 2 plumbing 绝对不能 spread handOff 到此处（污染 error payload 语义、未来扫 events 误把 error 计入 hand-off baton 链）
   - `sdk-bridge/index.ts:728-735` 是 sendMessage 后续 user message（不是 createSession first），不接 createSession handOff opts
   - 漏一个 adapter 都让 hand_off_session 跨 adapter 行为不一致；多塞一处（103-110）就 metadata 污染
6. **lead 视角 cold-start prompt 不被 HandOffMetadata 污染**：metadata 只走 events.payload 字段（UI 可见 SDK 不可见），**严禁**注入到 SDK first message 文本（receiver Claude 看了会误解）。adoptedBlock + cold-start prompt 文本本身保留现状（buildAdoptedTeamsContextBlock 输出 + resolved.coldStartPrompt），UI 渲染额外读 payload.handOff 决定 badge / 折叠样式。

## 设计决策（不再争论）

### Phase 1 — hand off adopt 实时渲染（**R1 deep-review 后整片删除**）

**R1 deep-review 双对抗结论 + lead 现场实测（grep / Read manager.ts:482-485 + index.ts:289 桥点 + hand-off-session.ts:739-758 + teamChangedSender + enrichRecordWithTeams + session-finalize.ts:9 jsdoc）**：

- ✅ 已实证：`emit session-start` 是**同步**派发到 `sessionManager.ingest → sessionRepo.upsert`（session-finalize.ts:9 jsdoc 明文）；spawn handler 返回 newSpawnedSid 时 sessions row 必已存在
- ✅ 已实证：`hand-off-session.ts:739-758 processSwappedTeam` emit 4 个事件链路完整：
  - `eventBus.emit('agent-deck-team-member-changed', ...)` × 2 (left + joined) → `teamChangedSender` 16ms debounce → IPC `AgentDeckTeamChanged` → renderer TeamHub/TeamDetail `onAgentDeckTeamChanged` listener fetch refetch
  - `sessionManager.notifyTeamMembershipChanged(...)` × 2 (caller + newSid) → `sessionRepo.get` → `eventBus.emit('session-upserted', ...)` → `index.ts:289` bridge `sessionManager.enrichWithTeams(s)` → IPC `SessionUpserted` → renderer `onSessionUpserted` → store `upsertSession(record)` → React re-render SessionCard
- ✅ 已实证：`enrichRecordWithTeams` 返回 `{...rec, teams}` 总是新对象引用（React 浅比较不会被绊倒）
- ✅ 已实证（reviewer-claude MED-1）：`manager.ts:482-485` `notifyTeamMembershipChanged` 内若加 enrich call，由于 `index.ts:289` bridge listener 也无差别 enrich → enrich 跑两次（idempotent 无害但**不修任何运行时 bug**）

**结论**：Phase 1 backend 实际完整，**没有可修的 P0 真 bug**。原 plan 假设的 root cause（`sessionRepo.get` 返不含 enriched teams[]）被 reviewer 双方实证 + lead 现场实测三重否定。

**潜在残留风险（不修，仅记录）**：跨 IPC channel ordering race — `SessionUpserted` 与 `AgentDeckTeamChanged` 是两条独立 IPC channel，前者 emit 即发，后者经 16ms debounce。可能 `AgentDeckTeamChanged` 先到 → TeamHub fetch 拿到 team.members 含 newSpawnedSid → 但此时 `SessionUpserted` 还没到 renderer → sessions Map 内还没 newSpawnedSid 的 enrich 后 teams[] → 短暂闪烁（member 数与显示 session 数对不上几十 ms）。最终一致，**修法成本远大于价值**。如用户后续反馈具体可复现的渲染异常，再独立挖。

**Phase 1 决议：整片删除，不进任何代码改动 phase**。如未来确实定位到具体可复现的 UX bug，独立开 plan。

### Phase 2 — hand off cold-start prompt 特殊渲染

**Root cause（已验证）**：
- `message-row.tsx:71-73` `parseHandOffContext` 解析只在 `wirePrefix` 命中时触发（`wirePrefix ? parseHandOffContext(wireBody) : { handOff: null, main: wireBody }`）
- adopt 路径 cold-start prompt 是 SDK first message（finalizeSessionStart emit），**无 wire prefix** → parseHandOffContext 不触发 → 整个 adoptedBlock + cold-start prompt 平铺一大坨
- 现有 `parseHandOffContext` 也只识别 spawn 的 marker `## Hand-off context (auto-injected by Agent Deck MCP)`，不识别 adopt 的 marker `## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)`

**修法（按 RFC Q2/Q3 选完整元数据 + Badge + 折叠 adoptedBlock，R1 deep-review 后补完整 plumbing 链路）**：

#### Step 2.1 — schema layer：events.payload 加 handOff metadata

`shared/types.ts` 加新类型：
```typescript
export interface HandOffMetadata {
  mode: 'plan' | 'generic';
  planId: string | null;
  phaseLabel: string | null;
  fromCallerSid: string;
  hasAdoptedBlock: boolean;
}
```

`AgentEvent.payload`（message kind）允许携带 optional `handOff?: HandOffMetadata` 字段（payload 本来就是 free-form Record，加 optional 字段无 schema migration）。

#### Step 2.2 — plumbing：handOff metadata 全链路 cross-adapter 透传

**R1 reviewer-codex MED-1 发现原 plan 漏 `buildCreateSessionOptions` builder + 漏 codex-cli adapter。完整链路如下**（grep 实证：`spawn.ts:254-286` spawn 必经 buildCreateSessionOptions → narrow → adapter）：

1. **schema 共享**：`shared/types.ts` 加 `HandOffMetadata` 类型（上 Step 2.1）
2. **adapter options 类型**：`src/main/adapters/types.ts:276-300` `CreateSessionOptionsRaw` + `ClaudeCreateOpts` + `CodexCreateOpts` 都加 `handOff?: HandOffMetadata`
3. **adapter options builder**：`src/main/adapters/options-builder.ts`
   - `:93-103` `narrowToClaudeOpts`（claude 子分支）— 加 handOff 透传
   - `:124-172` `narrowToCodexOpts`（codex 子分支，内含 `:139-169` reviewer-* default spread 关键节点，**不要碰** — 改 handOff 透传时只动 narrow function 出口对象的 handOff 字段）— 加 handOff 透传
4. **MCP schema**：`src/main/agent-deck-mcp/tools/schemas.ts` `SpawnSessionArgs` 加 `hand_off?: HandOffMetadata`（snake_case 跟 schema 对齐）+ description 写明 `"hand_off_session internal plumbing; direct callers leave unset"`（防止外部 spawn_session 调用者误用）
5. **spawn handler**：`src/main/agent-deck-mcp/tools/handlers/spawn.ts:254-286` 接收 args.hand_off → 透传给 `buildCreateSessionOptions(args.adapter, { ..., handOff: args.hand_off })`
6. **hand-off-session handler**：`src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts` 装配 handOff metadata（mode 来自 resolved.mode / planId / phaseLabel / fromCallerSid = ctx.callerSessionId / hasAdoptedBlock = `args.adopt_teammates === true && adoptedSnapshot !== null`）后传给 `spawnArgs.hand_off`
7. **adapter facade wrapper**（R3 reviewer-codex MED 新增）：两个 adapter facade `createSession` 方法都是显式字段白名单 spread，必须显式加 `handOff: opts.handOff` 否则被丢：
   - `src/main/adapters/claude-code/index.ts:72-87` `createSession` facade `this.bridge.createSession({...})` spread 加 `handOff: opts.handOff`
   - `src/main/adapters/codex-cli/index.ts:81-97` `createSession` facade `this.bridge.createSession({...})` spread 加 `handOff: opts.handOff`
8. **claude-code adapter sdk-bridge**：
   - `src/main/adapters/claude-code/sdk-bridge/index.ts:~443-454` createSession 调 `finalizeSessionStart({...opts, handOff: opts.handOff})` 透传（实施前 grep `finalizeSessionStart` 重定位最新行号；R2 INFO-1 修正原 plan `:419-428`）
   - `src/main/adapters/claude-code/sdk-bridge/session-finalize.ts` `FinalizeSessionStartArgs` 加 `handOff?: HandOffMetadata` + emit 'message' 时 spread：
     ```typescript
     payload: {
       text: prompt,
       role: 'user',
       ...(handOff ? { handOff } : {}),
       ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),  // Phase 3 修法叠加
     }
     ```
9. **codex-cli adapter sdk-bridge + thread-loop 函数签名**（R3 reviewer-codex MED 新增 — codex bridge 调 `startNewThreadAndAwaitId` 时必须传 handOff，否则 thread-loop 内无数据源 emit metadata）：
   - `src/main/adapters/codex-cli/sdk-bridge/index.ts:666-672` `await this.threadLoop.startNewThreadAndAwaitId(internal, tempKey, cwd, opts.prompt, opts.attachments)` 加 `opts.handOff` 入参
   - `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:51-57` `startNewThreadAndAwaitId` 函数签名加 `handOff?: HandOffMetadata` 入参（type-only 修改 + 同步内部 emit 调用拿到 handOff）
   - `src/main/adapters/codex-cli/sdk-bridge/index.ts:506-516` (resume first-user-message) — payload spread `...(handOff ? { handOff } : {})`（resume 路径不走 ThreadLoop.startNewThreadAndAwaitId，直接在 bridge 内 emit 自己 spread）
10. **codex-cli adapter thread-loop emit 出口**（R2 修正 + R3 confirm：**只 2 处** first-user-message emit，**不塞** `thread-loop.ts:103-110` error emit `{text:errorText, error:true}` 无 `role:'user'`）：
    - `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:91-99` (fallback first-user-message) — payload spread `...(handOff ? { handOff } : {})`
    - `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:166-173` (success first-user-message) — 同上 spread
    - **注**：实施前 grep `role: 'user'` 重定位精确行号（R3 reviewer-claude INFO-1 实测 `:166-173` → `:170-177` 略偏 / `:506-516` → `:510-516` 略偏；R3 reviewer-codex INFO 同款发现）
    - **不塞** `sdk-bridge/index.ts:728-735` sendMessage（是后续 user message 不是 createSession first，不接 createSession handOff opts）

#### Step 2.3 — UI layer：renderer 端识别 handOff + 解析两种 marker + Badge 渲染

`src/renderer/components/activity-feed/rows/message-row.tsx` 改动：
- `parseHandOffContext` 加 adopt 路径 marker（识别两种 header；保持 `\n---\n\n` 同款分隔符）：
  ```typescript
  const HAND_OFF_HEADERS = [
    '## Hand-off context (auto-injected by Agent Deck MCP)',           // spawn 路径
    "## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)",  // adopt 路径
  ];
  function parseHandOffContext(body: string): { handOff: string | null; main: string; kind: 'spawn' | 'adopt' | null } { ... }
  ```
- `MessageBubble` 渲染时**解除 `wirePrefix` 触发条件**：对所有 user message 都 try parse handOff marker（adopt 路径无 wire prefix 也命中）
- user bubble 顶部加 **Hand-off badge**（参考现有 wirePrefix chip 同款样式：cyan-500/15 背景 + 圆角 + 小字号）。badge 文案：
  - `payload.handOff` 有值 → 走 metadata 优先：`Hand-off · {mode}` + tooltip 显示 planId / phaseLabel / fromCallerSid
  - `payload.handOff` 无值 + marker 命中（向后兼容 old events 行 / 不走本 plan plumbing 的 spawn 路径）→ fallback `Hand-off · {kind === 'adopt' ? 'adopt' : 'spawn'}`
- adoptedBlock 区块仍走 `<details>` disclosure（与现有 spawn 路径同款），summary 文案区分：
  - adopt kind → "Adopted teams context（adopt 路径注入，点开查看新 lead 接管的 team / teammate）"
  - spawn kind → 保留现有 "Hand-off context（lead 注入，点开查看 lead session_id / team_id / send_message 用法）"
- **顺手更新 `message-row.tsx:22-24` 现有 jsdoc**（R3 reviewer-claude LOW-2 修法）：删除「wirePrefix 命中前置」描述（解除 wirePrefix 触发条件后该描述过时），改为「marker 字面量精确匹配（2 种 HAND_OFF_HEADERS 之一）+ `\n---\n\n` 分隔符是唯一识别条件；任一不匹配 → 视为普通 message body 不抽 hand-off。注：理论上普通用户手贴这两个 marker 字面量 + 分隔符仍可能误识别，但概率极低（37 字符精确 marker + 后续分隔符 + adopt block 的 multi-line context 段不会被简短用户输入命中）」

#### Step 2.4 — 测试覆盖

- `src/main/agent-deck-mcp/__tests__/hand-off-session.adopt-teammates.test.ts`：加 handOff metadata 透传 assertion（spawn 收到的 `args.hand_off` 字段值正确）
- `src/main/agent-deck-mcp/__tests__/tools.test.ts`：加 hand_off 字段透传到 adapter createSession `opts.handOff` 的 assertion（覆盖 claude-code + codex-cli 两条 adapter 路径）
- **adapter facade → bridge spy 测试**（R3 reviewer-codex MED 新增）：mock adapter facade `createSession` 验 `this.bridge.createSession` 入参含 `handOff`，避免 mock adapter 只测到 facade 入参（覆盖 `src/main/adapters/claude-code/index.ts:77-87` + `src/main/adapters/codex-cli/index.ts:83-97` 两条 facade wrapper 路径）
- codex-cli adapter `src/main/adapters/codex-cli/sdk-bridge/__tests__/`（如有）：加 handOff metadata 出现在 emit user message payload 的 assertion。**断言精度**：handOff 只出现在 **2 处 thread-loop emit (`:91-99` fallback + `:166-173` success) + 1 处 sdk-bridge resume emit (`:506-516`)** 共 3 处 first-user-message payload — **不**断言 error payload (`:103-110`) 含 handOff，**不**断言 sendMessage payload (`:728-735`) 含 handOff
- renderer 端 UI 行为不写 unit test（项目无 React component test 习惯），由 Step 1.5 R3 deep-review 多轮人工 review 把关

### Phase 3 — create session 图片不显示

**Root cause（已验证）**：`src/main/adapters/claude-code/sdk-bridge/session-finalize.ts:147-154` `finalizeSessionStart()` emit 首条 user message 时只 emit `{ text, role: 'user' }` 漏传 attachments。sendMessage 路径 (`src/main/adapters/claude-code/sdk-bridge/index.ts:503-510`，R1 INFO-1 修正：原 plan 引用 `441-487` 是 finalize 调用 + recoverer 区段非 sendMessage attachments spread 位) 正确处理 attachments。createSession 路径漏处理。

**codex-cli adapter 对偶状态**（R1 reviewer-claude MED-2 新增声明 + R2 codex MED-1 校准 emit 清单 + R3 confirm）：
- codex-cli first-user-message emit **3 处**（**不是 4 处**；`thread-loop.ts:103-110` 是 error message emit `payload:{text:errorText, error:true}` 不是 user prompt — R2 reviewer 双方独立实证 + R3 grep confirm）：`src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:91-99` (fallback) + `:166-173` (success) + `src/main/adapters/codex-cli/sdk-bridge/index.ts:506-516` (resume)
- codex-cli sendMessage（后续 user message）：`src/main/adapters/codex-cli/sdk-bridge/index.ts:728-735`
- **全已正确 spread `...(attachments && attachments.length > 0 ? { attachments: opts.attachments } : {})`**，**不在本 plan 修法范围**
- 差异源：codex finalize 抽法 (`persistSessionFields`) 与 claude (`finalizeSessionStart`) 非对称 — 详两份 session-finalize.ts jsdoc

**修法**（仅 claude-code adapter 单点修）：

1. `FinalizeSessionStartArgs` 加 `attachments?: readonly UploadedAttachmentRef[]` 字段（与 sendMessage 接口对齐）
2. emit 'message' event 时 spread attachments：
   ```typescript
   payload: {
     text: prompt,
     role: 'user',
     ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
     ...(handOff ? { handOff } : {}),  // Phase 2 修法叠加
   }
   ```
3. `src/main/adapters/claude-code/sdk-bridge/index.ts:~443-453` createSession 调 finalizeSessionStart 时透传 `attachments: opts.attachments`（与 extraAllowWrite 同款模式 — R3 reviewer-codex INFO 修正原 plan `:419-428` → `~:443-453`；实施前 grep `finalizeSessionStart` 重定位最新行号）

**验证手段**：mini-runner 跑 `createAdapterSession({attachments})` → 在主进程读 events 表 `payload_json` 含 attachments 字段 + UI 看会话详情第一条 user bubble 下方显示缩略图

### Phase 4 — 图片放大查看

**R1 reviewer-codex MED-2 发现原 plan 用了不存在的 `agent-deck-image://` 协议 + 项目无 `@radix-ui/react-dialog` / shadcn-ui Dialog 依赖。修法改为复用现有 image loading 链 + 项目自实现 overlay 风格**。
**R2 reviewer-codex MED-2 + reviewer-claude MED-2 进一步发现原 plan overlay 模式（`absolute inset-0`）与挂载位置（MessageBubble 内嵌套于 scroll container）不匹配，且 `useImageBlob` cache 共享路径未指明 → R2 修订**：

**修法（按 RFC Q4 选单图打开，R2 重新设计 overlay + cache 共享）**：

1. **抽 shared cache module**（R2 reviewer-claude MED-2 修法 ② + R3 reviewer-claude LOW-1 加隔离边界）：新建 `src/renderer/lib/image-blob-cache.ts`，从 `UploadedImageThumb.tsx:14` 把 module-local `cache` 抽到此 shared module 一次性创建后 export `sharedImageBlobCache`；UploadedImageThumb.tsx + ImageLightbox.tsx 都 import 自此 module 共享 cache instance。
   - **shared 范围严格限定**（R3 reviewer-claude LOW-1 修法）：**仅 thumb + lightbox 两组件**共享 sharedImageBlobCache（两者都用 `path` 作 cache key 同款 IPC `window.api.loadUploadedImage(path)`）。**`src/renderer/components/diff/renderers/ImageBlobLoader.tsx:10-13` 现有独立 `cache` 不动**（用 `<sessionId>|<JSON.stringify(ImageSource)>` 格式 cache key 与 thumb 的 `path` 格式不兼容，合并会 **key collision**；详 ImageBlobLoader.tsx:10-13 jsdoc「与 UploadedImageThumb 不共享」明文 invariant）
   - 实施后 `grep -n "createImageBlobCache" src/renderer/` 应只 2 处：① `useImageBlob.ts:32` (export 函数本身) + ② `src/renderer/lib/image-blob-cache.ts` (新建 shared module，1 处调用 + export `sharedImageBlobCache`)；`ImageBlobLoader.tsx:13` 仍保持 `const cache = createImageBlobCache()` 不动
2. 新建 `src/renderer/components/ImageLightbox.tsx`：**`fixed inset-0 z-50` overlay 风格**（**不是** `absolute inset-0` — R2 codex MED-2 实证 NewSessionDialog 模式仅在 App root-level sibling 才成立；lightbox 挂在 MessageBubble 内嵌套于 SessionDetail 的 `overflow-y-auto` scroll container 必须用 `fixed` 跳出滚动容器 + `z-50` 高于 NewSessionDialog `z-40` 防被遮盖。R3 codex/claude 实证：项目内 z-50 已有 2 处 `ContentViewerModal.tsx:31` + `AssetEditor.tsx:239`（都用 `absolute inset-0 z-50` 挂在 AssetsLibraryDialog z-40 子级），lightbox 用 `fixed inset-0 z-50` 跳到 root level 不构成现实冲突 — 实际场景 Assets 库与 SessionDetail 互斥 UI 不会同时打开）。props `{ open, onClose, path, alt }`。组件结构：
   - 外层 `<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">` — `fixed` 跳出 scroll container，覆盖整 viewport
   - 点击外层 overlay → `onClose()`
   - **Esc 键处理**（R3 reviewer-claude INFO-3：项目内 `grep addEventListener('keydown'` 命中 0 处，lightbox **首次引入**此模式 — 实施示例代码 inline 防偏差）：
     ```typescript
     useEffect(() => {
       const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
       window.addEventListener('keydown', handler);
       return () => window.removeEventListener('keydown', handler);
     }, [onClose]);
     ```
   - 内层 `<div>`：`max-w-[90vw] max-h-[90vh]` 居中，`onClick={(e) => e.stopPropagation()}` 防点图自身误关闭
   - 内层 `<img>` 用 `useImageBlob(() => window.api.loadUploadedImage(path), path, sharedImageBlobCache)` 加载 dataUrl（与 `UploadedImageThumb` 共享 cache — R2 修法），`object-contain` 自适应
   - **hooks 顺序约束**（R2 codex MED-2 修法）：`useImageBlob` 必须无条件调用（React hook 规则）→ 用 **父组件条件 mount**（`{open && <ImageLightbox ... />}`）— open=false 时整个组件不存在，open=true 才挂载 + 调 hook，规避 "hook 数量变化"问题；**不在组件内 if (!open) return null**（hook 已调，违反规则）
   - 右上角 close 按钮（unicode `✕` 或 `×`，不引入 lucide-react —— 项目 `tool-icons.ts:4-6` 已明确不引入 lucide）
3. `src/renderer/components/UploadedImageThumb.tsx` 加可选 `onClick?: () => void` prop，**默认不可点击**（向后兼容当前唯一 callsite message-row 与未来其他 callsite 不需放大的场景）。仅 `message-row.tsx` 调用时显式传 onClick。给 `<img>` 加 `cursor-pointer` className（仅当 onClick 存在）
4. `src/renderer/components/activity-feed/rows/message-row.tsx` 给每个缩略图加 `onClick={() => setLightboxPath(a.path)}`，bubble 末尾**条件 mount**：`{lightboxPath && <ImageLightbox open={true} onClose={() => setLightboxPath(null)} path={lightboxPath} />}`（state 在 MessageBubble 内单独持有，多 bubble 互不干扰；条件 mount 规避 hook 数量变化）

**显式声明不引入新依赖**：本 Phase 不引入 `@radix-ui/react-dialog` / shadcn-ui Dialog / `react-lightbox` / `lucide-react` 等三方库；全部走项目现有 overlay 风格 + `useImageBlob` hook + shared cache module + 自实现 Esc keydown listener。

## 步骤 checklist

- [x] Step 0 — RFC 完成（已对齐 4 个 phase 设计决策；adoptedBlock marker 已确认）
- [x] Step 0.5 — Spike 不需要（4 phase root cause 都已通过 explore agent + grep 明确，无未知 SDK 行为）
- [x] Step 1 — 写本 plan 文件（done at write time of this file）
- [x] Step 1.5 R1 — invoke `/agent-deck:deep-review` (kind: 'plan') R1 完成；3 HIGH + 2 MED + 2 LOW + 2 INFO 收 finding，本次修订 plan 后进 R2
- [x] Step 1.5 R2 — invoke deep-review R2 完成；1 HIGH + 3 MED + 3 LOW + 1 INFO 收 finding，本次再修订 plan 后进 R3
- [x] Step 1.5 R3 — invoke deep-review R3 完成；1 MED + 2 LOW + 1 INFO 收 finding（reviewer-claude 0 HIGH 0 真 MED 已建议直接进 Step 2；reviewer-codex 1 MED Phase 2 漏 facade wrapper + thread-loop 签名已在本次 R3 修订 plan 中补完）。本次 R3 修订 plan 后**直接进 Step 2 EnterWorktree**，**不再开 R4**
- [ ] Step 2 — **二选一**进 worktree（见 §下一会话第一步详细命令）：
  - **选项 A（claude 端）**：手工 `git worktree add -b <branch> <path> <base_commit>` + `EnterWorktree(path:)` — 两步骤
  - **选项 B（codex 端）**：`mcp__agent-deck__enter_worktree({ plan_id, base_commit })` — 一步走完建 + 进
  - **互斥**：先跑选项 A 手工创建目录后，选项 B 的 `enter_worktree` 会因 worktree path 已存在拒绝创建；反之亦然
- [ ] Step 2.1 — Phase 3 修 `session-finalize.ts` attachments 漏传（claude-code adapter 单点，最 trivial 先做）
- [ ] Step 2.2 — Phase 4 抽 shared cache module + 加 ImageLightbox 组件（`fixed inset-0 z-50` overlay + 父组件条件 mount）+ UploadedImageThumb onClick prop + message-row 条件 mount（无 schema 改，独立 UI 改动）
- [ ] Step 2.3 — Phase 2 加 HandOffMetadata 类型 + plumbing **10 步**（schema → adapter types → options-builder narrow (`:93-103` claude + `:124-172` codex) → MCP schemas (含 description 标 internal plumbing) → spawn handler → hand-off-session handler → **adapter facade wrapper** (claude-code/index.ts:77-87 + codex-cli/index.ts:83-97 显式 spread handOff) → claude-code finalize (~:443-453) → **codex-cli sdk-bridge → ThreadLoop.startNewThreadAndAwaitId 函数签名加 handOff?** (`thread-loop.ts:51-57`) + sdk-bridge resume emit (`index.ts:506-516`) → codex-cli thread-loop **2 处** first-user-message emit (`thread-loop.ts:91-99 fallback` + `:166-173 success`；**不**塞 `:103-110` error + **不**塞 `index.ts:728-735` sendMessage)）+ message-row 解析两种 marker + Badge 渲染 + jsdoc 更新
- [ ] Step 2.4 — 跑 `pnpm typecheck` + `pnpm build`
- [ ] Step 2.5 — 跑测试 `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/hand-off-session.adopt-teammates.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts` + codex-cli adapter handOff metadata 新测试（断言 handOff 只出现在 3 处 first-user-message payload，**不**断言 error payload 含 handOff）
- [ ] Step 2.6 — 实测 3 个 phase 用户场景（dev 启动 → create session 带图 → 看图显示 → 点图放大 → hand off adopt → 看 cold-start prompt Hand-off badge + adoptedBlock 折叠）
- [ ] Step 3 — 写 changelog
- [ ] Step 4 — archive_plan + 合 base_branch + 删 worktree

## 当前进度

Step 0 + Step 0.5（跳过）+ Step 1（首版）+ Step 1.5 R1 + R2 + **R3 收口**完成。Phase 1 经 R1 deep-review + lead 现场实测确认 backend 无真 bug 已删除（只剩 3 phase）。R3 收 1 MED + 2 LOW + 1 INFO 已全数 inline 修订到 plan 文字（MED = Phase 2 plumbing 补 facade wrapper + thread-loop 函数签名；LOW = shared cache 隔离边界 + parseHandOffContext jsdoc 过时；INFO = Phase 3 行号修正）。R3 reviewer-claude 明确「**0 HIGH 0 真 MED 可合并 → 直接进 Step 2，不需 R4**」；R3 reviewer-codex MED 经修订后已收口；**plan 准备就绪进 Step 2 EnterWorktree 实施 Phase 3 → 4 → 2**。

## 下一会话第一步

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/handoff-render-and-image-batch-20260521.md` 全文
2. 若 plan §进度 已通过 R3 review → 直接走 Step 2 EnterWorktree。**互斥二选一**（先跑 A 后跑 B 或反之都会撞 path 已存在 reject）：

   **选项 A — claude 端手工 + builtin EnterWorktree**：
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-handoff-render-and-image-batch-20260521 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-render-and-image-batch-20260521 619dca703eaa56e39497bdac80e5daa5253b53bb
   ```
   ⚠️ **末尾 `619dca703eaa56e39497bdac80e5daa5253b53bb` 是 plan frontmatter `base_commit` 必须显式传**（R2 codex HIGH 修法 — 缺则 git 默认用 HEAD 作 base，主仓 HEAD 可能已 ahead 于 plan base 几个 commit 跑错 base）。

   然后 claude 端进 worktree：
   ```
   EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-render-and-image-batch-20260521")
   ```
   ⚠️ 用 `path:` 不用 `name:`，避开 user CLAUDE.md §Step 2 EnterWorktree CLI v2.1.112 stale base bug。

   **选项 B — codex 端走 MCP 一步建+进**（按 `resources/codex-config/CODEX_AGENTS.md §enter_worktree`）：
   ```
   mcp__agent-deck__enter_worktree({ plan_id: "handoff-render-and-image-batch-20260521", base_commit: "619dca703eaa56e39497bdac80e5daa5253b53bb" })
   ```

   **绝不**先跑 A 再跑 B（或反之）— path / branch 已存在，第二条命令必失败。
3. 若 plan §进度 仍 Step 1.5 R3 未通过 → 继续 invoke `/agent-deck:deep-review` 走 R3 收口
4. 进 worktree 后按 Step 2.1 → 2.6 顺序实施（trivial 在前，复杂在后；Phase 3 / 4 独立小改动可先 commit；Phase 2 关联 schema 大改最后 commit）
5. 进度 / 决策变更必须先告诉用户征得确认

## 已知踩坑

- **不要绕过 sessionManager facade 直接 emit `session-upserted`**：manager.ts:474-481 jsdoc 已点明 facade 是中间层（repo 层不知 eventBus + mcp/tools.ts 不直 import eventBus）。但 `agent-deck-team-member-changed` 直接 emit 是项目历史模式（grep 命中 10 处包括 spawn.ts / hand-off-session.ts / ipc/adapters.ts / ipc/teams.ts），**已废 Phase 1 P1 重构**（R1 deep-review 后 Phase 1 整片删除）
- **finalizeSessionStart 不是所有 createSession 路径都走**：jsonl-missing fallback 路径**不调** finalizeSessionStart（详 session-finalize.ts:30-34 jsdoc + R6 MED-R6-1 修订）。Phase 2 / 3 修法只覆盖 spawn 主路径；fallback 路径的 first user message 走另一条 `updateCliSessionId` 链不 emit message event，不需修
- **UploadedImageThumb 当前唯一生产 callsite 是 message-row**（R2 codex LOW-2 校准）：grep 实测当前只 message-row import；NewSessionDialog 和 ComposerSdk 用各自 inline `<img>` 渲染 pending attachment thumbnail，**不复用本组件**。Phase 4 onClick 仍保持 optional 防未来其他 callsite 复用本组件不需放大场景
- **加 Hand-off badge 时与现有 wirePrefix chip 区分语义**：wirePrefix chip 显示 `↩ <from> ·<sid8>` 表示"来自另一 SDK session 的 message"；hand-off badge 显示 `Hand-off · <mode>` 表示"这是新 session 的 cold start prompt"。两者可能同时出现（罕见场景：spawn 路径 lead context block + 自己也是 hand off 起来的 session），但 chip 与 badge 互不冲突，并排显示
- **`hand-off-session.adopt-teammates.test.ts:341-342` 现有断言不要破**：`expect(promptForSpawn).not.toContain('## Hand-off context (auto-injected by Agent Deck MCP)')` 是 adopt 路径不复用 spawn marker 的关键 invariant，Phase 2 不能错把 spawn header 也注入 adopt 路径
- **本 plan 仅改 MCP tool schema 内部 plumbing 字段不改 protocol 文本**（R2 codex LOW-1 校准）：Phase 2 Step 2.2 第 4 步会给 `src/main/agent-deck-mcp/tools/schemas.ts` `SpawnSessionArgs` 加 optional `hand_off?: HandOffMetadata` 字段（带 description 标 `"hand_off_session internal plumbing; direct callers leave unset"`），是 MCP tool schema public surface 微扩展但**不改** wire prefix / lead-context block 文本 / adopted block 文本 / 任何 hand-off context block schema 文本 / resources 注入资产文本。故 `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` 两份打包注入资产**无需同步更新**（user CLAUDE.md §提示词资产维护 约束 7「对偶 / 镜像资产同步」仅针对 wire format / agent body / SKILL 文本，对 internal plumbing optional 字段不强约束）
- **lightbox 用 `fixed inset-0 z-50` 不是 `absolute inset-0`**（R2 codex MED-2 校准）：NewSessionDialog 的 `absolute inset-0` 模式仅在 App root-level sibling 才成立；ImageLightbox 挂在 MessageBubble 内（嵌套于 SessionDetail `overflow-y-auto` scroll container）必须 `fixed` 跳出滚动容器 + `z-50` 高于 NewSessionDialog `z-40` 防被遮盖。**hooks 顺序约束**：`useImageBlob` 必须无条件调用，所以用 **父组件条件 mount**（`{lightboxPath && <ImageLightbox ... />}`）而非组件内 `if (!open) return null`。**不引入** `@radix-ui/react-dialog` / shadcn-ui Dialog / `react-lightbox` / `lucide-react`，全部走项目自实现 overlay + `useImageBlob` + shared cache module + unicode close 符号
- **codex-cli adapter Phase 2 plumbing 只塞 3 处 first-user-message emit**（R2 双方独立校准）：`thread-loop.ts:91-99` (fallback) + `:166-173` (success) + `sdk-bridge/index.ts:506-516` (resume) — **不塞 `thread-loop.ts:103-110` error emit**（payload `{text:errorText, error:true}` 无 `role:'user'`，塞 handOff 会污染 error 语义、未来扫 events 误把 error 计入 hand-off baton 链）— **不塞 `sdk-bridge/index.ts:728-735` sendMessage**（是后续 user message 不是 createSession first，不接 createSession handOff opts）。Phase 3 attachments 修法**仅** claude-code 单点修（codex-cli 已对偶处理 attachments，详 Phase 3 节）
- **Phase 1 已知 IPC ordering race 不修**：`SessionUpserted` vs `AgentDeckTeamChanged` 跨 IPC channel ordering 可能短暂闪烁但最终一致。如未来用户给具体可复现的渲染异常，独立开 plan 不在本 plan 范围
- **shared image blob cache 必须从 module-local 抽到 shared module，但隔离边界严格限定 thumb + lightbox**（R2 claude MED-2 + R3 claude LOW-1 加边界）：`UploadedImageThumb.tsx:14` 现有 `cache = createImageBlobCache()` 是 module-local NOT exported。Phase 4 Step 1 抽到 `src/renderer/lib/image-blob-cache.ts` 一次性创建 + export `sharedImageBlobCache`，thumb 与 lightbox 都 import 自此 module（两者都用 `path` 作 cache key 同款 IPC）。**ImageBlobLoader 独立 cache 不合并**：`src/renderer/components/diff/renderers/ImageBlobLoader.tsx:10-13` 现有独立 `cache` 用 `<sessionId>|<JSON.stringify(ImageSource)>` 格式 cache key 与 thumb 的 `path` 格式不兼容，合并会 key collision，**不要合并入 sharedImageBlobCache**（ImageBlobLoader jsdoc:10-13 明文「与 UploadedImageThumb 不共享」invariant）。实施后 `grep -n "createImageBlobCache" src/renderer/` 应只 2 处：useImageBlob.ts:32 (export 函数) + src/renderer/lib/image-blob-cache.ts (新建 shared module)
- **adapter facade wrapper 显式字段白名单 spread 不能漏新字段**（R3 codex MED 修法）：`src/main/adapters/claude-code/index.ts:72-87` + `src/main/adapters/codex-cli/index.ts:81-97` 两个 facade `createSession` 方法都是 `await this.bridge.createSession({ cwd: opts.cwd, prompt: opts.prompt, permissionMode: opts.permissionMode, ... })` 显式字段 spread。Phase 2 Step 2.2 第 7 步必须在两个 facade 都加 `handOff: opts.handOff` 否则字段被丢，sdk-bridge 拿不到 metadata。codex-cli 还有第二层 `src/main/adapters/codex-cli/sdk-bridge/index.ts:666-672` 调 `this.threadLoop.startNewThreadAndAwaitId(internal, tempKey, cwd, opts.prompt, opts.attachments)` 也是显式字段，必须加 `opts.handOff` + thread-loop.ts:51-57 函数签名加 `handOff?: HandOffMetadata` 入参才能在 thread-loop emit 时拿到 metadata 数据源
- **Esc keydown listener 是项目首次引入**（R3 claude INFO-3）：`grep addEventListener('keydown'` 全项目命中 0 处，所有 dialog/modal (NewSessionDialog / SettingsDialog / AssetsLibraryDialog / ContentViewerModal 等) 都用 backdrop click 关闭不监听 Esc。Phase 4 Step 2 ImageLightbox 用 React 标准 idiom：useEffect cleanup function 内 remove listener（mount/unmount 正确 add/remove），plan §Phase 4 第 2 步已 inline 示例代码防偏差
