# CHANGELOG_107

## 概要

CHANGELOG_106 「手段 2」落地（用户拍板，独立 plan `llm-handoff-summary-fallback-20260514`）：让 `recoverer.ts` 的 jsonl missing fallback / cwdFellBack=true fallback 两条路径在起 fresh CLI **之前** 自动调用 LLM (sonnet) 摘要应用 DB events 历史 → prepend 到用户 prompt 前作为 fresh CLI 首条 prompt 的一部分，让用户体感「Claude 还能续聊」（而不是 CHANGELOG_106 兜底「请下条消息把背景告诉它一次」的手动补背景）。

**触发场景**（与 CHANGELOG_106 同样两条）：
- jsonl missing：dormant session 唤醒时 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` 不在（典型：用户清 ~/.claude/projects / 跨设备同步漏 / CLI 自身清理 / 应用重装）
- cwdFellBack=true：原 cwd 不存在走 `findFallbackCwd` 启发式 fallback 到新 cwd（典型：K2 老 session cwd=worktree 后 worktree 被 archive_plan 删 / 用户手动 git worktree remove）

**核心不变量**：
- 摘要失败 / DB 没历史 / 摘要超长 / settings 关 → 退回 CHANGELOG_106 已落地的「emit 提示让用户自己补背景」路径，**永不阻塞** fallback 主路径
- 不持久化摘要（每次 fallback 重算；典型 fallback 路径低频，sonnet 成本可接受）
- 不破坏 CHANGELOG_106 行为（noopSummarise / settings off 默认 → 退回原 emit）
- 仅 fallback 路径触发（正常 resume：jsonl 在 + cwd 在 → CLI 自续 jsonl，Claude 看完整对话历史，不调摘要）

## 变更内容

### Step 1: recoverer summariseFn thunk 通道接通（commit `c2c564d`）

- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts`：加 `SummariseFnThunk` type `(cwd, events) => Promise<string|null>`（与现有 `summariseSessionForHandOff` 1:1 镜像），ctor 第 6 参数 `summariseFn`（与现有 4 thunk `createThunk` / `sendThunk` / `jsonlExistsThunk` / `cwdExistsThunk` 严格对齐）；ctor body 加 `void this.summariseFn` silence TS6138（Step 2 起 prependHistorySummary helper 真调用后可移除——已在 Step 3 移除）。
- `src/main/adapters/claude-code/sdk-bridge/index.ts`：facade ctor 给 `SessionRecoverer` 多传 `(cwd, events) => this.summariseForHandOff(cwd, events)` 闭包；加 `protected summariseForHandOff` 默认转发 `summariseSessionForHandOff`（与 `resumeJsonlExists` / `cwdExists` 双层 wrapper 模式对齐）。
- `__tests__/sdk-bridge/_setup.ts` (TestBridge)：加 `summariseOverride: string | null = null` field + `summariseForHandOff` override（`null` 默认让现有 case 不撞真 LLM）。

### Step 2: prependHistorySummary helper 抽取（commit `7962a11`）

新文件 `src/main/adapters/claude-code/sdk-bridge/recoverer-helpers.ts`（~190 LOC 含 jsdoc）— module-level pure function `prependHistorySummary(opts: PrependHistorySummaryOptions): Promise<PrependResult>`。

- **5 种 PrependFailReason**：`settings-off` / `no-events` / `summary-empty` / `over-length` / `thunk-throw`
- **PrependResult**：`{ prompt: string, used: boolean, failReason?, thrown? }`
- **拼接格式**：`===== 历史会话摘要(由应用 DB 历史自动生成,因为 CLI 内部 jsonl 已丢失)=====\n<summary>\n\n===== 用户当前消息 =====\n<originalText>` —— 五等号块明确分段避免 LLM 把摘要里祈使句误归对话流
- **永不抛错**：thunk throw 封装在 `PrependResult.thrown`；caller 看 `failReason` 决定 emit 哪条 fallback 文案（本 helper **不直接 emit** AgentEvent，解耦 emit 文案 + 时机决策）
- **events 来源 = caller 传 `listEventsFn` thunk**（test seam，caller 默认 bind `eventRepo.listForSession`）
- **长度校验**：prepended > `MAX_MESSAGE_LENGTH` (102_400) → 退回 originalText（与 send-validation 全局上限对齐）

### Step 5: settings.autoSummariseOnFallback 字段全栈接通（commit `bd9863b`）

> 顺序优化（用户选 A 顺序：5 → 3 → 4 → ...）：先做 settings 字段让 Step 3/4 直接读真值，避免占位 `true` 后 grep 替换。

- `src/shared/types/settings.ts`：`AppSettings` 加 `autoSummariseOnFallback: boolean` 字段 + 详尽 jsdoc（true/false 行为对比 + 不影响正常 resume 路径声明 + 即改即生效说明）；`DEFAULT_SETTINGS` 加 `autoSummariseOnFallback: true`（default 开，摘要成本由用户主动关）。
- `src/renderer/components/settings/sections/ExperimentalSection.tsx`：在 Codex 沙盒之后加 Toggle + 三段说明文案（开/关行为对比 + sonnet 计费警告 + 失败降级声明）。
- 不动 `ipc/settings.ts`（纯 boolean 无 cache 无 apply* helper，与 `enableSound` / `silentWhenFocused` / `injectAgentDeckPlugin` 等同模式 — 消费者 recoverer 每次 fallback 时临时 `settingsStore.get` 直接读）。
- 不动 `settings-store.ts`（通用 get/set/patch 自动支持，无 REMOVED_KEYS / migration 需要）。

### Step 3: jsonl missing fallback 接 prependHistorySummary（commit `c8e123d`）

- `recoverer.ts`：加 imports `eventRepo` + `settingsStore` + `prependHistorySummary`；fallback 主路径（`cwdFellBack || jsonl missing`）createThunk 之前调 helper，拿 `PrependResult`；createThunk 用 `result.prompt` 而非 `text`。
- jsonl missing 路径（`!cwdFellBack`）的 emit 文案基于 `result.used` 分支：
  - `used=true` → emit info「⚠ 此会话的 CLI 内部对话历史(jsonl)已丢失... 应用通过 LLM 摘要自动注入了历史上下文(自 DB events 表),Claude 应能续上前情。如答非所问,请下条消息补充关键背景。」
  - `used=false` → emit 原 CHANGELOG_106 文案「请在下条消息里把背景再告诉它一次」（settings off / no events / summary empty / over length / thunk throw 均走此分支，与 CHANGELOG_106 行为一致）
- **cwd 入参语义**：cwdFellBack=true 时传 `rec.cwd`（原 cwd 让摘要保留「原本是哪个 worktree」语义），cwdFellBack=false 时传 `effectiveCwd === rec.cwd` 等价。
- 测试 mock：`sdk-bridge.recovery.test.ts` 顶部加 `vi.mock('@main/store/event-repo')`（listForSession 默认返空数组 → no-events failReason）+ `vi.mock('@main/store/settings-store')`（autoSummariseOnFallback 默认 true 与生产 default 一致）让现有 9 case 走 helper 失败分支 → emit 原文案 → 现有断言保留通过（jsonl missing case「再告诉它一次|背景」regex 仍 match）—— **同时完成 Step 7 plan 的「noopSummarise 注入到现有 9 case」任务**。

### Step 4: cwdFellBack=true 路径接 prependHistorySummary（commit `3f4c8a3`）

- `recoverer.ts` cwd fallback outer emit 简化：删去「CLI 内部对话历史(jsonl)将丢失,但 SessionDetail 历史完整保留」字眼，只保留 cwd 切换 fact（「⚠ 此会话的原 cwd 已不存在 → 启发式 fallback 到 X」）。**理由**：让后续 prependHistorySummary 决定 jsonl 命运（成功 → inner emit「LLM 摘要已注入」；失败 → inner emit「将丢失,请补背景」），outer 不预判避免「outer 说将丢 + inner 说不丢」前后矛盾误导用户。
- `recoverer.ts` inner fallback 分支加 cwdFellBack=true 子分支（对称 jsonl missing 路径 Step 3 实现）：
  - `used=true` → emit info「应用通过 LLM 摘要自动注入了历史上下文,Claude 应能在新 cwd 续上前情;如答非所问请补背景」
  - `used=false` → emit「CLI 内部对话历史(jsonl)将丢失(原 cwd 编码下的 jsonl 在新 cwd 不可用),请补背景」（保留「将丢失」字眼，语义与原版一致）

### Step 6+7: 测试覆盖新行为（commit `00adbd0`）

- `_setup.ts` (TestBridge) 加 `summariseThrow: Error | null = null` field；`summariseForHandOff` override 优先检查 throw（模拟 thunk timeout / SDK error）。
- `sdk-bridge.recovery.test.ts` `beforeEach` 加 reset `event-repo` + `settings-store` mock（让 case 间 mock 状态隔离）。
- 加 4 个新集成 case 覆盖 plan §步骤 checklist Step 6 关键路径：
  1. **jsonl missing + 摘要成功** → `createCalls[0].prompt` 含「===== 历史会话摘要」+「===== 用户当前消息」+ emit「应用通过 LLM 摘要自动注入」+ **不**emit CHANGELOG_106「请补背景」
  2. **jsonl missing + settings.autoSummariseOnFallback=false** → `createCalls[0].prompt === 'hi'`（不 prepend）+ emit CHANGELOG_106 原文案 + **不**调 summariseFn
  3. **jsonl missing + summariseFn throw** → `createCalls[0].prompt === 'hi'`（退原 prompt）+ emit CHANGELOG_106 原文案 + recoverer 主路径不抛错（helper 内 try/catch 封装）
  4. **cwdFellBack + 摘要成功** → cwd=fallback main repo（启发式 1）+ prompt 含 prepended + emit cwdFellBack 摘要成功文案（含「在新 cwd 续上」字眼区分 jsonl missing 路径）+ outer「启发式 fallback 到」仍 emit + **不**emit cwdFellBack「将丢失」原文案

> Step 7 plan 「noopSummarise 注入到现有 9 case 防默认走真 summariseFn 撞 DB 未 init 噪音」任务在 Step 1（TestBridge `summariseOverride: string | null = null` 默认）+ Step 3（vi.mock event-repo + settings-store）已完成，Step 7 不需要单独 commit。

### Step 8: 全套验证

- `pnpm typecheck` 双端 0 errors
- `pnpm exec vitest run src/main/adapters/claude-code/__tests__` = **3 test files / 37 tests 全过**
  - `sandbox-config.test.ts` 22 case
  - `sdk-bridge.consume-fork.test.ts` 2 case
  - `sdk-bridge.recovery.test.ts` 13 case（9 现有 + 4 新加）

## 已知踩坑

- **mockImplementation 类型推断**：`settingsStore.get` 是泛型 `<K extends keyof AppSettings>(key: K): AppSettings[K]`，TS 严格推断 `(key: unknown) => true | undefined` 不能赋给该签名（return undefined 不属 AppSettings union）。修法：`mockImplementation(... as never)` cast 绕过（mock 仅覆盖 autoSummariseOnFallback 一个 key，其他 key 不会被调）。
- **emit 文案微差**：摘要成功路径文案含「应用通过 LLM 摘要自动注入」+「Claude 应能续上前情」（不含「请...再告诉它一次」），test filter 精确锚定不与 CHANGELOG_106 原文案断言冲突。cwdFellBack 摘要成功文案多含「在新 cwd 续上」字眼区分 jsonl missing 路径。
- **cwd 入参 cwdFellBack=true 时传 rec.cwd 而非 effectiveCwd**：让摘要 prompt 保留「原本是哪个 worktree」的语义信号；effectiveCwd 是 fallback 后的逃生路径，与历史活动无关，传 fallback cwd 会让 LLM 看到「会话 cwd: <fallback cwd>」误导摘要的「该会话在做什么」判断。
- **outer emit 「将丢失」字眼移到 inner 分支**：Step 4 删 cwdFellBack outer 的「将丢失」字眼是关键 — 否则 outer 先说「将丢失」+ inner 摘要成功后又 emit「能续上」前后矛盾。删完 outer 只留 cwd 切换 fact，让 prependHistorySummary 全权决定后续语义。
- **Step 1 `void this.summariseFn` 仅临时 silence TS6138**：Step 3 起 helper 真调用后本行可移除，但实际 Step 3 调用仍走 `this.summariseFn`（通过 helper opts 透传），ctor body 的 `void this.summariseFn` 保留无害（Step 3 之后 TS 看 ctor 字段被 helper 透传时已 read，但 ctor body 显式 void 不破坏可读性）。
- **worktree 装 deps 边角踩坑**（CHANGELOG_106 同款）：postinstall 跑 node-gyp rebuild node-pty 因 Python 3.12+ 移除 `distutils` 报错，与本任务无关；electron 二进制 dist 没下成 → 从主 repo `node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist` symlink + `path.txt` cp 过来兜底；vitest 跑测试不需要 native binding 绕过即可。
