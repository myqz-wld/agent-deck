# CHANGELOG_145 — hand-off cold-start 特殊渲染 / create session 图片显示 / 图片放大查看

## 概要

3 phase UX 缺陷修复 + 2 round 异构对抗 review 收口（Opus 4.7 × gpt-5.5 双 reviewer）:

- **Phase 3**:claude-code adapter `createSession` 首条 user message 漏传 attachments → events.payload 不含 attachments 字段 → message-row 不渲染缩略图(create session 带图后看不到图 UX bug)。修法:`session-finalize.ts` `FinalizeSessionStartArgs` 加 `attachments` 字段 + emit 'message' 时 spread + `sdk-bridge/index.ts:427-431` 透传 `opts.attachments` 给 finalize。
- **Phase 4**:图片缩略图不可放大查看。新建 `ImageLightbox` 组件(`fixed inset-0 z-50` overlay + Esc keydown + 父组件条件 mount + unicode `✕` close);抽 `src/renderer/lib/image-blob-cache.ts` `sharedImageBlobCache` 让 thumb + lightbox 共享 cache(点缩略图开 lightbox 时不重拉图);`UploadedImageThumb` 加 optional `onClick` prop;`message-row` 给缩略图加 onClick + 条件 mount lightbox(state 在 MessageBubble 内单独持有,多 bubble 互不干扰)。
- **Phase 2**:hand-off cold-start prompt 平铺一大坨遮蔽 task prompt。新增 `HandOffMetadata` schema + 10 步 cross-adapter plumbing 让 spawn / hand_off_session adopt 路径首条 user message events.payload 携带 metadata;`message-row` 解析两种 marker(spawn + adopt),user bubble 顶部渲染 cyan Hand-off badge(`payload.handOff` 优先 / marker fallback 兼容老 events),adoptedBlock + lead context block 区块用 `<details>` disclosure 默认收起(summary 文案按 spawn vs adopt 区分)。
- **R1 deep-review × 2 异构 reviewer**:5 处 finding 全 fix(1 真 LOW + 2 *未验证* LOW + 2 INFO 顺手);**R2 verify** 0 新 HIGH/MED/LOW。0 HIGH 0 真 MED 收口可合。

详异构对抗 review finding 表见下方「R1 异构对抗 review fix」节。归档 plan [handoff-render-and-image-batch-20260521.md](../../plans/history/handoff-render-and-image-batch-20260521.md)。

## 变更内容

### Phase 3 — claude-code adapter create session 附图漏传修

- `src/main/adapters/claude-code/sdk-bridge/session-finalize.ts`:加 `UploadedAttachmentRef` import + `FinalizeSessionStartArgs.attachments?: readonly UploadedAttachmentRef[]` 字段 + 解构 + emit 'message' 时 `...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {})` spread
- `src/main/adapters/claude-code/sdk-bridge/index.ts:427-431`:`finalizeSessionStart()` 调用透传 `attachments: opts.attachments`(与 `extraAllowWrite` 同款 spawn-time 透传模式)
- **Codex-cli adapter 对偶状态(无需修)**:3 处 first-user-message emit (`thread-loop.ts:91-99` fallback / `:166-173` success / `sdk-bridge/index.ts:506-516` resume) 已全部 spread attachments,plan §不变量 5 cross-adapter parity 守住

### Phase 4 — 图片放大查看

- **新建 `src/renderer/lib/image-blob-cache.ts`**:export `sharedImageBlobCache` 让 `UploadedImageThumb` + `ImageLightbox` 共享 LRU cache(两组件 cache key 同款 = `path`,点缩略图开 lightbox 时秒开)。**隔离边界严格限定**:**仅 thumb + lightbox 两组件共享**;`ImageBlobLoader.tsx:10-13` 现有独立 cache 不合并(cache key 格式 `<sessionId>|<JSON.stringify(ImageSource)>` 与 thumb `path` 不兼容,合并会 key collision)
- **新建 `src/renderer/components/ImageLightbox.tsx`**:`fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm` overlay(**不是** `absolute inset-0` — 跳出 SessionDetail `overflow-y-auto` scroll container,`z-50` 高于 NewSessionDialog `z-40` 防遮挡);Esc keydown listener(项目首引此模式,React 标准 idiom useEffect cleanup function 内 remove);内层 `max-w-[90vw] max-h-[90vh] object-contain` 自适应;`useImageBlob(loader, path, sharedImageBlobCache)` 共享 cache;右上 unicode `✕` close 按钮(不引入 lucide-react / @radix-ui/react-dialog / shadcn-ui Dialog / react-lightbox 等三方依赖);**always-open 设计**:caller 通过父组件条件 mount(`{lightboxPath && <ImageLightbox ... />}`)控制可见性,组件无 `open` prop(规避 `useImageBlob` 必须无条件调用的 hook 规则)
- `src/renderer/components/UploadedImageThumb.tsx`:改用 `sharedImageBlobCache`(替代原 module-local cache);加 optional `onClick?: () => void` prop;`<img>` `cursor-pointer` className 仅当 onClick 存在时应用;默认行为不可点击(向后兼容当前唯一 callsite + 未来其他 callsite 不需放大场景)
- `src/renderer/components/activity-feed/rows/message-row.tsx`:加 `lightboxPath` useState;缩略图 onClick `() => setLightboxPath(a.path)`;bubble 末尾条件 mount `{lightboxPath && <ImageLightbox onClose={() => setLightboxPath(null)} path={lightboxPath} alt="attachment large" />}`(state 在 MessageBubble 内单独持有,多 bubble 互不干扰)
- `src/renderer/hooks/useImageBlob.ts:19`:`interface CacheEntry` 改 export(TS4023 修法 — `sharedImageBlobCache` `Map<string, CacheEntry>` 类型 inferred 后非 exported type 不能跨模块命名)

### Phase 2 — Hand-off cold-start prompt 特殊渲染

#### Schema + plumbing 层(10 步)

1. `src/shared/types/session.ts:181-211`:新增 `HandOffMetadata` interface(5 字段:`mode: 'plan' | 'generic'` / `planId / phaseLabel / fromCallerSid / hasAdoptedBlock`)+ 不变量 jsdoc 明文「不进 SDK first message 文本(仅走 events.payload)/ 不在 codex error emit 出现 / 不在 sendMessage 后续 user message 出现」
2. `src/main/adapters/types.ts:138-145 + :248-256 + :300-307`:`ClaudeCreateOpts` + `CodexCreateOpts` + `CreateSessionOptionsRaw` 三 interface 都加 `handOff?: HandOffMetadata` optional 字段
3. `src/main/adapters/options-builder.ts:106 + :141`:`narrowToClaudeOpts` + `narrowToCodexOpts` 加 `if (raw.handOff !== undefined) out.handOff = raw.handOff` 透传
4. `src/main/agent-deck-mcp/tools/schemas.ts:100-122`:`SpawnSessionArgs` 加 `hand_off` zod object schema(5 字段 enum/string/nullable/boolean)+ description 明文 "internal plumbing; direct callers leave unset"
5. `src/main/agent-deck-mcp/tools/handlers/spawn.ts:277`:`omitUndefined` 块加 `handOff: args.hand_off` 透传给 `buildCreateSessionOptions`
6. `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:534-540`:装配 5 字段 HandOffMetadata 传给 `spawnArgs.hand_off`(`mode: resolved.mode` / `planId: args.plan_id ?? null` / `phaseLabel: resolved.mode === 'plan' ? args.phase_label ?? null : null`(R1 reviewer-codex LOW 修法 — generic mode 时与 ignoredFields + ok return 契约一致)/ `fromCallerSid: caller.callerSessionId` / `hasAdoptedBlock: args.adopt_teammates === true && adoptedSnapshot !== null`)
7. **adapter facade wrapper**(R3 reviewer-codex MED 修法):`src/main/adapters/claude-code/index.ts:89` + `src/main/adapters/codex-cli/index.ts:99` 两个 facade `createSession` 显式 spread `handOff: opts.handOff`(否则白名单 spread 会丢字段 → bridge 拿不到 metadata)
8. **claude-code sdk-bridge**:`index.ts:186-193` createSession opts inline type 加 `handOff?: HandOffMetadata` + `:430` 调 `finalizeSessionStart({..., handOff: opts.handOff})` 透传 + `session-finalize.ts:60-72` `FinalizeSessionStartArgs.handOff?` 字段 + emit 'message' 时 `...(handOff ? { handOff } : {})` spread
9. **codex-cli sdk-bridge**:`index.ts:36` import HandOffMetadata + `:380-388` createSession opts inline type 加 `handOff?` + `:510-527` resume first-user-message emit `...(opts.handOff ? { handOff: opts.handOff } : {})` spread + `:670-679` 调 `startNewThreadAndAwaitId(..., opts.handOff)` 透传给 thread-loop
10. **codex-cli thread-loop**:`thread-loop.ts:15` import + `:51-65` `startNewThreadAndAwaitId` 函数签名加 `handOff?: HandOffMetadata` 入参 + `:91-108` fallback first-user-message emit spread + `:170-186` success first-user-message emit spread

#### 不变量 5 守门(cross-adapter 对偶 emit)

- **携带 4 处**(first user message emit):claude × 1(`session-finalize.ts:147-155`) + codex × 3(`thread-loop.ts:91-99` fallback + `:166-173` success + `sdk-bridge/index.ts:506-516` resume)
- **不污染 5 处**(防 events 表 hand-off baton 链识别误把后续轮次计为新 baton 触发点):claude sendMessage emit + codex sendMessage emit + codex error emit `{text:errorText, error:true}` + codex 30s timeout warning emit + codex late error message emit。**双 adapter sendMessage emit 配 inline 注释明示**(R1 reviewer-claude INFO-1 修法)

#### UI 层(message-row.tsx)

- **2-marker SSOT**(R1 reviewer-claude LOW-1 修法):新建 `src/shared/hand-off-headers.ts` export `HAND_OFF_SPAWN_HEADER` + `HAND_OFF_ADOPT_HEADER` 2 常量,3 处装配 / 识别方同源 import(`lead-context-block.ts` spawn 装配 / `adopted-teams-context-block.ts` adopt 装配 / `message-row.tsx parseHandOffContext` 识别)
- **解除 wirePrefix 触发条件**:`parseHandOffContext` 改为对所有 `role === 'user'` message 都 try parse(adopt 路径 SDK first message 无 wire prefix,旧 `wirePrefix &&` 前置导致 adopt 整个 adoptedBlock + cold-start prompt 平铺一大坨)。返 `{handOff, main, kind: 'spawn' | 'adopt' | null}` 由 marker index 决定 kind
- **Hand-off badge**(cyan-500/15 风格,与 wirePrefix chip 并排可同时显示):`payload.handOff` 优先级链 → metadata 优先(`Hand-off · {mode}` + tooltip 含 planId / phaseLabel / fromCallerSid / adopt 标识)/ 无 metadata + marker 命中(fallback 兼容老 events / 不走本 plan plumbing 的 spawn 路径)→ `Hand-off · {kind}` / 都没命中 → 不显示
- **adoptedBlock disclosure 区分 summary 文案**:adopt → "Adopted teams context(adopt 路径注入,点开查看新 lead 接管的 team / teammate)" / spawn → "Hand-off context(lead 注入,点开查看 lead session_id / team_id / send_message 用法)"
- **`message-row.tsx` jsdoc 更新**(R3 reviewer-claude LOW-2 修法):删除「wirePrefix 命中前置」描述(改动已解除前置),改为「marker 字面量精确匹配 + `\n---\n\n` 分隔符是唯一识别条件」+ 说明误识别概率极低(37+59 字符精确 marker + 分隔符 + adopt block multi-line 段不会被简短用户输入命中)

### 测试守门

- **新加 5 个 handOff plumbing 断言**(R1 reviewer-codex INFO 修法 + 配套 LOW regression 防御):
  - `src/main/agent-deck-mcp/__tests__/tools.test.ts`:`createSessionCalls` spy 扩 `handOff?: HandOffMetadata` 字段记录;加 3 个 plumbing test(claude-code adapter 透传 handOff / codex-cli adapter 透传 handOff / caller 不传 hand_off 时 adapter 收到 `handOff === undefined`)
  - `src/main/agent-deck-mcp/__tests__/hand-off-session.adopt-teammates.test.ts:354-360`:加 hand_off 5 字段 toEqual 断言(plan-driven + `adopt_teammates: true` 路径 plumbing 透传 verify)
  - `src/main/agent-deck-mcp/__tests__/hand-off-session.handler-cwd-generic.test.ts:402-414`:加 spawnArgs.hand_off 断言(generic mode + 误传 `phase_label` 时 `spawnArgs.hand_off.phaseLabel === null` regression 防御 — R1 reviewer-codex LOW 配套)

### R1 异构对抗 review fix(5 处)

| Finding | reviewer | 类型 | 修法 |
|---|---|---|---|
| `hand-off-session.ts:534` generic mode phaseLabel 契约不一致 | codex 单方 + 现场验证 | 真 LOW | 改用 `resolved.mode === 'plan' ? args.phase_label ?? null : null` 三元过滤,与 ok return path L872 字面一致 |
| HAND_OFF_HEADERS 与 adopted-block header 文案 SSOT | claude *未验证* LOW | 顺手 | 抽 `shared/hand-off-headers.ts` + 3 处 import |
| ImageLightbox `open` prop 不消费 | claude *未验证* LOW | 顺手(API 一致)| 删 prop + caller 同步 |
| codex sendMessage emit 缺不变量 5 注释 | claude INFO | 顺手 | claude + codex 双 adapter sendMessage emit 对称加注释 |
| tools.test.ts spy 缺 handOff 字段记录 | codex INFO | 顺手(回归守门)| spy 扩字段 + 3 个新 plumbing test + handler-cwd-generic 加 spawnArgs.hand_off 断言 |

**跳过**(reviewer 自标 *非强制 / 收益小可暂缓*):reviewer-claude INFO-2 zod / TS infer SSOT(协议解耦合理)+ INFO-3 HandOffMetadata 装配抽 helper(目前仅 1 处装配)。

### R2 verify(0 新 HIGH/MED/LOW)

两路 reviewer 异构 quick verify 4 点 sanity 全 ✅ confirm:
1. 不变量 5 守门铁证(claude × 1 + codex × 3 first user message emit 仍 spread / 5 处不污染路径仍不带)
2. HAND_OFF_HEADERS SSOT 抽常量后链路同源(spawn + adopt + renderer 3 处 import 同 const)
3. ImageLightbox 删 prop 后无 dead code(props 仅 onClose/path/alt,TS 编译期硬护栏 caller 同步)
4. generic mode phaseLabel 修法装配处与 ok return 字面一致(契约同步)

可合,reviewer 双方明确建议「Step 2.6 用户实测 → Step 3 changelog → Step 4 archive_plan」收口。

## 验证

- `pnpm typecheck` ✅
- `pnpm build` ✅
- `pnpm exec vitest run tools.test.ts hand-off-session.adopt-teammates.test.ts hand-off-session.handler-cwd-generic.test.ts adopted-teams-context-block.test.ts` 4 文件 90 tests ✅(含 5 新 handOff 断言)
- 用户手工实测 3 phase 用户场景 ✅:
  - Phase 3:dev 模式 create session 带图 → 缩略图渲染正确(修前漏传不显示)
  - Phase 4:点缩略图 → fixed inset-0 z-50 overlay 全屏显示,Esc / 点空白 / 点 ✕ 关闭;再点 thumb 秒开(共享 cache 命中)
  - Phase 2:hand_off_session adopt 起新 session → 第一条 user bubble 顶部见 cyan Hand-off badge(hover 显 metadata)+ adoptedBlock 折叠 disclosure 不再平铺;spawn 路径 fallback marker 同样工作
