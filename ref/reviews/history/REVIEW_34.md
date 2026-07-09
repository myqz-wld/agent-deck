---
review_id: 34
date: 2026-05-13
plan: review-33-high-fix-20260513
phase: H1
note: 原命名 REVIEW_33,与 main commit `903d53f` 撞名(用户做 5 份指令文档 review 占用 33),让位改 34
heterogeneous_dual_completed: true
reviewers:
  - reviewer-claude (Opus 4.7 xhigh, teammate × 4 batches)
  - reviewer-codex (gpt-5.5 xhigh, teammate wrapper × 4 batches)
rounds: 1 (跳过反驳轮 — lead 自己 grep/read 验证 6 条单方 HIGH 替代反驳)
fix_landed_in: changelog/CHANGELOG_96.md (待写)
---

# REVIEW_33 — mcp-bug-and-feature-batch-20260513 plan + CHANGELOG_95 19 commits 异构对抗

## 触发场景

用户在新会话主动请求「deep code review 下最近的改动」。最近改动 = `bfccc10..e7c9be7` 19 commits / 67 files / ~5500 行：
- `mcp-bug-and-feature-batch-20260513` plan 18 commits（Phase 1-6 全程：J bug fix / B check_reply / C/E/G/H lifecycle backlog / I sdkOwned 真私有 / N bug unarchive / K1 archive_plan mcp tool / K2 start_next_session mcp tool / K3 hand-off UI + LLM 总结 / A cross-session UI 渲染 / L SessionCard 工具信息 / M 透明置顶解耦）
- 1 commit `e7c9be7 CHANGELOG_95`（前一轮 K3 hand-off review fix，含 disposedRef → requestSeqRef 替换）

## 方法

- **执行环境**：worktree `.claude/worktrees/review-33-high-fix-20260513`，base commit `e7c9be7`
- **deep-code-review SKILL**：teammate 模式（mcp__agent_deck__spawn_session 起 reviewer-claude + reviewer-codex 各 4 对）。scope 切 4 批：
  - **批 A** mcp tool 新增（archive_plan / start_next_session / check_reply）13 文件
  - **批 B** J bug + lifecycle + sdkOwned + N bug 9 文件
  - **批 C** K3 hand-off UI 7 文件
  - **批 D** Phase 5 渲染区分 + L SessionCard + M 透明置顶解耦 17 文件（按 A/L/M 子主题分组组织 finding）
- **fan-out 5 触顶**：第一波 spawn 5 个，C-claude 单飞 shutdown；A+B 4 个收完 reply 后 shutdown 释放；第二波起 C+D 4 个；C-claude 撞 30min hard cap timed out（lead nudge 后才 reply）
- **跳过反驳轮**：6 条单方 HIGH lead 自己 grep + read 验证替代（避免 fan-out churn 再起反驳轮浪费 SDK 配额；reviewer 给的 finding 都附了具体文件:行号 + 验证手段，lead 30 秒可重复验证）

## 三态裁决清单

### 🔴 HIGH 真问题（10 条，9 条必修 + 1 条 ❓ 部分）

| # | 来源 | 文件:行号 | 概要 | 验证手段 |
|---|---|---|---|---|
| H1 | 双方 | `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:228-236` | `base_branch` 参数被忽略 — `git merge --ff-only worktreeBranch` 只合到 mainRepo 当前 HEAD，caller 当前 checkout 在 `feature-x` 时把 worktree branch 合进 feature-x 而非 main | grep `baseBranch\|checkout\|switch` 仅 2 处出现（field 定义 + error hint），无任何 branch 切换命令 |
| H2 | claude 单方 | `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:221` | archive_plan 接受 `status: abandoned` 走完整归档流程 — 与 user CLAUDE.md§Step 4「abandoned plan 不应入项目 git 归档」「不走 archive_plan tool」硬约定矛盾 | lead read 确认只 reject `completed`；注释 line 19 自承「abandoned 也允许收口」与 user CLAUDE.md 失配 |
| H3 | codex 单方 | `src/main/agent-deck-mcp/tools/handlers/wait.ts:118-130` + `types.ts:74` | `wait_reply` 在 `EXTERNAL_CALLER_ALLOWED=true`（read-only 观察类），但 `nudge_text` 路径调 `enqueueAgentDeckMessage` 写 DB 投递消息 — external caller 可绕过 send_message / reply_message 的 deny external 注入消息 | lead read 确认 nudge timer 直接 enqueue 不二次 deny |
| H4 | 双方 | `src/main/teams/team-lifecycle-scheduler.ts:84-118` | `scan()` pagination + archive 漏扫 — `_archiveTeam` 把 archived_at 设非 NULL → active list 立即缩 → `offset += PAGE_SIZE` 跳错 → 漏扫 N 条 ghost team | reviewer-claude node 模拟 500 条全 ghost 漏扫 200，30% 概率漏 22 |
| H5 ❓ | codex 单方 | `src/main/teams/universal-message-watcher.ts:450-454` | J bug 修对 reply chain 嵌套语义统一处理（lead 反 reply teammate 也短路）— 设计 intent 但未文档化 | lead 判：触发面窄（lead 极少调 reply_message），降级 ❓ 部分；建议 deliver 注释加说明 |
| H6 | claude 单方 | `src/main/ipc/sessions.ts:113-117` | `handOffSpawn` 不透传 `codexSandbox` / `claudeCodeSandbox` — 用户原 session 切到 read-only/strict 后 hand-off → 新 session 落 settings 全局默认（claude 'off' / codex 'workspace-write'）→ 隐性沙盒 downgrade | lead read 确认 createSession args 仅 cwd / prompt / permissionMode；types/session.ts:60,69 确证两字段存在 |
| H7 | codex HIGH + claude MED | `src/main/ipc/sessions.ts:92-134` + `HandOffPreviewDialog.tsx:53/74` | 重复确认创建多个 SDK session（按次计费）— main 端无 in-flight Map / dedup；renderer `startSummarize` / `submit` 入口无同步 ref guard，React state batch 16-200ms 内双击都触发 | lead read sessions.ts 无 inFlight；HandOffPreviewDialog.tsx HEAD e7c9be7 已用 requestSeqRef 修了 disposedRef 反模式（M7 不再修），但入口仍缺 ref guard 双击仍能各自起 SDK |
| H8 | claude 单方 | `src/main/ipc/settings.ts:209-212` + `_helpers.ts:147` | `autoApproveTeammateMode` IPC validation 全孤儿 — inbox-watcher 已删除（grep 在 src 内 0 真实实现，仅注释 + 自身定义）；validation 写盘 → 重启时 REMOVED_KEYS 又删全循环空转 | lead grep 验证 inbox-watcher.ts 不存在；settings.ts:209-212 + _helpers.ts:147 + import 全可删 |
| H9 | 双方 | `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:62 / 228-343` | ff-merge 后任一步失败返通用 `{error}` 不告诉 caller 半完成状态 — mainRepo 已 dirty + ff-merge 已动 HEAD 时 caller 无法判断需手工回滚还是继续 | lead read step 7 后所有 try/catch 无 phase 标记 |
| H10 | 双方 | `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:171-175` (start-next-session-impl 同款) | `worktree_path` / `cwd` 无存在性预检 — frontmatter 拿到后只校验绝对路径形态，不查目录存在；worktree 已删 / rename / 跨机器迁移 → spawn 起 SDK 用不存在 cwd → ENOENT 一片 | reviewer 双方独立提 + 路径推演明确 |

### 🟡 MED（14 条）

| # | 文件 | 概要 | 来源 |
|---|---|---|---|
| M1 | `src/main/store/agent-deck-message-repo.ts:290` | `listBySession` OR query 缺 `from_session_id` 索引（codex EXPLAIN QUERY PLAN 实测 SCAN）— 1w 行后 100ms+ | 双方 |
| M2 | `src/main/session/summarizer.ts:435-501` | summariseSessionForHandOff prompt injection 风险 — user/assistant text 直接拼进 sonnet prompt 无 escape | 双方 |
| M3 | `src/renderer/components/SessionCard.tsx` (6 处 + describe.ts) | `string.slice(0, N)` 截断 surrogate pair 边界破 emoji（Bash/WebSearch/WebFetch/Task/Skill/TodoWrite 6 处全踩） | 双方（claude MED, codex LOW） |
| M4 | `src/main/ipc/adapters.ts:240-258` | `unarchiveOnUserSend` 在 attachments try-catch 块外，throw 时跳过 attachments rollback + session/team 状态已被改 | 双方 |
| M5 | `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:302-308/311-319` | `plan_file_path` override 在 mainRepo 内非 .gitignore 路径时 `unlink` 不入 commit，留 dirty deletion | claude 单方（lead 自验 ✅） |
| M6 | `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:214/221` | frontmatter 必填字段（plan_id/worktree_path/base_commit）未校验 | codex 单方（lead 自验 ✅） |
| M7 ✅已 fix | `src/renderer/components/HandOffPreviewDialog.tsx:37/57` | 旧 preview 请求 resolve 后污染新 dialog（disposedRef race）| codex 单方 — **已被 CHANGELOG_95 fix（requestSeqRef 替换 disposedRef）**，本轮不再重修 |
| M8 | `src/renderer/components/SessionDetail/MessagesPanel.tsx:27` | `useSessionStore((s) => s.sessions)` 全订阅 Map ref 放大重渲染 | claude 单方 |
| M9 | `src/shared/wire-prefix.ts:27` + `universal-message-watcher.ts:199` | wire prefix regex 用 `]` 作硬边界但生产端不限 displayName 含 `]`/换行 | codex 单方（regex 反例实测） |
| M10 | `src/renderer/components/settings/sections/WindowSection.tsx:23` + `App.tsx:326` | `windowTransparent` UI toggle 不即改即生效（违反 CLAUDE.md§188） | codex 单方 |
| M11 | `src/main/index.ts:299` + `App.tsx:81` | `Cmd+Alt+T` 快捷键 next 计算从持久化 store 读，但持久化由 renderer 异步完成 — 快速连按 main 重复算同一 next | codex 单方 |
| M12 ❓ | `src/main/agent-deck-mcp/tools/handlers/start-next-session-impl.ts:200-203` | K2 cold-start prompt 不告诉新 session 必须按 reply 协议回 lead | claude 单方 — 触发面看 lead 是否真等 reply |
| M13 | `src/main/teams/team-lifecycle-scheduler.ts:258` | dispatcher.start() preseed 启动后新建 team 首次 active→archived 会被 `if (prev === undefined) return` 吞掉 | codex MED / claude INFO → 取 MED |
| M14 ❓ | `src/main/agent-deck-mcp/tools/helpers.ts:166` | `isLegitReply` 只过滤方向，不过滤 status — failed/cancelled reply 也命中 | codex 单方 — cancelled reply 罕见 |

### 🟢 LOW / INFO（13 条）

- `archive-plan-impl.ts:281` INDEX 防重复 substring 易破
- `archive-plan.test.ts:138` UTC 时间跨日界 CI 时区敏感
- `universal-message-watcher.test.ts:151/245` reply chain 嵌套 + dispatcher fanOut 测试覆盖 gap
- `manager.ts:337-341` `unarchiveOnUserSend` TOCTOU 重入（无实际 DB 错乱）
- `universal-message-watcher.ts:450-454/504` `markDelivered` 失败盲区 row 卡 'delivering'
- `SessionDetail/index.tsx:273` tab 切换 unmount MessagesPanel 丢失 state
- `wire-prefix.ts:36` 普通 user 输入 `[from X @ Y]\n...` 起头会被 parse（守门只对 role='user' 限了影响面）
- `SessionCard.tsx:305` WebFetch 注释「显示 url + prompt」实现只显示 url
- `window.ts:121-123` `setAlwaysOnTop` 内冗余 `setVibrancy`
- `window.ts:38` 启动时 main 窗口先按 `alwaysOnTop=true` 创建忽略持久化
- `hand-off.test.ts:164` timeout 测试是占位 `expect(true).toBe(true)`
- `docs/agent-deck-mcp-protocol.md` 仍写 6 tool（实际 10 tool）
- `preload/index.ts:511` `electronIpc.invoke` 通用渠道（CLAUDE.md§188 文档说允许）

### ❌ 反驳 / 排除

无明确反驳。**❓ 未验证**保留 H5（reply chain 嵌套）+ M12 + M14 共 3 条，留待后续单测覆盖。

## 修复条目（10 commits 落地）

按用户确认的 4 条 design choice 执行：

| HIGH | 设计选 | 实施 |
|---|---|---|
| H1 | a. checkout base_branch 再 ff-merge | archive-plan-impl.ts ff-merge 前 `git checkout base_branch` + branch 存在性 verify |
| H2 | a. reject abandoned hint 走手工 | archive-plan-impl.ts reject `abandoned` + hint 指引 user CLAUDE.md§Step 4 abandoned cleanup |
| H3 | (无 design 分歧) | wait.ts nudge 路径加 deny external caller |
| H4 | b. 两阶段先收集后批量 | scheduler.scan() first-pass 收集 teamId 列表（不调 _archiveTeam）→ second-pass 一次性 archive |
| H6 | (无 design 分歧) | sessions.ts handOffSpawn 透传 codexSandbox / claudeCodeSandbox |
| H7 | 1+2+3 全选 | renderer ref guard (`summarizeInFlightRef` / `submitInFlightRef` 入口同步守门) + main inflight Map (`SessionHandOffSpawn` handler 按 sourceSid dedupe) + 并发单测 |
| H8 | (无 design 分歧) | 删 settings.ts:209-212 + _helpers.ts:147 parseAutoApproveTeammateMode + import |
| H9 | (无 design 分歧) | archive-plan-impl.ts ff-merge 后所有 try/catch 加 `phase: 'post-ff-merge'` 标识 |
| H10 | (无 design 分歧) | archive-plan-impl.ts + start-next-session-impl.ts worktree_path / cwd 加 `deps.exists()` 预检 |

详细变更见 changelog/CHANGELOG_96.md（plan 收口时写）。

## 跳过未修

- **MED 14 条**：本轮聚焦 HIGH，MED 可下轮 review 处理或随用户优先级要求加入 fix list
- **LOW/INFO 13 条**：清理性质，逐条 issue 化或随相关功能改动顺手 fix
- **❓ 部分（H5/M12/M14）**：建议未来单测覆盖后再决定

## 元 finding（流程改进）

- **wire format anchor 错配 false alarm**：reviewer-claude C-claude 在 timeout 后报「spawnPromptMessageId 与 spawn-injected prompt anchor 不一致」，**实际是 lead nudge 时 copy-paste 错把 A 批 messageId 填到 C 批 prompt** —— 协议本身正确（spawnPromptMessageId === wire prefix `[msg ...]` value 一致），lead nudge 时人为输入错误
- **fan-out 5 限流**：4 批 reviewer 一波起 8 个超过 default 限流，实际只起来 5 个；策略调整为「先起一波 4 个 → 等收完 shutdown 释放 → 再起下一波」
- **C-claude 撞 30min hard cap**：reviewer-claude 直接 print finding 到 stdout 忘调 reply_message（已被 reviewer-claude.md§核心纪律 第 9 条强约束但仍踩坑）— lead nudge 后才补发 reply。建议把「先 reply_message 再 print summary」加到 reviewer-claude.md 顶部强化
