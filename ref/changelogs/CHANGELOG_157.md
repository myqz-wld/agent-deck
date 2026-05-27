# CHANGELOG_157

ad-hoc prompt-asset deep review (4 round 双异构对抗 + 反驳轮 + 三态裁决) + 顺手发现并修 codex frontmatter `model` dead-letter bug。无 plan 文件 / 无 worktree (轻量 review,改动直接 commit main)。

## 概要

**触发**:user 请求「deep review 提示词资产 (CLAUDE.md / agents / skills / 关联内容)」走 `agent-deck:deep-review` SKILL,scope=mixed (18 文件 ~3781 LOC)。

**关键发现**:user follow-up 质疑代码注释中「codex SDK 不接受 per-thread model override」判断 → 实证 `@openai/codex-sdk@0.131.0` `ThreadOptions.model` 已支持 per-thread override + 应用代码 `sdk-bridge/index.ts:483/496` startThread/resumeThread 调用主动**没** spread model 字段 (一行 dead-letter) → 代码 + 文档 sweep 让 frontmatter `model` 真生效。

**review 4 round 总览**:
- R1:reviewer-claude 7 finding (2H+2M+2L+4I) + reviewer-codex 4 finding (0H+3M+1I) → 反驳轮共识 HIGH 降 MED + 5 单方 MED + lead 自验
- R2:reviewer-claude 7 (1H+1M+1L+4I) + reviewer-codex 4 (0H+2M+2L) → HIGH-R2-1 union 11 处过期注释 sweep
- R3:reviewer-claude 5 (0H+1M+0L+4I) + reviewer-codex 1 LOW → 100% 重叠 finding (session-finalize.ts:34 jsdoc 漏修)
- R4:reviewer-claude ✅ 全部通过 + reviewer-codex ❌ 4 处 "同 model 同款" wording 残留 → 修后收口

## 变更内容

### codex frontmatter `model` 真生效 (代码 + DB schema 行为)

- `src/main/adapters/codex-cli/sdk-bridge/index.ts:483` resumeThread + `:496` startThread 加 `...(opts.model !== undefined ? { model: opts.model } : {})` spread 进 ThreadOptions
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts:127-138` 删 codex warn block (frontmatter model 不再是 dead config)
- `src/main/adapters/codex-cli/sdk-bridge/session-finalize.ts:65-77` 删 runtime-not-effective warn
- `src/main/agent-deck-mcp/tools/schemas.ts:62-63` `agent_name` describe 反向修 (`only effective for claude-code` → `effective on both adapters`)

### codex hand-off / 周期总结 model 对标 claude haiku/sonnet 优先级链 (新增 settings 字段)

- `src/shared/types/settings.ts` 加 `codexSummaryModel?: string` + `codexHandOffModel?: string` (默认空 = fallback `~/.codex/config.toml`,零行为变化)
- `src/main/session/oneshot-llm/codex-runner.ts` `runCodexOneshot` 接 `model?: string` 参数 + startThread spread `...(opts.model !== undefined && opts.model.trim().length > 0 ? { model: opts.model.trim() } : {})`
- `src/main/adapters/codex-cli/summarizer-runner.ts` caller 加 `model: settingsStore.get('codexSummaryModel') || process.env.CODEX_SUMMARY_MODEL || undefined`
- `src/main/adapters/codex-cli/handoff-runner.ts` 同款 `codexHandOffModel`

### `mcp__hand_off_session.cwd` tool description 抽 callout (信息密度)

- `src/main/agent-deck-mcp/tools/schemas.ts:313-333` 新增 `HAND_OFF_SESSION_CWD_CONTRACT` callout (在 `HAND_OFF_SESSION_SHAPE` 前) — 含 4 段 SSOT 引用 (claude / codex cold-start protocol + cwd resilience + external worktree 降级)
- `schemas.ts:359` `cwd.describe` 从 ~400 中文字精简到 ~200 字 + 末尾指针指 callout

### Prompt-asset 修订 (~25 处)

- **`~/.claude/templates/reviewer-claude.sh.tmpl` L7-9** (user 全局,git 不追踪) 删 "agent-deck 自身仍是旧布局 / conventions/ 不在 ref/ 下" 过时叙述
- **`resources/codex-config/CODEX_AGENTS.md:224`** 半角 `(Phase: ...)` → 全角 `（Phase: ...）` 与 impl/test/schemas.ts 对齐
- **`resources/codex-config/CODEX_AGENTS.md:12 + 144`** 措辞 "建议 user 显式选边" / "通常省略" → 可执行边界
- **`resources/claude-config/CLAUDE.md`** hand_off generic mode 节加 cwd 不持久跨 turn 描述 (与 CODEX_AGENTS.md L218 对偶)
- **`scripts/sync-codex-skills.mjs`** 加 `SKIP_SKILLS = new Set(['flow-arch-plantuml'])` + 跑 sync 删 codex-config flow-arch-plantuml mirror (该 SKILL 含 claude-only 工具 `AskUserQuestion` / `Read`,codex 端无对等)
- **`reviewer-claude.md:8` + `reviewer-codex.md:8`** 「两份 file `name` 同名」→ 「分别命名 reviewer-claude / reviewer-codex (frontmatter name 不同, bundled qualifiedName 另含 adapter 维度消歧)」

### 过期 jsdoc / 注释 sweep (12 处 + 漏修补 1 处 + R4 wording 补 4 处)

代码层 codex `model` 真生效后,清理跨文件残留的"仅 UI 显示" / "不接受 per-thread model override" / "runtime 不生效" / "同 model 同款" 等过期表述:

- `src/shared/types/session.ts:75-87` model 字段 jsdoc
- `src/main/adapters/types.ts:170-176` AdapterCreateOpts.model jsdoc + L185-194 extraAllowWrite jsdoc (R3 顺手修)
- `src/main/store/migrations/v018_sessions_model.sql:8-13` migration 注释
- `src/main/store/session-repo/core-crud.ts:225-229` setModel function jsdoc
- `src/main/adapters/codex-cli/sdk-bridge/session-finalize.ts:1-22` file-level jsdoc + L34-43 PersistSessionFieldsArgs.model jsdoc + L43-46 extraAllowWrite jsdoc + L55-62 persistSessionFields function jsdoc
- `src/main/adapters/codex-cli/__tests__/sdk-bridge/_setup.ts:41-46` test mock model 字段 jsdoc
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts:278-283` modelFromFrontmatter spread 注释
- `src/main/ipc/sessions.ts:106-111` codex hand-off 路径注释
- `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts:77-86` model 字段 jsdoc + L87-95 extraAllowWrite jsdoc + L97-99 / L383 / L412 "同 model 同款" wording
- `src/main/adapters/codex-cli/sdk-bridge/index.ts:304-314` model 字段 jsdoc + L549 "同 model 同款" wording
- `src/shared/types/settings.ts:68-69` (summaryModel jsdoc) + L82-84 (handOffModel jsdoc) 反向引用 codexSummaryModel / codexHandOffModel 对偶字段

### Follow-up backlog (单独 plan)

- codex model regression test (verify ThreadOptions.model 真传 SDK + settings/env 优先级 + 边界 case)
- `src/renderer/components/settings/sections/SummarySection.tsx` UI 接 `codexSummaryModel` + `codexHandOffModel` + 旧 hint 改回 "settings > env > config.toml fallback"
- settings UI trim 校验 (UI 与运行时一致)
- 透明配置从设置面板排除 (user 之前请求,本会话未处理)
- 加快捷键说明 section (user 之前请求,本会话未处理)

## 验证

- `pnpm typecheck` GREEN (R1/R2/R3/R4 fix 后各跑一次)
- 跨 repo grep verify "runtime-not-effective | 不接受 per-thread | 仅持久化未生效 | 与 model 字段同款 | 同 model 同款" 排除反例样本后 0 真残留
- 双 reviewer R4 ✅ 收口
