# CHANGELOG_194 — teamless DM：解除 send_message 的 shared-team 限制

## 概要

让任意两个 session 无需共享 active team 也能互发消息（用户诉求：「会话之间可以任意发送消息」）。MCP `send_message` 在 caller 与 target 无 shared active team 且未显式传 teamId 时，自动降级 **teamless DM**（`team_id=NULL`）——消息仍入 `agent_deck_messages` 表 + 正常注入 receiver SDK conversation flow，只是不进 TeamDetail 聚合面板。**有 shared team 时行为完全不变**（byte-identical）；teamless 仅是 `findSharedActiveTeams` 返空时的新分支。

plan `teamless-dm-20260601`（多会话 + worktree 隔离 + RFC + spike + deep-review 全流程）。

## 设计要点

- **team_id 可空（真 DM）**：加 v027 migration 放松 `agent_deck_messages.team_id` 的 `NOT NULL`，而非临时造隐式 team（避免污染 team 列表 + 打破 team-task 隔离）。
- **无 team 时 fallback**：有 shared active team 走原 team 路径零改动；仅无 shared team 时降级 teamless。
- **限流按 sender session**：teamless 限流桶 key 从 `teamId` 换成 `from:<sessionId>`（per-sender 60/min 防失控烧 token；`from:` 前缀防与 UUID teamId 撞桶）。
- **不加新 UI**：teamless 不进 team 面板，但 messages 表留痕 + 注入 receiver 会话。

## 变更内容

### DB / migration

- **新建 `src/main/store/migrations/v027_agent_deck_messages_team_id_nullable.sql`**：rename-old-first 整表重建放松 `team_id` NOT NULL。
  - ⚠️ **关键陷阱**（spike 实证）：`agent_deck_messages` 有自引用 FK（`reply_to_message_id → agent_deck_messages(id) ON DELETE SET NULL`，v015）。v017-style「建 `_new` + `DROP old` + RENAME」在 `foreign_keys=ON` 下会**静默 null 掉所有 reply chain**——`DROP old` 的隐式 DELETE 触发 `_new` 自引用 FK 的 `SET NULL`，且 `foreign_key_check` 反而 PASS（null 是合法值）。v017 没踩是因为 member 表无人引用；messages 引用自己是质的区别。`PRAGMA defer_foreign_keys` 不救（只推迟检查不推迟 cascade 动作）。
  - ✅ 修法 = **rename-old-first**：先 `RENAME old → _old`，用最终名建新表（自引用 FK 解析到自己），`INSERT FROM _old`，最后 `DROP _old`（无人引用 → 零 cascade）。byte-level 照搬 v010 全部 CHECK/DEFAULT（仅 team_id 去 NOT NULL）+ 重建 5 个 index。
- `migrations/index.ts`：注册 v027。

### 类型链 `string → string | null`

- `agent-deck-message-repo/_deps.ts`：`MessageRow.team_id` + `InsertMessageInput.teamId`
- `shared/types/agent-deck-team.ts`：`AgentDeckMessage.teamId` + `AgentDeckMessageStatusChangedEvent.teamId`
- `event-bus.ts:98`：`agent-deck-message-enqueued` 的 **inline 字面类型**（非 interface，就地改）
- `universal-message-watcher/enqueue.ts`：`EnqueueMessageInput.teamId`
- `preload/api/teams.ts`：`onAgentDeckMessageChanged` 回调 payload（cb 签名 + subscribe 泛型）
- `index/bootstrap-wiring.ts`：`messageChangedSender` 泛型（dedup key 用 messageId 不含 teamId，无逻辑改）

### 行为逻辑

- **`enqueue.ts` 限流分流**：`rateKey = input.teamId ?? 'from:' + input.fromSessionId`。
- **`send.ts` teamless 分支**（3 处叠加，deep-review 修正）：
  - 分支顺序：**显式 teamId 优先校验**（∉ sharedTeams 必 reject，不静默降级）→ 单 team auto-resolve → 多 team `ambiguous-team` err → 仅「没传 teamId 且 length===0」才 teamless。
  - teamless 前置补 **caller/target archived reject**（绕过 `findSharedActiveTeams` 的 archived 过滤后必须显式补，否则 archived 双方静默入队再被 watcher 异步 markFailed）。
  - teamless reply **pair-scope 校验**：`original.teamId === null` 单独不够（`null!==null` 放行任意 teamless reply），叠加 `{from,to}` 必须是同一对 session（防持有任意 teamless messageId 挂无关 DM chain 污染 reply graph）。
- **`universal-message-watcher/index.ts` D5 短路**：`dispatchClaimed` 把 4 项 team 闸门（team not found / team archived / from-to membership）包进 `teamId !== null` guard；session 级闸门（target/from archived / adapter 支持）对 teamless 也保留。`resolveFromDisplayName` 签名 `teamId: string|null`，teamless 时不查 membership 直接走 `session.title` fallback。

### 文档 / 文案

- `send_message` schema `teamId` 字段 + index 注册描述：「Reject when sharing zero teams」→「无 shared team 时 teamless DM；多 team 仍需 teamId 去重；传不共享的 teamId 仍 reject」。
- `spawn_session.teamName` stale 文案：「standalone session — caller cannot send_message it」→「仍可 teamless DM 互发，只是不进 team 面板」。
- `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` 的「跨会话救火」§shared-team 前置约束段：从「必报 no-shared-team」改为「teamless DM 投递成功（不再 hard reject）；需保留 reviewer mental model / 多 team 归属时仍建议回 team」。

## 测试

- **`tools.test.ts`**（send_message gate）：原「share zero → no-shared-team reject」断言**反转**为「→ teamless DM 投递（teamId=null）」（唯一反转点）+ 新增 6 case：显式错 teamId reject / target archived reject / caller archived reject / teamless reply pair-scope reject / 同 pair teamless reply 放行 / team↔teamless 边界 reject。**hand-off 系列 5 处 no-shared-team 保护断言禁止反转，未动**（验证 hand-off 后确实失去 shared team，与 teamless 正交）。
- **`enqueue.test.ts`**（D3 rateKey）：teamless 用 `from:<sid>` 桶 / 两 sender 独立桶 / 同 sender 跨多 receiver 共享单桶达 60 reject / 前缀隔离不撞 teamId 桶。
- **`universal-message-watcher.test.ts`**（D5）：teamless dispatch 不调 team repo（`teamRepoGetCalls`/`membershipInCalls` 断言 0）但仍 markDelivered / teamless target archived 仍 markFailed。
- **新建 `v027-migration.test.ts`**（真 sqlite，binding-probe skip-guard）：sub-case A post-v027 schema（team_id 可空 / 自引用 FK enforce / CHECK+DEFAULT 保留 / 5 index）；sub-case B v026→v027 升级**保留多级 reply chain**（核心：朴素重建会静默 null → 本断言抓）+ status/attempt 保留 + teamless insert + team CASCADE 不波及 teamless。

**全套 1533 passed（112 文件，0 regression）** / typecheck 双配置绿 / build 三 bundle 绿。dev 实测用户确认跳过。

## Deep-review（plan Step 1.5）

team `teamless-dm-review` 异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，互盲）2 轮收口，双方「R2 可合」/ 0 HIGH / 0 MED 存活：
- spike 拦下 reply-chain 静默损坏 bug（双方独立用 sqlite3 复现确认 rename-old-first 修法）。
- R1 挖 6 条 plan 缺陷全采纳：reply pair-scope（codex，HIGH→MED 裁决双方同意）/ archived 前置（codex）/ 分支顺序（codex）/ 测试矩阵「51」数字错→精确清单（claude）/ event-bus inline 类型（claude）/ resolveFromDisplayName 签名（claude）+ LOW（preload 类型 / spawn 文案）。
- R2 补 2 条测试缺口（D5 watcher / D3 rateKey）全 fix。
- 全部 plan 文档/测试精度问题，0 设计缺陷。
