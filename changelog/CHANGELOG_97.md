# CHANGELOG_97: K2 接力 baton 语义改造（default 不加 team + default 归档 caller）

**触发**：用户实测 K2 plan 接力（mcp `start_next_session`）撞到「原会话被打 lead 标签 / 新会话被打 teammate 标签」UX 噪音，DB 实证铁证 plan team 几乎从未真正通信 → 设计语义错配（dispatch 派人干活 vs baton 单向交接）。

## 概要

`mcp__agent_deck__start_next_session`（K2 plan 接力）原默认行为强加对话型 lead/teammate 关系：

- caller 默认被打上 lead 标签（SessionList 蓝边）
- 新 session 默认被打上 teammate 标签（SessionList 「↳ teammate」缩进）
- 自动写一条 placeholder cold-start prompt 到 `agent_deck_messages` 表

**实证铁证**（用户 DB snapshot）：

```sql
SELECT t.name, COUNT(msg.id) AS msg_count FROM agent_deck_teams t
LEFT JOIN agent_deck_messages msg ON msg.team_id = t.id ...
```

| team | msg_count | 性质 |
|------|----------:|------|
| `desk-assistant-20260512`（plan 接力 team）| **1** | 仅 K2 自动 placeholder，lead/teammate 之间从未真正对话 |
| `deep-review-32` | 4-8 | 真 reviewer 对抗，lead/teammate 频繁通信 |
| `phase4-manager-split-review` | 4-8 | 同上 |

**根因**：plan 接力的本质是「caller 把 baton 单向交出，新 session 独立接手，原 caller 退出」，不是「派出小弟干活，原 caller 当 lead 持续监督」。原设计混淆两种场景：lead/teammate 关系语义只对 reviewer 对抗 / fan-out 派活有意义，对单向 hand-off 是冗余 UX 噪音。

## 修法（A+B 合并）

### A. K2 default 不传 team_name 给 spawn

`src/main/agent-deck-mcp/tools/handlers/start-next-session.ts:96-105`

```ts
// CHANGELOG_97：team_name 不再默认设为 plan_id —— baton 单向交接语义不需要 lead/teammate
// 关系；caller 显式传 team_name 时仍透传给 spawn 启用通信关系（罕见使用）。
const spawnArgs: SpawnSessionArgs = {
  adapter: args.adapter ?? 'claude-code',
  cwd: args.cwd ?? resolved.worktreePath,
  prompt: resolved.coldStartPrompt,
  ...(args.team_name !== undefined ? { team_name: args.team_name } : {}),
  ...(args.permission_mode !== undefined ? { permission_mode: args.permission_mode } : {}),
};
```

spawn handler 看到 `team_name === undefined` 时短路 `args.team_name` 分支（spawn.ts:188 `if (args.team_name)`）→ 不 ensureByName / 不 addMember / 不写 placeholder message。

返回字段中 `teamId` / `teamName` / `spawnPromptMessageId` 自然变 null（spawn handler return 结构原本就允许 nullable，不破坏 K2 调用方契约）。

### B. K2 default 自动归档 caller session

`src/main/agent-deck-mcp/tools/handlers/start-next-session.ts:126-140`

```ts
// 5. CHANGELOG_97：自动归档 caller session（baton 语义 = 原会话退出，新会话独立接手）。
if (caller.callerSessionId !== EXTERNAL_CALLER_SENTINEL) {
  const archiveFn =
    handlerDeps?.archiveSession ?? ((sid: string) => sessionManager.archive(sid));
  try {
    await archiveFn(caller.callerSessionId);
  } catch (e) {
    console.warn(
      `[mcp start_next_session] archive caller ${caller.callerSessionId} failed:`,
      e,
    );
  }
}
```

设计要点：

- **位置**：spawn 成功后、return ok 之前。spawn 失败 / impl 失败时**不**调 archive（baton 还没出手）
- **失败兜底**：warn-only 不阻塞 K2 ok return（同 K3 hand-off 模式 `src/main/ipc/sessions.ts:122-127`）
- **EXTERNAL_CALLER_SENTINEL 防御**：external caller 已在 handler 第一行被 `denyExternalIfNotAllowed` 拦下，理论不会到这里；防御性双保险防 future external caller 路径放开后误删
- **`archiveSession` test seam**：让单测无需 mock 整个 sessionManager（与 `spawnSession` seam 同款 inject 模式）
- **caller 仍可在「历史」面板回看**：archive 不是 delete，session 仍保留所有 events / messages

## 变更内容

### 修改文件

#### 1. `src/main/agent-deck-mcp/tools/handlers/start-next-session.ts`

- 顶部 jsdoc 整段改写：加「CHANGELOG_97 baton 语义改造」段落（2 条要点：default 不加 team + default 归档 caller）
- import `EXTERNAL_CALLER_SENTINEL` from `../../types`
- import `sessionManager` from `@main/session/manager`
- `StartNextSessionHandlerDeps` 加 `archiveSession?: (sid: string) => Promise<void>` test seam
- spawn args 改 `team_name: args.team_name ?? args.plan_id` → 条件展开 `...(args.team_name !== undefined ? { team_name: args.team_name } : {})`
- 加 §Step 5: archive caller 块（带防御 + warn-only 兜底）

#### 2. `src/main/agent-deck-mcp/tools/schemas.ts`

`team_name` 字段 `.describe()` 改写：「Default: not set (CHANGELOG_97 baton semantic) ... pass explicitly only if you specifically want lead/teammate communication」。

#### 3. `src/main/agent-deck-mcp/tools/index.ts`

K2 tool annotation 整段重写：加「Baton semantic (CHANGELOG_97): by default does NOT join any team AND auto-archives the caller session after spawn」。返回字段说明加「teamId (null when no team_name) / teamName (null) / spawnPromptMessageId (null)」明确默认值。

#### 4. `~/.claude/CLAUDE.md` §Step 3 §选项 B

L188-194 K2 行为列表改写：

- 删「加入 plan-id team（caller 当前会话自动成为 lead，新 session 成为 teammate）」
- 加「**不加任何 team**（baton 单向交接语义：新 session 独立接手，不强加 lead/teammate 关系）。需要通信关系时显式传 `team_name`」
- 加「**自动归档 caller session**（baton 完整交出原会话退出；归档失败仅 warn 不阻塞 ok return，用户至少能拿到 newSid）」
- 返回字段说明加「teamId (默认 null) / teamName (默认 null) / spawnPromptMessageId (默认 null)」
- 适用场景段去掉「lead 调完 K2 后通常 shutdown_session 自己（或留着 wait_reply 监 teammate 反馈）」（baton 语义下 caller 已被 archive，不存在 lead 监 teammate 反馈场景）+ 加「caller 在 archive 后仍可在『历史』面板查看接力前的最后一段对话」

#### 5. `resources/claude-config/CLAUDE.md` §plan hand-off 自动化：start_next_session

L88-102 调用模板 + 行为描述同步改写（与 user CLAUDE.md 一致）：注释加 `// CHANGELOG_97: team_name 默认不传`，return 注释加 `teamId (默认 null)` 等，行为列表加「**CHANGELOG_97 baton 语义**：default 不加任何 team + default 自动归档 caller session」段。

#### 6. `src/main/agent-deck-mcp/__tests__/start-next-session.test.ts`

- happy path it 改名「调 spawn handler + 透传 K2 metadata + 透传 spawn 字段 + **归档 caller**」：
  - mockSpawn return 字段全 null（teamId / teamName / spawnPromptMessageId）
  - 加 `mockArchive` test seam + `archiveCalls: string[]` 记录
  - 断言 `spawnArgs.team_name).toBeUndefined()`（替代 `.toBe(planId)`）
  - 断言 `data.teamId).toBeNull()` / `data.teamName).toBeNull()` / `data.spawnPromptMessageId).toBeNull()`
  - 断言 `mockArchive).toHaveBeenCalledTimes(1)` + `archiveCalls).toEqual(['caller-sid'])`
- 「caller 显式 cwd / team_name → 透传给 spawn」it：加 mockArchive + 断言显式 team_name 时仍归档 caller（baton 语义与是否启用 team 通信关系正交）
- 加新 it「CHANGELOG_97: archive caller 失败 → warn-only 不阻塞 K2 成功 return」：mockArchive reject + warnSpy 验 console.warn 调用 + K2 ok return
- 「spawn handler 返回 isError → 直接透传不二次包装」it 加 `expect(mockArchive).not.toHaveBeenCalled()`（spawn 失败 → 不归档 caller，没接到新 baton 不该让原会话退出）
- 「impl 错误（plan 文件不存在）→ err 不调 spawn」it 加 `expect(mockArchive).not.toHaveBeenCalled()`（plan 解析失败 → 既不 spawn 也不归档）

### 新增文件

- `changelog/CHANGELOG_97.md`：本文件
- `changelog/INDEX.md`：追加一行索引

## 决策（不走对抗的依据）

| 决策 | 依据 |
|------|------|
| A+B 合并而非单独 A 或 B | 用户已选 C（A+B 合并，接力语义最完整）。baton 语义是「单向交接」，A 删 team 关系 + B 归档原会话才能完整表达「原会话退出 + 新会话独立接手」 |
| default archive 而非加 toggle `archive_caller: boolean = true` | YAGNI；当前 K2 用户场景 100% 想让原会话退出（实证 desk-assistant-20260512 团队仅 1 条 placeholder，无 follow-up 通信意图）。未来真有人想保留 caller active 再加 toggle |
| 仍保留 `team_name` 显式 override | 罕见但合理：用户偶尔想让接力新 session 与原 session 保持通信关系（如做 review handoff 后想监控）。保留 escape hatch，不锁死 |
| archive 失败 warn-only 不阻塞 | 与 K3 hand-off `ipc/sessions.ts:122-127` 同款。属于「联动 UX 行为」而非「释放标记 / 清 Map」类清理；caller 至少拿到 newSid，原会话留 active 影响小，用户可手动右键归档 |
| 不修 K3 hand-off | K3 (`SessionHandOffSpawn`) 已经是 archive 模式 + 不加 team（默认走 `adapter.createSession()` 不带 teamName），是对的。本 PR 仅改 K2 |
| 不修 spawn_session tool 行为 | spawn_session 是 lead 派活的通用 tool，team_name 触发 lead/teammate 关系是核心语义。本 PR 仅在 K2 这一层不传 team_name 给 spawn，不动 spawn handler 自身 |
| 不删历史 plan team 数据 | 用户私有 DB 状态，让用户自己决定何时手动清 archived team（v017 CASCADE 已让删 sessions 自动级联清 team_members） |
| 不走异构对抗 | 单点行为改动 + 实证铁证（DB snapshot 1 vs 4-8 message_count 反差 + 用户实测体验报告）+ 设计取舍清晰（baton vs dispatch 二选一）+ 用户已选 C 方案 |

## 已知踩坑

- **caller archive 链问题**：A 接力 B 接力 C 接力 D 时每次都 archive 上一个，最终 A/B/C 都 archived 只剩 D active。这正是 baton 链式交接的预期；用户在「历史」面板能看完整链条
- **EXTERNAL_CALLER_SENTINEL 双保险冗余但保留**：handler 第一行 `denyExternalIfNotAllowed` 已保证 external caller 不到这里；archive 块再加一道 sentinel 检查是防御性，便于未来如果放开 external caller 时自动护住
- **K3 hand-off 行为不变**：K3 已经独立用 `sessionManager.archive(sid)` 调用，不走 K2 路径。两者并存（K2 = mcp tool 自动化 plan 接力，K3 = UI 按钮 LLM 总结接力），都默认归档原会话语义一致
- **历史 plan team 数据保留**：之前 K2 跑过的 plan team（如 `desk-assistant-20260512`）仍在 DB，UI TeamHub 仍可见。让用户自己决定何时清理（手动右键归档 team / hardDelete）；v017 CASCADE 后删 sessions 不再撞 FK
- **`team_name` 显式传时仍 archive caller**：测试覆盖此 case（`caller 显式 cwd / team_name → 透传给 spawn` it 也断言 archive 被调用）。设计意图：baton 单向交接语义与是否启用通信关系正交——caller 想保持 lead 通信但仍想退出原会话是合理需求

## 测试

- `pnpm typecheck` 双端通过
- `vitest run start-next-session.test.ts` 全过（happy path / 归档失败兜底 / spawn 失败不归档 / impl 失败不归档 / external caller deny 等 24+ it）
- 端到端验证留下次 dev smoke：在真 plan 接力场景调 K2 → 验 caller 自动归档 + 新 session 不被打 teammate 标签 + DB `agent_deck_team_members` 不增 row

## 关联

- **CHANGELOG_92**：K2 start_next_session 实现的本体（含「team_name 默认 plan_id」原始设计 + caller 加入 plan-id team 自动化）
- **CHANGELOG_93**：K3 UI hand-off 实现（`SessionHandOffSpawn` 已是 archive 模式 + 不加 team，本 PR K2 与之对齐）
- **CHANGELOG_96 v017 CASCADE**：让删 sessions 不再撞 `agent_deck_team_members.session_id` RESTRICT FK，本 PR archive 路径在 caller 是某 team active member 时也能正确触发后续 session delete（如果用户最终手动删除 archived caller session）
- **`~/.claude/CLAUDE.md` §Step 3 §选项 B**：plan 接力 K2 自动化文档 SSOT（本 PR 同步更新 baton 语义说明）
- **`resources/claude-config/CLAUDE.md` §plan hand-off 自动化**：应用 CLAUDE.md K2 tool 用法示例 SSOT（本 PR 同步更新）
