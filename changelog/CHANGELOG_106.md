# CHANGELOG_106

## 概要

baton 收口 + cwd 失效 UX 双修(同会话两件事打包)：

- **A. baton teammate shutdown**(主体)：`archive_plan` / `hand_off_session` 默认 shutdown caller 是 lead 的 team 内其他 active teammate(避免孤儿——team 里没 lead 后 reviewer-claude / reviewer-codex 等 teammate 仍跑、占内存 + SDK live query,用户得手动一个个 shutdown_session)。新增 `keep_teammates: boolean` schema 字段允许跳过(典型:lead 想保留 reviewer 给后续会话继续用 / 显式传 `team_name` 让新 session 接管 lead)。失败容错三层:helper 内单个 close 抛错收 `failed[]` 继续后面;helper 自身炸 handler 兜底 `skipped=null` warn 不阻塞;`archive` caller 仍走(plan 收口 / baton 出手已成功不该被 helper 故障带崩)。
- **B. jsonl missing emit 修复**(bug fix)：用户报「会话 resume 后丢了历史上下文」(实测消息「你是不是没有历史会话信息了，这里是」)的根因 — `recoverer.ts` jsonl missing fallback 路径**只 console.warn 不 emit UI 提示**,与对称的 cwdFellBack=true 路径(已 emit 信息)实现不一致。dormant session 唤醒 + jsonl 缺(典型:用户清 `~/.claude/projects` / 跨设备同步漏 / CLI 自身清理 / 应用重装)→ 走 fresh CLI 但**用户完全不知道**,Claude 答非所问 → 用户问「你是不是没有历史会话信息了」。补一条同款 emit info message 告诉用户「CLI 内部对话历史已丢失,Claude 这条新启动的 CLI 不知前情,如要继续之前话题请在下条消息把背景再告诉它一次」。

## 变更内容

### A. baton teammate shutdown

#### 新文件 `src/main/agent-deck-mcp/tools/handlers/shutdown-teammates-on-baton.ts`(106 LOC)

`shutdownTeammatesOnBaton(callerSessionId, deps?)` helper:
- 反查 caller 在哪些 team 是 lead(`findActiveMembershipsBySession`)
- 收集所有 caller=lead 的 team 内其他 active member sid(Set dedup 跨 team 共享同 sid)
- 串行 `sessionManager.close(sid)` 每个 teammate(close 内部已自动 leaveTeamsAndAutoArchive + abort SDK live query + setLifecycle='closed',helper 不重复实现)
- 返回 `{ closed: string[], failed: Array<{sessionId, reason}>, skipped: 'caller-not-lead' | null }`(`'keep-teammates'` 由 handler 层填,helper 不懂 schema 字段)
- 三 deps inject seam(closeFn / findActiveMembershipsBySession / listActiveMembers),让单测无需真碰 sessionManager / agentDeckTeamRepo
- 失败容错:单个 close 抛错 → failed[] + warn + 继续(不一刀切);helper 自身炸由 caller 端 try/catch 包

#### `src/main/agent-deck-mcp/tools/schemas.ts`(+14 行)

`ARCHIVE_PLAN_SCHEMA` / `HAND_OFF_SESSION_SCHEMA` 各加 `keep_teammates: z.boolean().optional()`,描述含触发条件(default false = shutdown teammate)+ 返回字段说明。

#### `src/main/agent-deck-mcp/tools/handlers/archive-plan.ts`(+50 行)

- `ArchivePlanHandlerDeps` 加 `shutdownTeammates?` test seam(默认走真 helper)
- impl 成功后、archive caller 之前插入 helper 调用块(三态决策:`keep_teammates` / external sentinel / 正常)
- ok return 加 `teammatesShutdown: { closed, failed, skipped }` 字段
- **时序约束**(注释里讲清):必须先 helper 后 archive caller 否则 archiveTeamsIfOrphaned 会先把 team auto-archive,helper 反查时 listActiveMembers(JOIN sessions archived_at IS NULL)看不到 caller

#### `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts`(+37 行)

同 archive-plan 同款集成模式,helper 调用块插在 spawn ok parse 之后、archive caller 之前。

### B. jsonl missing emit 修复(recoverer)

`src/main/adapters/claude-code/sdk-bridge/recoverer.ts:282-302`(+22 行 emit + jsdoc):

`if (!cwdFellBack)` 分支补 `this.ctx.emit({ kind:'message', payload:{text:'⚠ 此会话的 CLI 内部对话历史(jsonl)已丢失... Claude 这条新启动的 CLI 不知前情。如要继续之前话题,请在下条消息里把背景再告诉它一次。'} })`。info 性质(不打 error)与 cwdFellBack 路径(L161-194 已 emit 同款警告 `⚠ ...CLI 内部对话历史(jsonl)将丢失`)对称化 — 文案区分「**已**丢失」(jsonl missing 路径)vs「**将**丢失」(cwdFellBack 路径),test filter 精确锚定不互相干扰。

## 测试

新增 17 case + 6 个原 case 注入 noopShutdown 防默认 helper 撞 DB 未 init 噪音。

| 文件 | 范围 | case 数 |
|---|---|---|
| `__tests__/shutdown-teammates-on-baton.test.ts`(新文件) | helper 自身 6 case:单 team lead / caller-not-lead / 多 team dedup / 单个 close 失败容错 / external sentinel 防御性早 return / caller=lead 但 team 内只有 caller | 6 |
| `__tests__/archive-plan.handler.test.ts`(末尾新 describe) | handler 集成 5 case:happy / keep_teammates=true / caller-not-lead / helper 抛错 / impl 失败短路 | 5 |
| `__tests__/hand-off-session.handler-deny-happy.test.ts`(末尾新 describe) | handler 集成 5 case:同款 5 case 但 spawn 失败短路替代 impl 失败 | 5 |
| `adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts`(jsonl missing case 加断言) | bug fix 验证:emit info text/error 性质/文案关键词 | 1(原 case 加 4 行 expect) |

- typecheck:0 errors(双端 `tsc --noEmit`)
- vitest:全过 — `src/main/agent-deck-mcp/__tests__/`(10 文件)+ `sdk-bridge.recovery.test.ts` = 148/148 case
- noopShutdown 注入:archive-plan 4 处 + hand-off-session 6 处 default 调用点(原 CHANGELOG_99 / 97 / 98 case 范围与 teammate shutdown 无关,但 handler 集成 helper 后 default 走真 helper 会调 agentDeckTeamRepo 撞 DB → 注入 noop 让 stderr 干净)

## 已知踩坑

- helper 时序选「先 close teammate 后 archive caller」**不可颠倒**:archive caller 先做会触发 `archiveTeamsIfOrphaned` → team auto-archive → helper 反查时 `listActiveMembers`(JOIN sessions `archived_at IS NULL` 过滤)看不到 caller(但 caller 没 archive 之前的 lead 反查仍命中 — `findActiveMembershipsBySession` 不过滤 archived) → 行为可能 OK 但语义混乱
- caller 显式传 `team_name` 让新 session 接管 lead 角色时,**应**显式传 `keep_teammates: true`,否则原 reviewer 被关掉新 session 没人对话
- jsonl missing emit 文案选「**已**丢失」与 cwdFellBack 路径「**将**丢失」差一个字 — test filter `includes('CLI 内部对话历史(jsonl)已丢失')` 精确命中本路径不撞 cwdFellBack 路径同款断言
- 原 `archive-plan.handler.test.ts` 4 处 + `hand-off-session.handler-deny-happy.test.ts` 6 处 default 调用点必须**主动注入 `shutdownTeammates: noopShutdown`** — 否则集成后跑测试 stderr 一片 `Database not initialized` 警告(handler 兜底接住不影响 pass,但噪音影响 review)
</content>
</invoke>