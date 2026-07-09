# CHANGELOG_71: REVIEW_28 落地 — 移除 spawn-guards §6.2 cwd cycle + 加 spawned_by_filter / get_session

## 概要

`deep-code-review` SKILL 实测调 `mcp__agent_deck__spawn_session` 起首个 reviewer-claude teammate 时被 `same-cwd same-adapter spawn cycle detected` 直接 deny —— SKILL 设计要求 lead (claude-code, REPO) 起两 reviewer teammate 都用 `claude-code, REPO`，与 spawn-guards.ts §6.2 cwd realpath 整链回溯规则**直接冲突**。

合并修复 §6.2 移除 + list_sessions / get_session 弱点，覆盖 reviewer-claude × reviewer-codex 双对抗 13 条裁决（全部 ✅，详 [REVIEW_28.md](../../reviews/history/REVIEW_28.md)）。MCP tool 总数 5 → 6（加 get_session）。

## 变更内容

### 防递归规则（src/main/agent-deck-mcp/spawn-guards.ts）

- 删 `checkCwdCycleAlongChain` + `safeRealpath` 整段（§6.2 移除）
- `applySpawnGuards` 顺序重排：depth → fan-out → spawn-rate（rate token 在 depth + fan-out 都通过后才扣，防 fan-out 撞顶 lead spam 把 app-wide quota 拒掉别 lead 的饥饿；REVIEW_28 reviewer-codex MED-1）
- 头注释更新为「3 条规则」+ §6.2 移除原因 + 残留语义自递归由 §6.1 depth 截断接受
- 残留 `inFlightChildren` race protection 语义保留（depth/rate/fan-out 仍可 deny，handler finally 仍要 release）

### list_sessions 加 spawned_by_filter（src/main/agent-deck-mcp/tools.ts）

- `LIST_SESSIONS_SCHEMA` 加 `spawned_by_filter: z.string().min(1).max(128).optional()` + describe 信任边界（无 ownership 校验，与现状一致）
- handler 加 `if (args.spawned_by_filter) sessions = sessions.filter(s => s.spawnedBy === args.spawned_by_filter)`，**在 slice(limit) 前执行**（reviewer-codex INFO-1：避免大 lead 反查少量 children 被 cutoff 误报空）

### get_session 新 tool（src/main/agent-deck-mcp/tools.ts + types.ts + transport-stdio.ts）

- `tools.ts` 抽 `projectSession` helper 共享 list_sessions / get_session（reviewer-codex LOW-2：禁止暴露 raw SessionRecord，future visibility predicate 加在一处即两 tool 同步生效）
- `tools.ts` 加 `GET_SESSION_SCHEMA` + `getSession` tool（read-only annotation；session 不存在返 isError + hint）；`buildAgentDeckTools` return 数组从 5 → 6
- `types.ts` `AGENT_DECK_TOOL_NAMES` 加 `getSession: 'get_session'`；`EXTERNAL_CALLER_ALLOWED` 加 `'get_session': true`（read-only 类比 list_sessions / wait_reply）
- `transport-stdio.ts` 注释 5 → 6 tool

### tools.ts spawn_session description / 注释清理

- :233 description 删 `cwd-cycle` 字段，改为 `Subject to depth / per-parent fan-out / per-app rate-limit`
- :256-258 handler 注释「4 条规则」→「3 条规则」+ 移除 §6.2 提及

### session-repo.ts listAncestors deprecated 注释

- 标「2026-05 deprecated」，保留实现避免 R3 churn（生产代码当前无调用点）

### 测试同步（src/main/agent-deck-mcp/__tests__/）

#### spawn-guards.test.ts

- 删 `applySpawnGuards — cwd cycle 整链回溯` describe 全段（4 例）
- 删 fan-out 段内 `cycle deny 路径自动 release in-flight` 用例（删 §6.2 后无「inc 后才 deny」路径）
- 新增 `fan-out deny 不消耗 spawn-rate token（防饥饿）` 用例验证 reviewer-codex MED-1 修法

#### tools.test.ts

- 删 `rejects same-cwd same-adapter (self-spawn cycle)` 用例
- 改名 `allows different cwd same adapter` 段保留；新增 `allows same cwd same adapter (deep-code-review SKILL 合法路径)` 替代被删的 cycle 用例
- 新增 list_sessions 2 例：`respects spawned_by_filter` / `combines spawned_by_filter + adapter_filter`
- 新增 get_session 2 例：`returns same projection as list_sessions` / `returns isError when session does not exist`

#### 测试统计

- spawn-guards.test.ts: 12 例 → 8 例（删 4 cycle + 删 1 cycle release + 加 1 fan-out 不耗 rate）
- tools.test.ts: 22 例 → 28 例（删 1 cycle + 加 1 same cwd same adapter + 加 2 spawned_by_filter + 加 2 get_session + 加 1 改名）
- 全套 vitest：21 files / 325 passed | 55 skipped 无回归

### Settings UI 文案（src/renderer/components/settings/sections/AgentDeckMcpSection.tsx）

- 顶部 `<div>` 5 → 6 tool 加 `<code>get_session</code>`
- 头注释「5 个 tool」→「6 个 tool」 + 「防递归 4 条规则」→「3 条规则」
- depth 提示文字删「调高需配合整链 cwd cycle 检测」（与删 §6.2 后行为相反），改写为 fan-out × spawn-rate 兜底说明（极端 5³=125 descendants 一分钟内会撞 spawn-rate 限流）

### ADR (docs/agent-deck-mcp-protocol.md)

- §1.1 5 → 6 tool（加 get_session 行）
- §3.4 list_sessions 加 `spawned_by_filter` schema + 信任边界一句 + handler 行为加「filter 在 slice 前执行」
- §3.5 **新增** get_session 完整 schema + 行为 + 典型场景 + 信任边界（与 §3.4 一致）
- §3.6 shutdown_session 原 §3.5 顺次后移
- §6 标题「4 条规则」→「3 条规则（B'5 + REVIEW_28 移除 §6.2）」
- §6.2 改写为「2026-05 移除」+ 残留语义自递归说明（**不**写「完全等价覆盖」误导）
- §6.3 加顺序约束段（rate token 在 depth + fan-out 都通过后才扣）
- §6.4 加极端规模段（1 + 5 + 25 + 125 = 156 live session；reviewer-codex MED-2 修法）
- §9 tools.ts 文件注释 5 → 6
- §10 V7 5 → 6 个 tool；V11 / V20 标 ❌ obsolete (REVIEW_28)；V12 / V13 加 REVIEW_28 联动备注；新增 V22 / V23 / V24
- §12 R2 的 5 tool → 6 tool（2 处）
- §13 加 2026-05-12 REVIEW_28 完整变更条目

### SKILL (resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md)

- frontmatter description 5 → 6 tool + 加 list_sessions(spawned_by_filter) / get_session 提及
- 第 10 行「前提」段 5 → 6 tool
- Step 0 删 `mcp__agent_deck__list_sessions(status_filter:'active')` 自检步骤 → 改为 2 步（cwd + scope）+ 一段说明「不要预先 list_sessions 探活」
- §失败兜底「投递 failed」一条改为「lead 已持有 sessionId，调 get_session 拿 lifecycle / lastEventAt；多 receiver 救火用 list_sessions(spawned_by_filter)」
- §失败兜底新增「lead context 重置后捡起 stranded reviewer」用 list_sessions(spawned_by_filter:'<old_lead_sid>')

### 跨文件 5 → 6 tool 同步（≥15 处）

- `README.md:226` 6 个 tool
- `resources/claude-config/CLAUDE.md:157` 6 tool
- `docs/agent-deck-team-protocol.md:51 / 52 / 889 / 976 / 991` 5 → 6 tool（4 处）
- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md:21` 5 → 6 tool + 加 list_sessions(spawned_by_filter) / get_session 提及
- `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md:21` 同上

## 备注

- **同款问题预防**（已记入 REVIEW_28 Agent 踩坑沉淀，待 `.claude/conventions-tally.md` 累计 3 次升级到 CLAUDE.md）：
  - 防御规则不要拦合法 SKILL 用例（添加 deny 规则前必须 grep 现存 SKILL / agent body 验证）
  - rate token 扣除时机必须在所有「不消耗资源 deny」之后（防饥饿模式）
- **build / e2e 验证**：本次 typecheck + 全套 vitest pass，未触动 IPC / Electron main 入口 / 打包配置 / 数据库 schema → 跳过 build；用户 e2e 验证 deep-code-review SKILL 真 spawn 时若有问题再补
- **后续可清理**：`session-repo.ts listAncestors` 已标 deprecated，未来 R3 / R4 重构时可一并删除（生产代码无调用点）
- **关联 reviews**：[REVIEW_28.md](../../reviews/history/REVIEW_28.md)（含 reviewer-codex 3 次重试历史 + 13 条裁决全清单）
