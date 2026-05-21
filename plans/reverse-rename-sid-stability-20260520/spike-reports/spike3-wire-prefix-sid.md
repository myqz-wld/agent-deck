# spike3: wire prefix sid 现状 + 真实 reply 流验证

> spike 完成日期：2026-05-20
> runner: `spike3-runner.mjs` (read-only 静态实测)
> log: `spike3.log`

## 动机

plan §设计决策 D7 不变量 3 说「wire prefix `[sid <senderSid>]` 写 sessions.id（应用稳定身份,不写 cli_session_id）」。本 spike 验证:

1. wire prefix `[sid ${...}]` 当前实际写哪个 sid
2. caller.callerSessionId 跨 3 种 mcp transport (in-process / http / stdio) 的来源
3. mcp-session-token-map 的 sid 含义（sessions.id 还是 cli_session_id?）
4. 反向 rename 后 wire prefix sid 是否真的稳定 (不变量 4)

## 实测命令 + 实测结果

### 实测 3.1: wire prefix builder (universal-message-watcher/index.ts:112)

```typescript
return `[from ${safeDisplayName} @ ${safeAdapterId}][msg ${message.id}][sid ${message.fromSessionId}]\n${message.body}`;
```

`message.fromSessionId` ← `agent_deck_messages.from_session_id` 列 ← caller.callerSessionId(send_message handler 入队时写)。

### 实测 3.2: send_message handler fromSessionId 来源 (send.ts:106)

```typescript
const result = enqueueAgentDeckMessage({
  teamId,
  fromSessionId: caller.callerSessionId,  // ← 来自 mcp transport callerSessionIdOverride
  toSessionId: args.session_id,
  body: args.text,
  replyToMessageId: args.reply_to_message_id ?? null,
});
```

### 实测 3.3: spawn handler 首轮 prompt 注入 wire prefix (spawn.ts:235)

```typescript
const fullPrompt =
  `[from ${leadFromName} @ ${leadAdapterSanitized}][msg ${placeholderId}][sid ${caller.callerSessionId}]\n` +
  ...;
```

✅ spawn 首轮 placeholderId / lead sid 与正式 `send_message` 路径完全对称(同款 wire format)。

### 实测 3.4: send_message no-shared-team check (send.ts:53)

```typescript
const sharedTeams = agentDeckTeamRepo.findSharedActiveTeams(
  caller.callerSessionId,
  args.session_id,
);
```

`findSharedActiveTeams(senderSid, receiverSid)` 走 `agent_deck_team_members` 表 JOIN — `team_member.session_id` 列 ← caller.callerSessionId / target.sessionId。**反向 rename 不动 sessions.id → team_member.session_id 也不变 → 反向 rename 后此查询自然 ✅** (plan §已知踩坑项已记录)。

### 实测 3.5-3.6: caller.callerSessionId 三种 transport 来源

`HandlerContext.caller.callerSessionId` 由 `withMcpGuard` 入口从 `callerSessionIdOverride` 读取(helpers.ts:44)。三种 mcp transport 来源链:

| transport | 来源 | 是否读 cli_session_id |
|---|---|---|
| **in-process** (claude SDK) | sdk-bridge ctor 时透传 spawn 时的 sessionId | ❌ 永远是 sessions.id |
| **HTTP** (codex 必走) | `authInfo.resolvedSid` from `mcp-session-token-map.get(token)` | ❌ token map 用 sessions.id 做 key (`mcp-session-token-map.ts:60-62`) |
| **stdio** (外部 CLI) | 固定 `EXTERNAL_CALLER_SENTINEL = "__external__"` | (N/A — 不是真 sessionId) |

### 实测 3.7: mcp-session-token-map.allocate 写的是 sessions.id

`mcp-session-token-map.ts:60-62`:
```typescript
sessionToToken.set(sessionId, token);
tokenToSession.set(token, sessionId);
```

`allocate(sessionId)` caller (`bridge.ensureCodex` / `sdk-bridge.createSession`) 传的就是当前 spawn 完成后的 sessions.id (CHANGELOG_98+99+100 实施期间无 reverse rename — sessions.id == cli_session_id)。**反向 rename 后**:
- sessions.id 不变 → token map key 不变 → token 一直指向同 sessions.id ✅
- cli_session_id 变化 → token map 不感知 (token map 不含 cli_session_id 字段) ✅

### 实测 3.8: mcp-session-token-map.rename 当前在 sessionManager.renameSdkSession 内被调

`manager.ts:486`:
```typescript
mcpSessionTokenMap.rename(fromId, toId);
```

**反向 rename 修法影响**:
- 新增 `updateCliSessionId(applicationSid, newCliSid)` 函数 ← **不调** mcpSessionTokenMap.rename(token map 不需要变)
- 现有 `renameSdkSession(tempKey, realId)` 仅 spawn 路径首次确认 sessions.id ← **保留** mcpSessionTokenMap.rename
- 6 处反向 rename 路径(spike2 实测列表) ← 全部从 `renameSdkSession(OLD_CLI_ID, NEW_CLI_ID)` 改为 `updateCliSessionId(rec.id, NEW_CLI_ID)` → 不触发 token map rename

### 实测 3.9: wire prefix e2e test 已有覆盖

`__tests__/wire-prefix-e2e.test.ts:124`:
```typescript
return `[from ${opts.displayName} @ claude-code][msg ${opts.msgId}][sid ${opts.senderSid}]\n${opts.body}`;
```

测试 fixture 字面镜像 builder L112 ouput,反向 rename 后只要 `senderSid === sessions.id`(已实证)就不需要改 test。

## 结论

✅ **D7 不变量 3 假设成立**: wire prefix `[sid <senderSid>]` 100% 写 sessions.id,反向 rename 后:

1. `caller.callerSessionId` 跨 3 种 mcp transport 全部走 sessions.id 链路(in-process spawn 透传 / HTTP authInfo.resolvedSid / stdio sentinel)
2. `mcp-session-token-map` token 用 sessions.id 做 key,反向 rename 不动 sessions.id → token 永远稳定
3. `agent_deck_messages.from_session_id` / `team_members.session_id` 列均存 sessions.id,反向 rename 不动这两表
4. 6 处反向 rename 路径只改 cli_session_id 列,不调 mcpSessionTokenMap.rename / sessionRepo.rename(后者会改 sessions.id),完全 bypass wire prefix 链路

**实施推论 (D7 修法清晰)**:
- 新增 `sessionRepo.updateCliSessionId(applicationSid, newCliSid)` 仅 UPDATE `cli_session_id` 列
- 新增 `sessionRepo.findByCliSessionId(cliSid)` 反查 — sql `SELECT * FROM sessions WHERE cli_session_id = ?` (唯一索引保证 O(log N))
- 6 处反向 rename 路径全部从 `renameSdkSession` 改为 `updateCliSessionId` (函数签名见 D5)
- 不调 `mcpSessionTokenMap.rename` — token map 不需要变

## 残留风险

- ⚠️ **wire prefix `[from <displayName>]` 字段含 sessions.id 信息泄漏**: caller 透 prefix 知道 receiver 的 sessions.id (8 字节前缀显示)。反向 rename 不影响此现状(本来 wire prefix 就在透传 sid),无新风险。
- ⚠️ **token map 双向 entry 不感知 cli_session_id**: 这是设计上故意的(token 应用层不需要知道 CLI 内部 thread sid),反向 rename 后行为与现状一致。如未来需要用 cli_session_id 做安全审计 / 路由,需新增字段(本 plan 不做)。
- ⚠️ **stdio transport `EXTERNAL_CALLER_SENTINEL` 固定字面量**: write tools(spawn / send / shutdown / archive_plan / hand_off / enter_worktree / exit_worktree / shutdown_baton_teammates)走 deny-external 拒绝,read tools(list_sessions / get_session / task_*)允许 — 此现状不受反向 rename 影响。

## D7 验证标注 (回写 plan)

`*待 spike 验证*` → `*已 spike 3.1-3.9: wire prefix [sid] 100% 写 sessions.id;mcp-session-token-map 用 sessions.id 做 key;findSharedActiveTeams / agent_deck_messages 等子表全部存 sessions.id;反向 rename 后 6 处 updateCliSessionId 路径不触发 token map / wire prefix / 子表 rename*`
