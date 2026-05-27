# CHANGELOG_161

Settings 面板 hand-off / 总结模型 provider 化 + reasoning 可配 (plan prancy-forging-penguin)。

## 概要

User 一次性收口诉求:

1. **设置面板 hand off 和总结模型逻辑改一下,可以填写 claude、gpt 模型和其对应的推理程度,默认 haiku**
2. **加一个选项,选择 claude 还是 codex 模型**(provider 选择器)
3. **fallback 路径自动用 LLM 总结也默认开启,不需要在设置面板里**(autoSummariseOnFallback UI 删,字段保留默认 true)

**Design 收敛**(RFC 4 题 + 2 新消息):4 字段(claude/codex × summary/handoff)→ 6 字段(summary/handoff × provider+model+reasoning)+ 删 codex 独立字段;handOff fallback alias 从 `sonnet` → `haiku` 与 summary 对齐;summarizer / IPC handoff dispatch 改成按 `settings.summaryProvider` / `handOffProvider` 选 adapter(不再按 session.agentId — claude session 也可能由 codex SDK 出总结,反之亦然,user 责任)。

## 变更内容

### `src/shared/types/settings.ts` schema 重构

**删字段**(REMOVED_KEYS 清孤儿):
- `codexSummaryModel: string`
- `codexHandOffModel: string`

**新增字段**:
```ts
summaryProvider: 'claude' | 'codex';                 // default 'claude'
summaryModel: string;                                 // default '' (fallback haiku alias / config.toml)
summaryReasoning: 'minimal' | 'low' | 'medium' | 'high';  // default 'low' (仅 codex provider 生效)
handOffProvider: 'claude' | 'codex';                 // default 'claude'
handOffModel: string;                                 // default '' (fallback haiku 改自 sonnet)
handOffReasoning: 'minimal' | 'low' | 'medium' | 'high';  // default 'medium' (仅 codex provider 生效)
```

`summaryModel` / `handOffModel` jsdoc 重写:不再写"仅对 X session 生效",改写"由 summaryProvider / handOffProvider 决定走哪个 SDK,与被总结/被 hand-off session 自身 adapter 无关"。

### `src/main/store/settings-store.ts` REMOVED_KEYS migration

append 两条:
- `'codexSummaryModel'`
- `'codexHandOffModel'`

无 smart migration — 老用户 codex 字段值丢弃,在新 UI 重选 provider=codex 后再填(简洁 design)。

### `src/main/session/summarizer/index.ts` 路由按 provider 选 adapter

`summarize()` L252:`adapterRegistry.get(session.agentId)` → 改成 `adapterRegistry.get(provider === 'codex' ? 'codex-cli' : 'claude-code')`,provider 来自 `settings.summaryProvider`。即时生效(每次 scanAll 重读)。

### `src/main/ipc/sessions.ts` hand-off handler 同款改造 + 区分两个 adapter

`SessionHandOffSummarize` handler L99-142:
- 加 `summaryAdapter` = `adapterRegistry.get(handOffProviderAgentId)` 出简报用
- 保留 `sessionAdapter` = `adapterRegistry.get(session.agentId)` 用于 Stage 2 fail-fast `createSession` 校验(被 hand-off 的目标会话仍沿用自己 adapter 起新 session,与 user 选的 simulate provider 无关)

**关键边界**:两个 adapter 必须分开取(plan §已知踩坑 第 1 条)。前者按 settings 选 / 后者按 session 自身。

### Runner 改造(3 处)

- **`src/main/session/summarizer/llm-runners.ts`** `summariseSessionForHandOff()`:fallback alias `'sonnet'` → `'haiku'` + env 链 `ANTHROPIC_DEFAULT_SONNET_MODEL` → `ANTHROPIC_DEFAULT_HAIKU_MODEL` 与 summary 对齐
- **`src/main/adapters/codex-cli/summarizer-runner.ts`** `summariseCodexSessionViaOneshot()`:`modelReasoningEffort` 从 hardcoded `'low'` 改成 `settings.summaryReasoning ?? 'low'`;`model` 改读 `settings.summaryModel`(原 `codexSummaryModel`)
- **`src/main/adapters/codex-cli/handoff-runner.ts`** `summariseCodexSessionForHandOff()`:`modelReasoningEffort` 从 hardcoded `'medium'` 改成 `settings.handOffReasoning ?? 'medium'`;`model` 改读 `settings.handOffModel`(原 `codexHandOffModel`)

### `src/main/session/oneshot-llm/codex-runner.ts` type 扩

`modelReasoningEffort` 字段类型从 `'low' | 'medium' | 'high'` 3 档扩到 `'minimal' | 'low' | 'medium' | 'high'` 4 档(与 settings UI dropdown 对齐;codex SDK 真支持 5 档含 'xhigh',当前 UI 4 档够用)。

### `src/renderer/components/settings/sections/SummarySection.tsx` UI 重做

**改前**:4 个 ModelInput 一字排开(claude 周期总结 / claude handoff / codex 周期总结 / codex handoff)

**改后**:2 row,每 row 3 控件并排:
```
┌──────────────────────────────────────────────────────────────────┐
│ 周期性总结    [claude▼] [haiku             ] [low▼]              │
│ Hand-off 简报 [claude▼] [haiku             ] [medium▼]           │
└──────────────────────────────────────────────────────────────────┘
```

- **Provider select**:`claude` / `codex` dropdown
- **Model input**:复用 ModelInput 控件(draft + blur commit),free-form model id
- **Reasoning select**:`minimal/low/medium/high` 4 档 dropdown,**provider=claude 时 disabled 灰显**(tooltip 提示 claude 端 thinking 走 model id 后缀)

抽出 `ModelRow` 组件(`Provider + Model + Reasoning` 三联),`ModelInput` 简化为单 input(label / hint 上提到 ModelRow)。

### `src/renderer/components/settings/sections/ExperimentalSection.tsx` 删 autoSummariseOnFallback toggle

删 L90-106 整块(`<Toggle>` + hint)+ `Toggle` import + section jsdoc 更新说明字段保留默认 true 不可配(成本敏感时仍可改 `settings.json` 手动 set false)。

### `src/main/session/__tests__/hand-off.test.ts` 测试更新

- L138 `expect(call.options.model).toBe('sonnet')` → `'haiku'`,setup 清的 env 从 `ANTHROPIC_DEFAULT_SONNET_MODEL` → `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `uses ANTHROPIC_DEFAULT_SONNET_MODEL env` test → 改 `uses ANTHROPIC_DEFAULT_HAIKU_MODEL env` 同款验 HAIKU env
- `uses settings.handOffModel` test 内 env setup 全部 SONNET → HAIKU(handOff fallback 链已变)

## 不影响

- `settings.autoSummariseOnFallback` 字段保留,default `true` 不变,运行时(recoverer Step 3/4)行为与原一致
- `settings.codexMcpServers` / `mcpHttpEnabled` / `mcpStdioEnabled` 等其他设置字段不动
- 三 tab 切换 / 其他 SectionGroup 布局不动(SummarySection 仍在「通用 tab → 会话 group」位置)
- summarizer 3 层降级(LLM oneshot → assistant 文字 → 事件 kind 统计)架构不变,只改第 1 层 dispatch 路由
- 已在跑的 in-flight LLM 调用不撤回(provider 改了对下次 scanAll 起效)

## 验证

- `pnpm typecheck` GREEN
- `pnpm exec vitest run src/main/session/__tests__/hand-off.test.ts` ✅ 6/6 pass(2 fail 修后全过)
- UI 手测推迟到 `.app` 新版本发布后视觉验证:确认 SummarySection 4 row → 2 row + Provider/Reasoning 控件,Provider=claude 时 Reasoning disabled,切到 codex 启用

## 已知踩坑(plan §已知踩坑 抄录)

- `adapter` 变量复用陷阱:hand-off handler 必须区分 `summaryAdapter`(出简报)与 `sessionAdapter`(Stage 2 createSession),前者按 settings 选 / 后者按 session 自身 — 不要图省事用一个变量
- `adapter.summariseEvents` 接口语义变化:从前是「session 自己的 adapter 出简报」,现在是「任意 adapter 给任意 session 出简报」— 实施时全文 grep 看是否 adapter 内部有 cwd / agentId 自检假设(本次已确认无)
- Provider × Model 匹配是 user 责任:`summaryModel='haiku' + summaryProvider='codex'` 会撞 codex SDK 不识别报错并走 caller fallback(assistant 文字 / 事件统计)— 日志清楚
