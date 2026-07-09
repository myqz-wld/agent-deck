# CHANGELOG_109

## 概要

Plan `model-wiring-and-handoff-20260514`：闭环 model 链路三处不闭环点 — agent frontmatter `model` 字段在 teammate spawn 路径下死字段 + summarize/hand-off model 选择只能通过 env 配（UI 无暴露） + codex session hand-off 借用 claude SDK + sonnet。详细 plan 见归档 [`plans/model-wiring-and-handoff-20260514.md`](../../plans/history/model-wiring-and-handoff-20260514.md)。

共改 14 文件 + 新建 3 文件 + 1 新 regression case + 全套 504 tests / typecheck 双端全过。

## 变更内容

### A: agent frontmatter `model` 透传 SDK + 持久化 sessionRepo

- 新建 `src/main/store/migrations/v018_sessions_model.sql` + `src/main/store/migrations/index.ts` 注册 v018
- `src/shared/types/session.ts` `SessionRecord.model?: string | null`
- `src/main/store/session-repo/types.ts` Row 加 `model: string | null` + rowToRecord hydrate
- `src/main/store/session-repo/core-crud.ts` upsert INSERT/UPDATE/binding 三处加 model + 新 `setModel(id, model)` setter（与 setPermissionMode / setClaudeCodeSandbox 同款 per-session 持久化模式）
- `src/main/adapters/types.ts` `CreateSessionOptions` 加 `model?: string` 字段
- `src/main/adapters/claude-code/sdk-bridge/model-resolve.ts`（新建）：fallback 链 `opts.model > sessionRepo.get(resume)?.model > undefined`（仿 sandbox-resolve.ts 模式，但**不**查 settings — 那是 oneshot 路径专属）
- `src/main/adapters/claude-code/sdk-bridge/index.ts:136-162` createSession opts 加 model + 调 resolveClaudeModel + 透传给 buildClaudeQueryOptions + finalize 持久化
- `src/main/adapters/claude-code/sdk-bridge/query-options-builder.ts` BuildClaudeQueryOptionsArgs 加 model + SDK options 加 `...(model ? { model } : {})`
- `src/main/adapters/claude-code/sdk-bridge/session-finalize.ts` FinalizeSessionStartArgs 加 claudeModel + setModel 写库
- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts` CreateSessionThunk 加 model + recover 两条路径（fallback / resume）显式透传 `model: rec.model ?? undefined`，与 claudeCodeSandbox 同款防 SDK 重启时 model 静默降级
- `src/main/adapters/claude-code/index.ts` createSession opts 加 model（spread 直接透传给 bridge）
- `src/main/adapters/codex-cli/sdk-bridge/index.ts:149-278` createSession opts 加 model + 两条路径（resume / 新建）setModel 持久化 + console.warn 提示「codex SDK 不接受 per-thread model override，runtime model 由 ~/.codex/config.toml 顶层 model 决定」（D5 设计：codex teammate frontmatter model 仅持久化让 UI 显示，不会真正切 model）
- `src/main/adapters/codex-cli/index.ts` createSession opts 加 model + spread 透传
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts:84-99` agent_name 分支拿 bodyResult 后 `parseFrontmatter(bodyResult.content)` 提取 fm.model（trim 非空才认）→ 传给 createSession({ model })；codex-cli adapter 时额外 console.warn
- `src/main/agent-deck-mcp/tools/schemas.ts` agent_name 字段 description 补一句「Frontmatter `model` field auto-extracted and forwarded to SDK (only effective for claude-code adapter)」

**实际效果**：reviewer-claude.md `model: opus` 之类的 frontmatter 现在真正生效（从前死字段，spawn 不读不传 → reviewer 实际跑 lead 主模型）。reviewer-codex.md `model: sonnet` 仅持久化让 UI 显示（codex SDK 不支持 per-thread override，warn 提示用户改 toml）。

### B: settings 加 summaryModel + handOffModel 字段 + UI

- `src/shared/types/settings.ts` AppSettings 加 `summaryModel: string`、`handOffModel: string`，DEFAULT_SETTINGS 默认 `''`
- `src/main/session/summarizer/llm-runners.ts:summariseViaLlm` model 优先级链：`settingsStore.get('summaryModel') > ANTHROPIC_DEFAULT_HAIKU_MODEL > ANTHROPIC_MODEL > 'haiku' alias`
- `src/main/session/summarizer/llm-runners.ts:summariseSessionForHandOff` 同款：`settingsStore.get('handOffModel') > ANTHROPIC_DEFAULT_SONNET_MODEL > ANTHROPIC_MODEL > 'sonnet' alias`
- `src/renderer/components/settings/sections/SummarySection.tsx` 加 ModelInput 控件（local 实现，draft / focus / blur 提交模式与 NumberInput 同款避免每字符触发 IPC）+ 两个 input：「周期性总结模型」/「hand-off 简报模型」
- 两个 input hint 注明「留空 = 沿用 ANTHROPIC_DEFAULT_*_MODEL env / SDK alias 兜底；只对 claude-code session 生效，codex session 用 ~/.codex/config.toml 顶层 model」

**实际效果**：用户不再需要改 ~/.claude/settings.json env 才能切 summarize / hand-off model — 在应用 Settings → 间歇总结 直接填即可。空 = 沿用 env 链路（老用户无感，零迁移成本）。

### C: codex session hand-off 走 codex SDK 自身

- 新建 `src/main/adapters/codex-cli/handoff-runner.ts` `summariseCodexSessionForHandOff(cwd, events, formatEvents)`：镜像 `summarizer-runner.ts` 但 prompt 用 4 节结构化模板（目标 / 已做 / 下一步 / 相关文件）+ `modelReasoningEffort: 'medium'`（hand-off 比 summarize 'low' 提一档保结构精度，medium 折中 high 太慢 / low 精度不够）+ 60s timeout（与 claude hand-off 平齐）
- `src/main/ipc/sessions.ts:70` 把直接调 `summariseSessionForHandOff` 改成按 session.agentId 派发：`'codex-cli' → summariseCodexSessionForHandOff` / 其他 → `summariseSessionForHandOff`（claude SDK + sonnet 路径不变）

**实际效果**：codex session hand-off 简报终于由 codex 自己出（modelReasoningEffort='medium' + 4 节模板），而非借用 claude SDK + sonnet（修前用 sonnet 给 codex session 写接力简报，inconsistent）。runtime model 由 codex CLI 自身的 `~/.codex/config.toml` 决定（codex SDK 不接受 per-thread model override），settings.handOffModel 对 codex 路径无影响（仅对 claude session 生效），UI hint 已注明。

### D: 验证

- `src/main/session/__tests__/hand-off.test.ts` 加新 case `uses settings.handOffModel when set, overriding both env vars`（直接 set settingsStore + 双 env 同时设 → assert SDK 收到 settings 值）
- `pnpm typecheck` ✅ / `pnpm test` ✅ 504 passed | 64 skipped（pre-existing）
- 手动 e2e（dev mode 重启验证）由 lead 自行：spawn reviewer-claude 验 SDK first-turn 用 opus / 关应用重启验 sessionRepo.model 持久化 + dormant 唤醒一致 / Settings 输 haiku model 验周期性 summarize 切换 / 起 codex session 点 hand-off 验 modal 拿到 codex 出的 4 节简报

### 设计要点（不在代码注释里抄一遍 — 看 plan）

- **D1 frontmatter only**：spawn_session 不加 caller 显式 model 覆盖参数，reviewer-{claude,codex}.md 现状零改动即生效
- **D2 写 sessionRepo**：spawn 后 setModel 持久化让 SDK resume / dormant 唤醒后保持模型一致
- **D3 settings 字符串字段（默认空）**：空 = 沿用 env / alias 链，零迁移成本
- **D4 codex hand-off 用 medium reasoning**：high 太慢 + low 精度不够，medium 折中
- **D5 codex teammate spawn frontmatter model 不生效但持久化**：codex SDK 不接受 per-thread model override；warn 提示用户改 toml
- **D6 兜底 alias 不变**：summarize 'haiku' / hand-off 'sonnet' SDK alias 兜底保留兜底链路韧性
