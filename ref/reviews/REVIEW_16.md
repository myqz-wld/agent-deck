---
review_id: 16
reviewed_at: 2026-05-01
expired: false
skipped_expired:
---

# REVIEW_16: fs watcher symlink path mismatch — chokidar realpath vs raw symlink path 比较失败让 3 处 fs 通道静默失效

## 触发场景

用户跑 `deep-code-review` skill 评审 commit 4d9f40b（SDK Task Manager + skill teammate 改造），lead 用 Agent Teams in-process backend spawn `reviewer-claude` + `reviewer-codex` 双 teammate。reviewer-claude 调 `Bash: git status -uno` → 写 `permission_request` 到 `~/.claude/teams/deep-review-4d9f40b/inboxes/team-lead.json`。**应用 PendingTab 没冒出审批表单**，reviewer-claude 死等 → review 阻塞。

排查链路 `inbox-watcher → eventBus → main bridge → IPC → renderer store → PendingTab`，逐层验证全好（DB sessions row source=sdk active team_name 正确、events 表 ingest 路径必写 row、type guard 与 store reducer 都对），唯独 events 表里**零条** `team-permission-request` row + main 终端无任何 `[main] team-permission-requested` 相关 warn → 锁定 `inbox-watcher emit` 之前断链。

最终静态 audit 发现：用户的 `~/.claude` 是 symlink 指向 `/Users/apple/.claude-default`，chokidar 在 macOS fsevents 下回 handle 函数的 `filepath` 是 realpath 化路径，与代码里 `getInboxPath()` 拼出的 raw symlink path 严格 `!==` 比较永远 true → handle 永远 early return → emit 永远不 fire。

## 方法

**非双对抗** — debug-style 排查一步步 trace 现场状态，每一步都是 deterministic 验证（DB SQL / 代码 grep / log 实测），不需要异构对抗。验证手段以「inbox 现场制造测试 entry + 直查 DB events 表 + main 终端 log + node realpath 实测」为主。

**关键证据来源**：
- `python3 -c "import os; print(os.path.realpath('~/.claude/teams/.../team-lead.json'))"` → `/Users/apple/.claude-default/...` 与 raw `/Users/apple/.claude/...` 不等（铁证 symlink）
- `node -e "fs.realpathSync(p)"` 同样输出 `.claude-default` 路径（确证 node 行为）
- 直接 SQLite 查 `events WHERE payload_json LIKE '%team-permission-request%'` → 0 row（确证 ingest 没走）
- 直接 SQLite 查 events 43508-43510 含 `"thinking":"看起来这是一个探针请求...都包含 probe 标记"` → lead Claude session 在 chat 里**收到了 PROBE permission_request 作为 user message**（确证 CLI 内部 inbox polling 正常，证伪「inbox 文件本身没被 detect」假设 → bug 在应用层 chokidar）
- main 终端无 `[main] team-permission-requested for "deep-review-4d9f40b" but no session bound; UI 看不到。` warn（证伪「leadSession 找不到走 warn 分支」假设）
- 同步 audit 发现 `team-coordinator.ts:113 startsWith(root)` 与 `team-watcher.ts:83-84 p === teamDir / startsWith(teamDir + '/')` 同根因失效；用户 main log 里 `[team-coordinator] sync from pretool` 出现但 `sync from fs` 全程没出现，间接确证 fs 通道也死

**范围**：3 个 fs watcher 文件 + 1 个共享路径 helper（不改语义，只在 watcher subscribe 入口 realpath 化）

```text
src/main/teams/inbox-watcher.ts        # subscribe 入口 realpathSync(inboxesDirRaw) + cache expectedLeadInbox
src/main/teams/team-coordinator.ts     # 加 realRoot 字段 + startFsWatcher 时 realpathSync(rootRaw) + processConfigFile 用 this.realRoot
src/main/teams/team-watcher.ts         # subscribe 时 realpathSync(getTeamsRoot()/getTasksRoot()) 后 join name
```

```review-scope
src/main/teams/inbox-watcher.ts
src/main/teams/team-coordinator.ts
src/main/teams/team-watcher.ts
```

> 本份 review 首次加入 git 的 commit 视为这批文件的覆盖基线。File-level Review Expiry 自动按基线计算 churn / commit / 时间。

**约束**：CHANGELOG_45 / CHANGELOG_46 已修过的 inbox watcher / team-coordinator 三层反向同步本身不重审，本份只针对 symlink path mismatch 这条新发现的 bug。

## 三态裁决结果

> 本节遵循全局「决策对抗」节的「实践验证 > 空猜」纪律：每条 ✅ 必须带验证手段。本次特殊在于：debug 过程多次出现「先假设后实测证伪」的反复，所有假设演化都诚实记入 ❌ 反驳里，最终只剩一条 ✅ HIGH 锁住根因。

### ✅ 真问题（实测 + 现场制造证据实证）

| # | 严重度 | 文件:行号 | 现场 | 验证手段 |
|---|---|---|---|---|
| 1 | HIGH | `src/main/teams/inbox-watcher.ts:85-86` (修复前) | chokidar 监听 `inboxesDir`（raw `/Users/apple/.claude/...`），handle 函数收到 chokidar 回的 filepath（realpath 化 `/Users/apple/.claude-default/...`），与 `getInboxPath(name, 'team-lead')` 重新拼出的 raw symlink path `!==` 比较**永远 true** → handle 永远 early return → `processInboxFile` 永远不调 → `eventBus.emit('team-permission-requested', ...)` 永远不触发 → main bridge 永远不 ingest → PendingTab 永远不弹 teammate 审批 | (a) python `os.path.realpath` + node `fs.realpathSync` 双侧确证 `.claude` symlink 解析到 `.claude-default`；(b) 现场往 inbox 追加 fake permission_request `perm-probe-...`，2s 后 SQL `events WHERE id > 43507` 查到 lead Claude **收到 PROBE 作为 user message**（CLI 自己的 inbox polling 正常）但**没有任何 team-permission-request kind row**（应用层 chokidar 没 fire）；(c) main log 全程无 `[main] team-permission-requested ... but no session bound; UI 看不到。` warn（排除「leadSession 找不到」分支）|
| 1a | HIGH | `src/main/teams/team-coordinator.ts:113` (修复前) | `if (!filepath.startsWith(root)) return;` 同根因失效 — `root = getTeamsRoot()` 是 raw symlink path，`filepath` 来自 chokidar 是 realpath 化路径 → startsWith 永远 false → fs sync 通道完全静默失效，team config 的 fs add/change 永远不触发 sync | main 终端 log 全程只有 `[team-coordinator] sync from pretool` 没有 `sync from fs`（证据：lead 调 TeamCreate 时 PreToolUse hook 触发 sync 兜住了 DB，但纯 fs change → DB 这条路全废）|
| 1b | HIGH | `src/main/teams/team-watcher.ts:83-84` (修复前) | `dispatchByPath(p)` 内 `if (p === teamDir \|\| p.startsWith(teamDir + '/'))` 同根因失效 — `teamDir = join(getTeamsRoot(), name)` 是 raw symlink path，p 来自 chokidar 是 realpath，比较永远 false → emit `team-data-changed` 永远不触发 → renderer 端 TeamDetail 不知道 team config / task-list 有变化 | 静态代码 audit + 与 inbox-watcher / team-coordinator 同根因（chokidar 在 macOS fsevents 下回 realpath 是固定行为，三处全中招）|

### ❌ 反驳（debug 阶段假设被实测证伪）

| # | 报项 | 反驳依据 |
|---|---|---|
| 1 | 第一轮假设「inbox-watcher 的 `seenRequestIds` 去重 + main bridge 找不到 leadSession 时静默丢消息 → 永久丢失」（基于「上次 lead 进程里 sync 还没完成时就 emit → leadSession 找不到走 warn 分支 → 但已 add seenRequestIds 永不 retry」推理） | 现场操作：mv 走 inbox 文件 → 触发 chokidar unlink → seenRequestIds.clear() → mv 回来触发 add → 应该重 emit。结果：PendingTab 仍不弹 + events 表无 row。**证伪**：seenRequestIds dedup **不是**根因，bug 在更上游（chokidar 根本没 fire change/add） |
| 2 | 第二轮假设「sessionRepo.findByTeamName(teamName) 在 emit 时刻找不到 leadSession 走 warn 分支静默丢」 | SQLite 直查 `sessions WHERE id = '16f2bc86-...' OR team_name = 'deep-review-4d9f40b'` → source=sdk lifecycle=active team_name=deep-review-4d9f40b 全对 → main bridge line 200 `findByTeamName` 必然命中。**证伪**：leadSession 找得到 |
| 3 | 第三轮假设「sessionManager.ingest 内部某条 dedupOrClaim skip 路径吞了 source='sdk' 的 team-permission-request 事件」 | 读 dedupOrClaim 源码 line 188-244：所有早返路径都是 `event.source === 'hook'` 才触发，source='sdk' 必走通到 persistEventRow → 必写 events 表。**证伪**：ingest 路径如果跑了**必然**写 events 表 → events 表 0 row 反向证明 emit 根本没触发 ingest |
| 4 | 第四轮假设「chokidar awaitWriteFinish 250ms 配合 python truncate+write 太快没 fire change」 | 现场往 inbox 追加 fake entry 后 sleep 2s 远超 250ms stability，仍 0 row。**证伪**：不是 awaitWriteFinish 时序问题（最终发现是 path 字符串比较根本就不等）|

### ❓ 部分 / 未验证

| # | 项目 | 状态 |
|---|---|---|
| 1 | `inbox-protocol.ts:38-45` 的 `getInboxPath()` 是否应该改为返回 realpath 路径，让所有调用方（包括 `appendInboxMessage` 写文件路径）统一用 realpath？ | **❓ 不改**。`getInboxPath` 还被 `appendInboxMessage` 用于写文件，文件系统通过 symlink 写到正确物理位置不影响功能；改返回值会让 log 输出 `.claude-default/...` 不直观。当前修法只在 fs watcher subscribe 入口做 realpath 化，最小侵入 |
| 2 | chokidar 是否有 option 强制不做 realpath（让 fsevents 回 raw path）？ | **❓ 不查**。fsevents 在 macOS 上对 symlink 路径的处理是 kernel 层行为，chokidar 没有 option 可以让 fsevents 不解析；即便有也只是绕过，统一在应用层 realpath 化更稳定 |
| 3 | node `fs.watch` 替代 chokidar 是否会避免这个问题？ | **❓ 不动**。`team-watcher.ts:12-17` 注释明确写了「chokidar 而不是原生 fs.watch」的理由（recursive 不支持 / 原子替换不 fire / 写入中状态多次 fire），切换会丢这些好处；不值得为一个 path 比较 bug 推翻整个选型 |

## 修复（CHANGELOG_47 待落地）

### HIGH

1. **`src/main/teams/inbox-watcher.ts:19-21,66-77`** — `import { existsSync, mkdirSync, realpathSync } from 'node:fs'` + subscribe 入口先 mkdir-p 后 `realpathSync(inboxesDirRaw)` 缓存 `inboxesDir` + cache `expectedLeadInbox = join(inboxesDir, 'team-lead.json')`；handle / unlink 内部用 cached `expectedLeadInbox` 比较（不再重新调 `getInboxPath`）；删除现已不用的 `getInboxPath` import
2. **`src/main/teams/team-coordinator.ts:31,46-52,77-103,108-122`** — `import { existsSync, realpathSync } from 'node:fs'` + class 加 `private realRoot: string | null = null` 字段 + `startFsWatcher` 时 `realRoot = existsSync(rootRaw) ? realpathSync(rootRaw) : rootRaw` 缓存 + `processConfigFile` 用 `this.realRoot ?? getTeamsRoot()` 做 startsWith / slice 前缀比对
3. **`src/main/teams/team-watcher.ts:21,69-77`** — `import { existsSync, realpathSync } from 'node:fs'` + subscribe 入口 `teamsRootReal = existsSync(getTeamsRoot()) ? realpathSync(...) : ...` 同模式 + `teamDir = join(teamsRootReal, name)` / `tasksDir = join(tasksRootReal, name)`；`dispatchByPath(p)` 内 `p === teamDir / startsWith(teamDir + '/')` 比较自然匹配 chokidar 给的 realpath

### MED / LOW
（无 — 本次只改 path 比较基线，不顺手重构其他）

### 验证方式

- `pnpm typecheck` ✅（修复后跑通过）
- 重启 dev 后新会话复测：建一个 test team，spawn teammate 调 Bash → PendingTab 应在 lead session 桶冒出 `TeamPermissionRow`（蓝色头像、Approve/Deny 按钮）；同时 main 终端应出现 `[team-coordinator] sync from fs` log（之前一直只有 `from pretool`）
- 重启验证步骤详见 commit message / 测试路线（用户操作）

## 关联 changelog

- 暂未 commit / 暂无关联 changelog（本次为 debug fix，未引入功能变更，按 CLAUDE.md 归 reviews/）；如后续 commit 编号为 47 则更新本节为 `CHANGELOG_47.md`

## Agent 踩坑沉淀

候选 1 条 → `.claude/conventions-tally.md`「Agent 踩坑候选」section（与 REVIEW_15 沉淀的「行为机制凭直觉/局部观察 → 误判」同类，但更细化到 fs path 维度）：

- **「fs watcher / 路径比较类代码必须假设 path 可能被 realpath 化」**：macOS fsevents、Linux inotify-tools、Windows ReadDirectoryChangesW 对 symlink 的解析行为不一致，**任何**`filepath !== expected` / `filepath.startsWith(root)` 模式比较前都应该把基线 realpath 化（subscribe 入口一次性缓存即可）。预防：写 fs watcher 代码时先问自己「如果用户 home 把 .config 软链到别处会怎样？」；review 时凡看到 chokidar/fs.watch handler 内的字符串相等比较就标 ❓ 要求验证。本次踩坑根因 = chokidar 文档没明示 fsevents realpath 行为 + 应用代码假设 path 字符串严格匹配，三处 fs watcher 写时全踩同一坑。
