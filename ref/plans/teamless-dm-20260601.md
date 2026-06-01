---
plan_id: "teamless-dm-20260601"
created_at: "2026-06-01T13:15:14Z"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/teamless-dm-20260601"
status: "completed"
base_commit: "6084f7d9d99d0fc9afa18752a7d97a438e4f3c56"
base_branch: "main"
final_commit: "3a18030512ef4774879b2f020ccb78a460e475bf"
completed_at: "2026-06-01"
---
# Teamless DM — 解除 send_message 的 shared-team 限制

## 总目标

让任意两个 Agent Deck session **无需共享 active team** 也能互发消息（用户原话：「会话之间可以任意发送消息」）。

落地方式（RFC 已与用户对齐）：
- **team_id 可空（真 DM）** — 加 migration 让 `agent_deck_messages.team_id` 可 NULL，无 team 时消息以 `team_id=NULL` 落库 + 投递，而不是临时造隐式 team。
- **无 team 时 fallback** — 有 shared active team 时**完全走原 team 路径**（reviewer pair / hand-off / wire-prefix reply chain 零改动），仅在「无 shared team」时降级到 teamless DM。
- **限流按 sender session** — teamless 消息限流桶 key 从 `teamId` 换成 `from:<sessionId>`，每个发送方独立 60/min 防失控。
- **不加新 UI** — teamless DM 仍入 messages 表（留痕）+ 正常注入 receiver SDK conversation（receiver 看得到），只是不进 TeamDetail 聚合面板。

## 不变量（不可破坏）

1. **有 shared team 时行为 byte-identical**：现有 reviewer pair / hand-off / multi-team disambiguation / wire-prefix reply chain 全部走原路径，零行为变化。teamless 只是 `findSharedActiveTeams` 返空时的新分支。
2. **reply chain 不得在 migration 中丢失**：spike 已证朴素重建会静默 null 掉 `reply_to_message_id`（见 §设计决策 D1）。migration 必须用 rename-old-first，且 vitest 真测断言 reply chain 保留。
3. **self-message 仍禁**：`from === to` 永远 reject（teamless 不放宽）。
4. **closed / archived receiver + archived caller 仍 reject**：teamless 不绕过 lifecycle 检查。**注意**（codex-2）：现有 `send.ts` **不显式查 `archivedAt`**——archived 过滤完全由 `findSharedActiveTeams` 的 `t.archived_at IS NULL AND sa/sb.archived_at IS NULL` 承担。teamless fallback 绕过 `findSharedActiveTeams` 后，**必须在 send.ts 显式补 caller/target 的 archived reject**（D4 已加），否则 archived 双方可入队再被 watcher 异步 markFailed（误导 caller 拿到 queued ok）。
5. **限流不可移除**：teamless 必须有限流（防失控消息循环烧 token）。只是 key 换 sender。
6. **external caller 仍 deny**：`send_message` 的 `EXTERNAL_CALLER_ALLOWED=false` 不变；teamless 不给 stdio external 开口子。
7. **测试：精确反转 1 处 send_message gate，禁止反转 hand-off 保护断言**（claude-1 修正——原"51 处"数字错误，实际 `no-shared-team` 测试仅 6 处命中 3 文件）：
   - **唯一需反转**：`tools.test.ts:1319` `expect(parsed.data.error).toMatch(/no-shared-team/)` —— 这是真正的 send_message gate reject 断言，改为 teamless 投递 happy-path。
   - **禁止反转**（hand-off 语义保护断言，反转会引入 regression）：`hand-off-session.adopt-teammates.test.ts`（adopt/archived-team 场景验证「新 session 不会发已归档 teammate」的 silent-bug 防御）+ `hand-off-session.handler-deny-happy.test.ts:511`（REVIEW_37「baton 接管 lead 不丢」regression 防护）。这些断言验证的是 hand-off 后**确实失去 shared team**，与 teamless 能力正交。
   - 不得削弱 self / closed / archived / external 断言。
8. **IPC team send 路径不变**：`AgentDeckTeamSendMessage`（TeamDetail UI 手动发消息）仍强制 team-scoped（它本来就是「在某 team 内发」语义）。teamless 只开放给 **MCP send_message**。
9. **teamless 故意移除 peer-ACL**（claude INFO-1 记录）：shared-team 原本是「A 能否给 B 发」的唯一 ACL；teamless 后授权面 = 任意 in-process session 互发（self / closed / archived / external / rate-limit 全保留，external 仍 deny）。这是 RFC 批准的功能（用户原话「会话之间可以任意发送消息」），非缺陷——记此条让未来 review 知道是 deliberate。

## 设计决策（不再争论）

### D1 — migration 用 rename-old-first（spike 实证：朴素重建静默损坏 reply chain）
*已 spike：见 `<plan-artifact-dir>/spike-reports/spike1-migration-self-ref-fk.md`*

`agent_deck_messages` 自引用 FK（`reply_to_message_id → agent_deck_messages(id) ON DELETE SET NULL`）。SQLite 不支持 `ALTER COLUMN` → 必须整表重建。**v017-style `_new` + `DROP old` 会静默 null 掉所有 reply_to**（`DROP old` 的隐式 DELETE 触发 `_new` 自引用 FK 的 `SET NULL`）。`PRAGMA defer_foreign_keys` 不救（只推迟检查不推迟 cascade 动作）。

**正确手法（实证 PASS）**：
```sql
PRAGMA defer_foreign_keys=ON;                          -- 防御性（spike 证非必需但零成本）
ALTER TABLE agent_deck_messages RENAME TO agent_deck_messages_old;
CREATE TABLE agent_deck_messages ( ... team_id 去 NOT NULL ... );   -- 用最终名建，自引用 FK 指向自己
INSERT INTO agent_deck_messages SELECT <13 列显式列出> FROM agent_deck_messages_old;
DROP TABLE agent_deck_messages_old;                    -- 无人引用 _old → 零 cascade
-- 重建全部 5 个 index（v010 的 4 个 + v015 的 reply_to 部分索引）
```
v017 没踩此坑是因为 member 表无人引用；messages 表引用自己是质的区别。

### D2 — teamId 全链路 `string → string | null`
DB 列可空后，类型链同步：
- `MessageRow.team_id`（`_deps.ts`）、`AgentDeckMessage.teamId`（`agent-deck-team.ts`）、`InsertMessageInput.teamId`、`EnqueueMessageInput.teamId` → `string | null`
- `SendMessageResult.teamId`（已是 `string | null`，无需改）
- **两个 event 的 teamId 改法不同**（claude-2 指出）：
  - `agent-deck-message-status-changed` → 走 `AgentDeckMessageStatusChangedEvent` interface（在 `agent-deck-team.ts`，上面已覆盖）
  - `agent-deck-message-enqueued` → 是 **`event-bus.ts:98` 的 inline 字面类型** `{ id: string; teamId: string; ... }`，必须**在 event-bus.ts 就地**改 `teamId: string | null`（不在 agent-deck-team.ts）。enqueue.ts:82 teamless 时 emit `teamId: null` 会直接撞这个 inline 类型 → `pnpm typecheck`（Step 9）挂。
- **preload 回调类型**（claude LOW / codex-4）：`preload/api/teams.ts:126,129` `onAgentDeckMessageChanged` 回调 payload 内联声明 `teamId: string`（两处：cb 签名 + subscribe 泛型），必须改 `string | null`。
- `messageChangedSender`（bootstrap-wiring.ts:166-171）的 routing key 容忍 null（dedup key `${kind}:${messageId}` 不含 teamId，无需改 key 本身；但传入对象 `teamId: p.teamId` 类型需容忍 null）。

### D3 — 限流 key：team 走 `teamId`，teamless 走 `from:<sessionId>`
`enqueueAgentDeckMessage` 内：`const rateKey = input.teamId ?? ('from:' + input.fromSessionId)`。`from:` 前缀防与真实 teamId（UUID `[0-9a-f-]{36}`，不含 `:`）撞 key。
- team 模式：per-team 60/min（多 team 各独立桶，语义不变）。
- teamless 模式：**per-sender 全局 60/min**——同一 sender 给 N 个不同 receiver 各发，**共享单桶最多 60/min**（不是 60×N）。这是**故意的 sender-level 成本阀**（claude LOW-2 确认合理，正是 RFC 选的「限流按 sender」语义），与 team 模式 per-team 桶不对称但都满足 §不变量 5。

### D4 — send.ts：no-shared-team 不再 reject，降级 teamless（分支顺序修正）
**分支顺序必须先处理显式 teamId，再 fallback**（codex-3 修正——原顺序会把「传了错 teamId」静默降级成 DM）：
```
sharedTeams = findSharedActiveTeams(caller, target)
if args.teamId:                                    # 显式 scope 优先校验
    if args.teamId ∉ sharedTeams → err('team-not-shared')   # typo/stale/越权 teamId 必须 reject，不降级
    else teamId = args.teamId
elif sharedTeams.length === 1:  teamId = sharedTeams[0]
elif sharedTeams.length >= 2:   err('ambiguous-team')        # 多 team 仍要 disambiguate
else (length === 0):            teamId = null               # 仅「没传 teamId 且无 shared team」才 teamless
```
**前置检查补强**（codex-2）：teamless 分支（teamId=null）走之前，因绕过了 `findSharedActiveTeams` 的 archived 过滤，必须显式反查并 reject：caller row 不存在 / caller `archivedAt != null` / target `archivedAt != null`（target 存在 / not closed / self 检查已在 handler 开头，顺序不变）。team 分支不需要（`findSharedActiveTeams` 已过滤 archived）。

**replyToMessageId 校验**（codex-1 HIGH + claude LOW-1）：
- team 模式：保持现有 `original.teamId !== teamId` reject（`!==` 在 team↔teamless 边界天然对称，claude LOW-1 验证：teamless reply 挂 team chain `'t1' !== null` reject ✅，反向 `null !== 't1'` reject ✅）。
- **teamless 模式必须额外做 pair-scoped 校验**（codex-1）：`original.teamId !== null` 单独不够——所有 teamless 消息 teamId 都是 `null`，`null !== null` 为 false 会让**任意** teamless reply 通过，持有任意 teamless messageId 的 caller 能把消息挂到无关 DM chain 污染 reply graph。修法：teamless reply 要求 `original.teamId === null` **且** `{original.fromSessionId, original.toSessionId} === {callerSid, targetSid}`（同一对 session 的往返）。`_deps.ts` MessageRow 已有 from/to 字段可直接 pair check。
  - 严重度：codex 标 HIGH；lead 裁决在单人本地模型下 reply chain 是元数据（target 本身已独立校验，不影响投递安全），定 **MED**，但修法采纳（防 reply graph 污染 + 防未来多用户场景）。

### D5 — watcher dispatchClaimed：teamless 跳过 4 项 team invariant，保留 session 校验
`claimed.teamId === null` 时：跳过 `team not found` / `team archived` / `from no longer active member` / `to no longer active member` 4 项 team 校验；**保留** target 存在 / target not closed / target not archived / from 存在 / from not archived / adapter 支持 receiveTeammateMessage。即 team 相关闸门按 teamless 短路，session 相关闸门照旧。（claude INFO-1 确认划分正确：membership 是 peer-ACL，已由 RFC 放弃；session 校验是投递安全，必须留。）

### D6 — buildWireBody：teamless 时 displayName 回退 session 标题
`resolveFromDisplayName(fromSessionId, teamId)` 当 teamId=null 时不查 team membership，直接走 fallback：`session.title ?? '<adapterId>:<sid 前 8>'`。wire prefix `[from <name> @ <adapter>][msg <id>][sid <sid>]` 结构不变（receiver 的 regex 提取逻辑零改动）。
**签名改动**（claude-3 typecheck blocker）：`resolveFromDisplayName` 形参 `teamId: string` → `string | null`；函数体内用 `if (teamId !== null) { ...findActiveMembershipIn(teamId, ...)... }` 包住 membership 查询，null 时直接落 fallback。`session.title` 字段已验存在（`src/shared/types/session.ts:30 title: string`），fallback 链可行。

### D7 — IPC `AgentDeckTeamSendMessage` 保持 team-only（不放宽）
TeamDetail UI 的「在 team 内发消息」语义本就 team-scoped，不改。teamless 能力只通过 MCP `send_message` 暴露（§不变量 8）。

### D8 — tool description / schema 文本同步更新
- `send_message` 的 schema `teamId` 字段 description（schemas.ts:189-190「Reject when sharing zero teams」）→ 改为「无 shared team 时以 teamless DM 投递；多 team 时仍需 teamId 去重」。
- `send_message` 的 `index.ts` 注册描述同步。
- **`spawn_session.teamName` 的 stale 文案**（codex-4 / claude LOW）：schemas.ts:77「Omit = standalone session (no team — **caller cannot send_message it**)」teamless 后变反向误导，改为「Omit = standalone session（无 team；仍可通过 teamless DM 互发，只是不进 team 聚合面板）」。
- CLAUDE.md / CODEX_AGENTS.md 的 `no-shared-team` 段落同步（§Step 7 文档更新）。

## 受影响文件清单（blast radius，已勘查）

| 层 | 文件 | 改动 |
|---|---|---|
| migration | `src/main/store/migrations/v027_*.sql`（新建）| rename-old-first 重建（D1）|
| migration reg | `src/main/store/migrations/index.ts` | 注册 v027 |
| repo crud | `agent-deck-message-repo/crud.ts` + `_deps.ts` | `teamId` 可空（D2）|
| 类型 | `src/shared/types/agent-deck-team.ts` | `AgentDeckMessage.teamId` + StatusChangedEvent（D2）|
| enqueue | `universal-message-watcher/enqueue.ts` | rateKey 分流（D3）+ teamId 可空 |
| send 网关 | `agent-deck-mcp/tools/handlers/send.ts` | teamless 分支（D4）|
| watcher | `universal-message-watcher/index.ts` | dispatchClaimed teamless 短路（D5）+ buildWireBody（D6）|
| event-bus | `src/main/event-bus.ts` | **`message-enqueued` 是 L98 inline 字面类型**，就地改 `teamId: string \| null`（不在 agent-deck-team.ts；D2 claude-2）|
| wiring | `src/main/index/bootstrap-wiring.ts` | messageChangedSender 传入对象 `teamId` 容忍 null（D2）|
| preload | `src/preload/api/teams.ts` | `onAgentDeckMessageChanged` 回调 payload `teamId: string` → `string \| null`（L126 cb 签名 + L129 subscribe 泛型；D2 claude-LOW / codex-4）|
| schema | `agent-deck-mcp/tools/schemas.ts` | send_message `teamId` description（D8）+ **`spawn_session.teamName` L77 stale 文案**（D8 codex-4）；`SendMessageResult.teamId` 已可空 |
| tool reg | `agent-deck-mcp/tools/index.ts` | send_message 注册描述（D8）|
| 文档 | `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` | no-shared-team 段（D8）|
| 测试 | `agent-deck-mcp/__tests__/tools.test.ts`（反转 1 处 gate + 加 teamless case）+ `teams/__tests__/universal-message-watcher.test.ts`（watcher teamless 短路）+ migration reply-chain 真测 | §不变量 7 精确清单 |

**不改**：IPC `AgentDeckTeamSendMessage`（D7）、rate-limiter class 本身（key 是 caller 传入的 string，无需改）、renderer TeamDetail（teamless 不进面板）、wire-prefix regex。

## 步骤 checklist

- [ ] Step 1 — 写 v027 migration（rename-old-first，13 列显式 + **byte-level 照搬全部 CHECK/DEFAULT/NOT NULL 子句，仅 team_id 去 NOT NULL** + 5 index 重建）+ 注册 index.ts
- [ ] Step 2 — repo / 类型链 teamId `string | null`（crud.ts / _deps.ts / agent-deck-team.ts / **event-bus.ts L98 inline** / **preload/api/teams.ts L126,129**）
- [ ] Step 3 — enqueue.ts rateKey 分流（teamId ?? `from:<sid>`）
- [ ] Step 4 — send.ts：分支顺序 = 显式 teamId 优先校验 → 单 team → 多 team err → teamless fallback（codex-3）；teamless 前置补 caller/target archived reject（codex-2）；teamless reply pair-scoped 校验（codex-1）
- [ ] Step 5 — watcher dispatchClaimed teamless 短路 4 项 team 校验保留 session 校验 + buildWireBody/resolveFromDisplayName 签名 `teamId: string|null` + null 短路（D5/D6）
- [ ] Step 6 — bootstrap-wiring messageChangedSender 传入 teamId 容忍 null
- [ ] Step 7 — 文档/文案：send_message schema+index 描述 + spawn_session.teamName stale 文案（codex-4）+ CLAUDE.md/CODEX_AGENTS.md no-shared-team 段
- [ ] Step 8 — 测试（§不变量 7 精确清单）：① `tools.test.ts:1319` 唯一 gate 反转为 teamless happy-path ② **不动** hand-off 5 处保护断言 ③ 新增 teamless reply pair-scoped reject + team↔teamless 双向 reject case ④ teamless 前置 archived reject case ⑤ migration reply-chain 保留真测（skip-guard 模式）⑥ explicit-wrong-teamId 仍 reject 的 negative test（codex-3）⑦ **D5 watcher teamless dispatch 回归真测**（codex R2）：`universal-message-watcher.test.ts` 加 `claimed.teamId=null` case — 断言 `agentDeckTeamRepo.get` / `findActiveMembershipIn` **不被调用**（mock 验证）、target/from session 校验保留、`adapter.receiveTeammateMessage` 被调用且 `markDelivered`；保留现有 target/from archived 的 post-claim fail 测试。⚠️ 仅靠 ① 的 `queued:true` happy-path 不够——D5 漏实现时 tools.test 仍 PASS 但消息会在 watcher 异步 failed。⑧ **D3 rateKey 分流真测**（claude R2 LOW-R2-1）：`enqueue.test.ts`（已有 `messageRateLimiter` token-state + `bucketCount` 基建）加 teamless case — 断言 `teamId=null` 时桶 key = `from:<sid>`（两个不同 sender 各独立 60/min 桶不互耗 + 同 sender 跨多 receiver 共享单桶达 60 后 reject）。这是 §不变量 5 在 teamless 下唯一回归防线，漏写则 rateKey 写错（漏 `from:` 前缀 / `??` 优先级 bug）无测试可抓。
- [ ] Step 9 — `pnpm typecheck` + `pnpm build`；改 main 必重启 dev 实测两无 team session teamless 互发
- [ ] Step 10 — changelog + README（若改用户可见行为）

## 当前进度

Step 0（RFC）+ Step 0.5（spike）+ **Step 1.5 Deep-Review 收口完成**（R1 + R2，双 reviewer 共识「R2 可合」/ 0 HIGH / 0 MED 存活）。spike 抓到并修复 reply-chain 静默损坏 bug；R1 挖出 6 条 plan 精度问题 + R2 补 2 条测试矩阵缺口，全 fix。**plan 已可进 worktree 实施（待 user confirm，§Step 2）。**

## 下一会话第一步

若本会话未继续：先 `Bash: cat <plan-abs-path>` 全文 → 按 §步骤 checklist Step 1 开始，先读 `src/main/store/migrations/v017_agent_deck_team_members_cascade.sql`（rebuild 模板）+ spike report 的最终骨架 → 写 v027。**所有代码路径进 worktree 前缀**。

## 已知踩坑

- migration **必须**显式列出 13 列（不能 `SELECT *`，列序变化会错位）。列序见 crud.ts:50-54 INSERT 顺序。
- migration CREATE TABLE **必须 byte-level 照搬 v010 的全部 CHECK/DEFAULT/NOT NULL 子句**（`body CHECK(length<=102400)` / `status DEFAULT 'pending' CHECK(status IN(...))` / `attempt_count DEFAULT 0` 等），**仅 team_id 去 NOT NULL**——只抄列名会静默丢约束（migration 不报错但 DB 完整性降级，claude LOW-3）。
- vitest SQLite 真测受 CLAUDE.md ABI 守门：走 task-repo.test.ts 顶部 binding 自检 skip 模式，别裸跑触发 prebuild-install 污染 Electron binding。spike 已实证 sqlite3 3.43.2 CLI 与目标行为一致（rename-old-first / 5 invariant 全 PASS，claude 用同版本独立复现一致）。
- `from:` rateKey 前缀必须保留（防与 UUID teamId 撞桶；UUID charset `[0-9a-f-]` 不含 `:`，前缀安全）。
- teamless reply 校验「`original.teamId === null`」**单独不充分**——必须叠加 from/to pair check（codex-1），否则任意 teamless messageId 可挂任意 DM chain。
- send.ts 分支顺序：**显式 teamId 校验必须在 teamless fallback 之前**（codex-3），否则传错 teamId 被静默降级成 DM。

## Deep-review 收口记录（Step 1.5）

**R1** 异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，互盲）：
- **0 HIGH 存活**（codex 提的 teamless-reply HIGH 经 lead 裁决在单人模型下定 MED，修法已采纳；R2 codex+claude 均同意降级）
- 6 条真问题全采纳：codex-1（reply pair-scope）/ codex-2（archived 前置）/ codex-3（分支顺序）/ claude-1（测试矩阵 51→精确清单）/ claude-2（event-bus inline 类型）/ claude-3（resolveFromDisplayName 签名）+ LOW（preload 类型 / spawn 文案）
- **migration 设计（D1）双方独立实测确认铁的**（claude 用 sqlite3 3.43.2 复现 CASE-A 损坏 + FIX-3 保留 + 5 invariant，与 spike 一致；codex 确认 schema 13 列 + 5 index 对齐）

**R2** 确认轮（复用同一对 reviewer）：
- 双方明示 **「R2 可合」/ 0 HIGH / 0 MED 存活**
- D4 三处叠加（分支顺序 + archived 前置 + reply pair-scope）经双方验证自洽无新漏洞；claude 实测 `findSharedActiveTeams` 确认 archived 前置必要性（否则 archived 双方静默降级 teamless 绕过不变量 4）
- 补 2 条测试矩阵缺口（均已 fix）：codex R2 MED（D5 watcher teamless dispatch 真测 → Step 8 ⑦）+ claude R2 LOW（D3 rateKey 分流真测 → Step 8 ⑧）
- claude R2 INFO 确认 renderer 整体重拉不解析 payload.teamId → null 不会炸 IPC→renderer 链路（无 action）

**结论**：全部为 plan 文档/测试精度问题，**0 设计缺陷**；migration 关键风险 spike 已拆除。plan 可进 worktree 实施。
