---
review_id: 17
reviewed_at: 2026-05-01
expired: false
skipped_expired:
---

# REVIEW_17: Agent Teams + SDK Task Manager + Inbox Watcher 三大新模块全审（多轮异构对抗）

## 触发场景

最近三个 feat commit（`a81ccd9` Sandbox 三档 + Agent Teams M1-M3 + plugin agents 注入；`4d9f40b` SDK Task Manager + deep-code-review skill 改 teammate；`6643c82` Inbox watcher 通路 + 团队名 fs SSOT + 活动流工具行 + fs symlink fix）合计 **+8980 行 / 81 文件**。前置 REVIEW_15 仅审 sandbox / REVIEW_16 仅审 fs watcher symlink path mismatch 单点，三大新模块（teams / task-manager / 部分 inbox-watcher 完整数据流 + TeamHub/TeamDetail UI）**首次完整 review**。

用户主动 `/agent-deck:deep-code-review` 跑 deep-code-review skill。

## 方法

**双对抗 teammate 模式**（agent-deck-plugin 默认主路径）：lead 在同一 team 起两个 teammate，跨 3 轮 sendMessage 复用 mental model：

- `reviewer-claude`（agent-deck:reviewer-claude，Opus 4.7）
- `reviewer-codex`（agent-deck:reviewer-codex wrapper，外部 codex CLI gpt-5.5 xhigh，必须 `run_in_background: true`）

**3 轮 + 2 反驳轮** focus 切片：

| 轮 | focus | 关键 finding |
|---|---|---|
| Round 1 | 修复正确性 / 是否引新问题 / 测试质量 / 接口边界 / 数据库迁移 | 1 HIGH（cascade 跨 team 删除） + 5 MED + 6 LOW |
| Round 2 | 资源 lifecycle / cleanup / race / 边界 / 测试 / CLAUDE.md 约定不变量 | 1 HIGH（recoverAndSend toExists=true team_name 丢失） + 4 MED + 1 LOW |
| Round 3 | 架构耦合 / 安全 / 性能尾延迟 / 未来扩展性 | 1 HIGH→MED（appendInboxMessage 不走 ensureWithinRoot，codex 反驳后降 MED） + 3 MED + 4 LOW + 1 INFO |

**反驳轮**：
- R1 H2（claude HIGH listSeenRequestIds 三方语义反）→ codex 同意 finding 但建议降 MED（preload 未暴露当前零影响）
- R3 H1-R3（claude HIGH appendInboxMessage 不走 ensureWithinRoot）→ codex POSIX rename 实测证伪 claude 主攻击路径，writeFile dangling symlink 路径成立 + 威胁模型同用户权限不算提权 → 降 MED + 同意 convention 不对称值得修

**用户实时反馈**：R2 sendMessage 后用户报「PendingTab 没收到审批请求」—— lead 现场 SQL 实证 events 表已写入 R2 两条 team-permission-request（main 通路 OK），用户后续确认实际是切到了别的 view 没注意；同时该 finding 揭示 H2-R2 重启后 in-memory dedup 集合丢失会让旧 permission_request replay UI（已落地 prewarm 修复）。

**范围**：13 个完全新文件 + 8 处 diff 新增段 + 4 个测试文件，约 4500 行核心代码

```text
src/main/teams/{inbox-protocol,inbox-watcher,team-coordinator,team-fs,team-watcher}.ts
src/main/task-manager/{server,tools}.ts
src/main/store/task-repo.ts
src/main/store/migrations/{v006_sessions_team_name,v007_tasks}.sql
src/renderer/components/{TeamDetail,TeamHub}.tsx
src/renderer/components/activity-feed/tool-icons.ts
# diff
src/main/{index,ipc,session/manager}.ts (本批新增段)
src/main/store/{event-repo,session-repo}.ts (本批新增段)
src/main/adapters/claude-code/{sdk-bridge,hook-routes,hook-installer,translate}.ts (本批新增段)
src/preload/index.ts (本批新增段)
src/shared/{ipc-channels,types}.ts (本批新增段)
# tests
src/main/teams/__tests__/{inbox-protocol,team-coordinator}.test.ts
src/main/task-manager/__tests__/tools.test.ts
src/main/store/__tests__/task-repo.test.ts
```

```review-scope
src/main/adapters/claude-code/sdk-bridge.ts
src/main/index.ts
src/main/ipc.ts
src/main/session/manager.ts
src/main/store/__tests__/task-repo.test.ts
src/main/store/migrations/v006_sessions_team_name.sql
src/main/store/migrations/v007_tasks.sql
src/main/store/session-repo.ts
src/main/store/task-repo.ts
src/main/task-manager/__tests__/tools.test.ts
src/main/task-manager/server.ts
src/main/task-manager/tools.ts
src/main/teams/__tests__/inbox-protocol.test.ts
src/main/teams/__tests__/team-coordinator.test.ts
src/main/teams/inbox-protocol.ts
src/main/teams/inbox-watcher.ts
src/main/teams/team-coordinator.ts
src/main/teams/team-fs.ts
src/main/teams/team-watcher.ts
src/renderer/components/TeamDetail.tsx
src/renderer/components/TeamHub.tsx
src/renderer/components/activity-feed/tool-icons.ts
```

> 本份 review 首次加入 git 的 commit 视为这批文件的覆盖基线。File-level Review Expiry 自动按基线计算 churn / commit / 时间。

**约束**：REVIEW_15 sandbox / REVIEW_16 fs watcher symlink fix 已审项不重列；CHANGELOG_45-48 已落地的能力（inbox 协议对齐 / hook PreToolUse 拦 team_name / tool-icons 集中 / sdk-bridge tool-use-end 反查 / Agent Teams systemPrompt 注入 / TeamPermissionCancelled 通路 / TeamPermissionRow 整体可点）不重列。

## 三态裁决结果

> 每条 ✅ 必须带验证手段（grep / 写小 test / 跑 vitest / SQL 实证 / 现场 sendMessage 实测）。本次共 13 ✅ 真问题（含 1 个被 codex 反驳后降级、2 个被反驳证伪降为 ❌）+ 6 ❌ 反驳 + 多个 ❓ 不修。

### ✅ 真问题（按落地 commit 顺序）

| # | 严重度 | 文件:行号 | 问题 | reviewer | 验证手段 |
|---|---|---|---|---|---|
| H1 | HIGH | `tools.ts:269-294` + `task-repo.ts:258-309` | task_delete cascade 跨 team 越权（双方独立提出，claude 攻击路径更深：task_update 也允许 patch.blocks 跨 team；repo.update 也接受 patch.teamName 直改） | claude HIGH + codex MED | grep 已确认 tools.ts 277 行只 check root.teamName，task-repo.ts BFS 无 team filter |
| MED-H2 | HIGH→MED | `inbox-watcher.ts:159-172` + `ipc.ts:849-858` | listSeenRequestIds JSDoc 说返回空但实际返回累加集合（含 idle:* 去重键），IPC TeamListPendingPermissions 绑过来「pending vs seen」语义反 | claude HIGH（codex 反驳轮同意 + 降 MED：preload 未暴露当前零影响 + 补充新发现 idle:* 脏键） | grep 三处用法 + reviewer-codex.test.ts 完全无覆盖 |
| M3 | MED | `TeamDetail.tsx:46-74` | useEffect deps 含 snap → refresh 改 snap → effect 重跑 → 反复 sub/unsub IPC + onAgentEvent listener 重 register（每 inbox 写入翻一次） | claude（lead grep 实证 deps 数组确认） | 直接读 deps 第 74 行 |
| M5 | MED | `team-coordinator.test.ts:32-36` | mock setTeamName 直改 map.get 返回的同一对象引用 → sync() 内部 console.log 拿到的「旧值」实际已被改成新值 → 未来加 idempotent guard 测试无法挂回归 | claude（lead 跑 vitest 实测 console=was: team-X 而非 was: null） | `pnpm exec vitest run team-coordinator.test.ts` 现场观察 console output |
| M6 | MED | `ipc.ts:719-731` + `index.ts:160-170` | force-cleanup IPC handler 主动 clearTeamName + emit，又被 chokidar unlinkDir 触发兜底 clearTeamName 第二次 SELECT/UPDATE（无 bug 但浪费） | claude（lead grep 两处实证） | grep `clearTeamName` 出 2 处用法 |
| M7 | MED | `tools.test.ts:130-191` | 测试 helper 包了一层 fixed teamName 工厂，没测 lazy provider 改变（CHANGELOG_46 改 lazy 的核心 gain） | claude（lead grep buildToolsAsDict 实证） | 读 helper 第 94-99 行 |
| M4 | LOW | `sdk-bridge.ts:594-595` | 注释「CHANGELOG_45 后续：teamName 非空时拼一行 per-session 元信息」实际未实现，CHANGELOG_46 已撤回此方向 | claude（lead grep sdk-injection.ts:100 函数无 teamName 参数） | grep `getAgentDeckSystemPromptAppend` |
| L8 | LOW | `TeamHub.tsx:13-14` | 注释「5s polling 兜底 + 监听 session-* IPC 事件」实际只有 setInterval，无 listener | claude（lead grep 实证） | grep `onSessionUpserted\|setInterval` |
| L10 | LOW | `tool-icons.ts:21-55` | 不映射 mcp__tasks__*（agent-deck 自带 task-manager MCP 5 个工具），全部回落 🔧 | claude（lead grep 0 匹配） | `grep 'mcp__tasks__'` |
| LOW-1 | LOW | `team-coordinator.test.ts:65` | `vi.mock('./team-fs', ...)` 路径相对 __tests__/ 解析到不存在的 __tests__/team-fs，被测代码 import './team-fs' 解析到 teams/team-fs.ts → mock 实际是空操作 | codex（lead 文件存在性验证） | `ls __tests__/team-fs.ts` 不存在 |
| LOW-2 | LOW | `inbox-protocol.test.ts:47-95` | 完全无 idle_notification 解析 case（CHANGELOG_48 加的 schema），未来漂移无回归保护 | codex（lead grep 0 匹配） | `grep idle_notification` |
| H1-R2 | HIGH | `session-repo.ts:227-266` + `sdk-bridge.ts:889-940` | recoverAndSend jsonl-missing 走「不带 resume 的 createSession + 事后 renameSdkSession」，sessionRepo.rename toExists=true 分支仅 UPDATE 子表 + DELETE OLD → team_name / permission_mode 永久丢失 → TeamHub 卡片消失 → refreshAutoSubscribe 取消订阅 → teammate permission_request 全丢；违反 CLAUDE.md「resume 优先」会话身份持续性约束 | claude HIGH（codex 反驳验 toExists=false 路径保留但**漏验 toExists=true 分支**） | 读 session-repo.ts:233 `if (!toExists)` 分支与 260-263 行 toExists=true 分支 |
| H2-R2 | MED | `inbox-watcher.ts:90-104, 200-228` | 进程重启后 chokidar `ignoreInitial:false` replay lead inbox + seenRequestIds in-memory 全丢 → 已 approve/deny 的旧 permission_request 重新弹 PendingTab；用户再 approve 写第二条 response 到死 teammate 的 inbox（污染） | claude HIGH（codex 同款 LOW-R2-3 标 trade-off + claude 提 ABC 修复方案）lead 折中 MED + 实施 C+A 方案 | 读 注释自述 + grep `seenRequestIds = new Set()` 无持久化 |
| M1-R2 | MED | `tools.ts:285-298` + `task-repo.ts:280-309` | repo.delete 返回 boolean，cascade 删 N 个 task 时 tools.ts 只 emit 1 条 task-changed (root)；renderer 未来 Tasks tab 拿不到下游 N-1 个 → stale UI（当前零影响 renderer 没消费） | 双方都提 | grep `repo.delete` 与 `eventBus.emit('task-changed')` 数量 |
| MED-R2-1 | MED | `inbox-watcher.ts:207-281` | processInboxFile 两个 for 循环都在 try 外，emit listener 抛错（典型 ingest sessionRepo.upsert SQLite 锁）→ 函数 throw → request_id 已加 seenRequestIds 但未 emit → **永久 stale，UI 永远看不到，teammate 工具一直挂**；只能重启进程恢复 | codex（实证读 207-281 完整函数 + 调用点 fire-and-forget Promise rejection 吞） | 读 processInboxFile 完整函数确认 emit 不在 try 内 |
| M2-R2 | MED | `team-coordinator.ts:205-228` | extractTeamNameFromToolInput 不 trim/validate，lead 调 TeamCreate(name="  team-A  ") 时反向同步写入 DB 是带空白的字符串，inbox-watcher slugify 后路径错位 → permission_request 全丢 | claude（lead grep pickStr 只 length 检查） | grep `extractTeamNameFromToolInput` 与 ipc.ts parseTeamName 对比 |
| L1-R2 | LOW | `inbox-protocol.ts:127-130` | typeof '' === 'string' 通过，空 request_id 进入 dedup → 后续所有 request_id='' 静默跳过 | 双方都提（codex LOW-R2-2 + claude L1-R2） | code review |
| MED-R3 | MED | `inbox-protocol.ts:200-242` | appendInboxMessage 写 inbox 不走 ensureWithinRoot（read/delete 都走，convention 不对称）；claude 提 HIGH attack via rename，codex POSIX 实测证伪 rename 跟随 + writeFile dangling symlink 路径仍真实成立 + 同用户权限不算提权 → 降 MED；违反 CLAUDE.md「资源清理 & TOCTOU 防线」隐含写路径同款约定 | claude HIGH（codex 反驳轮 部分同意 + 降 MED + 给 A 方案修法） | codex 写小测试 POSIX rename 行为 + grep `ensureWithinRoot` 4 处全在 team-fs.ts |
| M1-R3 | MED | `TeamDetail.tsx:331` | SendToTeammate 字符串拼接 `Tell teammate ${target}: ${text}`，text 含 newline / 仿造下一条「Tell teammate evil:」即可让 lead LLM 解析成多条 SendMessage（prompt-injection）；当前手动 UI 风险有限，未来 CLI/API 拼 wrapper 时意外行为概率高 | claude（lead grep 实证） | grep `wrapped\|target.trim` |
| M2-R3 | MED | `inbox-watcher.ts:265-356` | processInboxFile 分两遍 for-of 各跑 N×parseSubMessage（N 几千 entries 时 ~10ms+ 尾延迟）；chokidar awaitWriteFinish 250ms 无法限频 lead 每次写都 fire change | claude（lead grep 两遍 for-of 实证） | 读 282 + 327 行 |
| M3-R3 | MED | `sdk-bridge.ts:835-955` | recoverAndSend 入口无条件 emit 占位 message；首次 inflight 失败 swallow + 第二次 sendMessage 重新进 recoverAndSend → 第二条占位 → 用户在 detail 看到多条同款噪声 | claude（lead grep 实证 880-887 行无 dedup） | 读 845 行 catch swallow + 952 行 finally delete inflight |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据（验证手段 + 结论） |
|---|---|---|
| codex R1 | processConfigFile startsWith 不带分隔符（LOW 候选） | codex 自反驳：自我验证后说 sync 幂等会拦截，降为 LOW，不进真问题区 |
| codex R2 | renameSdkSession 路径下 team_name 丢失 | codex 验 toExists=false 分支保留 team_name；但**漏验 toExists=true 分支** —— 该分支被 claude H1-R2 实证为真 bug，已修 |
| codex R2 | refreshAutoSubscribe 高频风暴 | 实测 advanceState 仅在状态变化时 emit + autoSubscribed Set 防抖 → 不会 watcher 泄漏 ✅ |
| codex R2 | v006 ALTER TABLE 无 IF NOT EXISTS migration 重跑 | migration 系统按 user_version 严格门控，re-run 不可能发生 ✅ |
| codex R2 | parseTeamName trim 不一致 | trim 后值全链路一致 ✅；但 codex 漏验 hook 通道（PreToolUse / fs / hook）三路不 trim → claude M2-R2 实证 |
| codex R3 | XSS 注入路径 | 全 JSX text interpolation，无 dangerouslySetInnerHTML ✅ |
| codex R3 | fromMemberSlug IPC 路径注入 | slug 化 + 正则双重拦截 ✅ |
| codex R3 | task-manager 循环依赖 | 依赖图单向有向 ✅ |
| codex R3 | dedupOrClaim 早返致 PostToolUse 双发 | 早返只针对 team-* 三种 kind，PostToolUse / Stop 仍走 sdkOwned guard ✅ |
| codex R3 | rename 跟随 symlink 写 /etc/passwd（claude H1-R3 攻击主路径） | POSIX rename 实测证伪：rename 替换 symlink 本身不跟随写目标 ❌；但 writeFile dangling symlink 路径成立，convention 不对称仍值得修（H1-R3 降 MED） |

### ❓ 部分 / 未验证（不修，已说明理由）

| 现场 | finding | 是否已验证 | 结论 |
|---|---|---|---|
| `inbox-watcher.ts:241` | idle dedup key 用 ISO timestamp，1ms 内同 teammate 双 idle 罕见 | claude 自标 *未验证* | 不修（CLI lock 串行写入 + 1ms 内罕见） |
| `v006_sessions_team_name.sql:7` | ALTER TABLE 不带 IF NOT EXISTS | claude 实证 | 不修（migration gate user_version 严格） |
| `inbox-protocol.ts:230` | tmp 文件名只用 process.pid | claude *未验证* nitpick | 不修 |
| `sdk-bridge.ts:557-572` | lead 创 team 之前调 task_create 的竞态窗口 | claude *未验证* + skill 模板顺序天然规避 | 不修 |
| `inbox-watcher.ts:84-88` | subscribe mkdir 与 team-fs「不写 ~/.claude/teams/」约定冲突 | codex 实证 | 不修（inbox 子目录与 config / task list 不同语义） |
| `task-repo.ts:212-213` | SQLite LOWER Unicode 不敏感（小语种边角） | codex *未验证* | 不修 |
| `manager.ts:188-198` | dedupOrClaim 早返脆弱耦合（假定 SDK 不 emit team-*） | claude 推理 | 不修（未来 CLI 升级再加 dedup key） |
| `team-fs.ts:122-162` + `ipc.ts:728-735` | listTeams N×fs op + N×SQL（团队数 ≥ 50 时 ~50ms 占用） | 双方 LOW + lead 验证 | 不修（当前 N < 10） |
| `task-manager/server.ts:33-43` | per-session MCP server 实例化（50 sessions ~几 MB 内存） | 双方推理 LOW | 不修 |
| `inbox-watcher.ts:106-111` | hard-coded 只看 team-lead.json，未来扩 sub-teammate 审批需要重构 | claude nitpick | 不修（设计扩展点已注释） |
| `index.ts:317-348` | before-quit cleanup 串行 await 三 watcher.close 无 timeout 兜底 | claude 自标 *未验证* + 自降 LOW | 不修 |
| `inbox-watcher.ts:84-88` | force-cleanup grace 窗口内 Allow → appendInboxMessage 重建已删 inboxes 目录 | codex 部分实证 LOW | 不修（grace 60s 内罕见 + Allow 无活 teammate 危害低） |
| `inbox-watcher.ts:226-227` | 同 inbox 重复 request_id 第二条静默跳过 retry 失效 | claude *未验证* | 不修（与 H2-R2 同源） |
| `index.ts:240-267` | refreshAutoSubscribe session-upserted 高频时无 debounce | claude 推理 LOW | 不修（autoSubscribed Set 已防抖 watcher 操作） |
| `inbox-watcher.ts:115-120` | inbox unlink 后 seenRequestIds 全清 → 旧 request 重 emit | claude 实证 | 不修（与 H2-R2 同源，prewarm 已部分缓解） |
| `inbox-watcher` 实现层 | I14 / I1-R2 / I1-R3 三轮重提：完全无单测 | reviewer 都建议补 | 不补本轮（成本高 + 当前 4 文件 96 case 已覆盖核心协议 / coordinator / tools） |

## 修复（commits 落地）

8 个 atomic commit，每个独立可 revert，按 round + 严重度分组：

### Round 1
- `6abbb57` REVIEW_17 R1 / **HIGH-H1**: task_delete cascade 跨 team 越权 + repo.update 拦 patch.teamName（repo.delete 加 predicate + tools.ts 传 closure team predicate + UPDATABLE_KEYS 删 teamName）
- `360f606` REVIEW_17 R1 / **MED batch**: M3 deps（TeamDetail snapRef） + M5 mock 引用泄漏（spread 写新对象） + M6 双重 unset（teamCoordinator.unsetTeamFromAllSessions 30s dedup） + M7 lazy provider 测试 + H2 listSeen → listPendingRequestIds（走 activePermissions.keys()）
- `9401372` REVIEW_17 R1 / **LOW batch**: M4 sdk-bridge 注释 + L8 TeamHub 注释 + L10 tool-icons mcp__tasks__* 5 条映射 + LOW-1 vi.mock '../team-fs' + LOW-2 inbox-protocol idle_notification 解析 case 补 2 个

### Round 2
- `48f3c01` REVIEW_17 R2 / **HIGH-H1-R2**: sessionRepo.rename toExists=true 路径合并 team_name + permission_mode（仅这两列「会话身份持续性」相关，其他列 createSession 已写不应被覆盖）
- `703b00a` REVIEW_17 R2 / **MED-H2-R2**: subscribe 时 prewarmSeenFromTeammateResponses 扫 teammate inbox 已写过的 permission_response.request_id 加进 seenRequestIds，让 chokidar replay 时跳过 emit「已响应过的旧请求」（fire-and-forget，trade-off 文档化）
- `43ac8c5` REVIEW_17 R2 / **MED batch**: M1-R2 repo.delete 返 string[] + tools.ts emit N 次 + MED-R2-1 processInboxFile emit 包 try/catch + 失败回滚 seenRequestIds + activePermissions + M2-R2 extractTeamNameFromToolInput trim + 严格 charset
- `cac8217` REVIEW_17 R2 / **LOW-L1-R2**: parseSubMessage 拒空 request_id / tool_name (一行 length === 0 检查)

### Round 3
- `c5f2a41` REVIEW_17 R3 / **MED batch (H1-R3 降 MED + M1/M2/M3-R3)**:
  - H1-R3 (降 MED) appendInboxMessage mkdir 后加 realpath + 前缀校验（独立通信协议层不复用 team-fs.ensureWithinRoot；test +1 case dangling symlink 实证 path escape 拒绝）
  - M1-R3 SendToTeammate 改结构化包装（fenced code block）+ target normalizeTeamName charset 校验
  - M2-R3 inbox-watcher 合并两遍 for-of 单遍 + switch on sub.type（一半 parseSubMessage 调用）
  - M3-R3 recoverAndSend placeholderEmittedAt Map + 5s dedup 占位 message

### 验证
- 所有 commit 走 `pnpm typecheck` + `pnpm exec vitest run src/main/teams src/main/task-manager` 通过
- 最终 4 文件 **96 case 全过**（task-repo.test 26 case 在 Node 22 binding 不兼容时自动 skip）+ 新增 13 case 回归

## 关联 changelog

无独立 CHANGELOG_X.md（8 个 atomic commit 自带详细 message）。本份 REVIEW_17.md 是修复落地的权威记录。

## Agent 踩坑沉淀（候选）

本次 review 提炼出几条 agent-pitfall 候选（如果再撞 2 次将走升级流程到项目 CLAUDE.md）：

1. **fs 读写路径不对称防护**：read/delete 走 ensureWithinRoot 而 write 不走，是 convention bug 而非「写比读安全」（H1-R3 / MED-R3）。**修复模板**：所有应用主进程对用户 / agent / fs sync 来的路径，无论读写都走同款 realpath + 前缀校验
2. **chokidar fire-and-forget Promise rejection**：`void watcher.fire()` 内的 emit 抛错被吞掉，listener 已写入的 in-memory dedup state 永远脏（MED-R2-1）。**修复模板**：所有 emit 包 try/catch + 失败回滚 add 进 dedup 集合的标识符
3. **session-repo.rename toExists=true 路径仅迁子表**：会话身份持续性字段（team_name / permission_mode）在 fork detection 路径走全列复制 ✅ 但在 recoverAndSend post-fallback rename 路径走 toExists=true 仅迁子表 ❌（H1-R2）。**修复模板**：rename 时所有「会话身份持续性」字段都要从 OLD 显式 carry over
4. **lazy provider 改造的核心 gain 没测试覆盖**：CHANGELOG_46 把 fixed teamName 改成 `() => string | null` lazy provider，但测试 helper 包了一层 fixed 工厂等价于回退到 fixed value 测试，lazy 行为本身无回归（M7）。**修复模板**：所有 callable 注入参数的改造，测试必须显式覆盖「调用之间返回不同值」case
5. **prompt 字符串拼接没 escape 边界**：用户 / agent 输入直接拼到 LLM 看到的字符串里，含 newline / 仿造下一条指令即可逃逸 wrapper（M1-R3）。**修复模板**：所有「应用层包装 LLM prompt」走 fenced code block 或类似明确边界结构
