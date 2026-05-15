# CHANGELOG_114

## 概要

`hand_off_session` mcp tool 加 `archive_caller` 字段让 caller 可选 opt-out 归档（plan `hand-off-mcp-archive-opt-20260515`）。修前 hand-off 强制 archive caller（baton 单向交接默认语义），不灵活;新增 `archive_caller: false` 让 caller 起新 session 并行做事自己仍 active —— 典型用例 lead 起多个 follow-up hand-off 自己继续协调进度 / debug 工具实测某 plan 但 caller 仍要观察 reviewer reply。Schema 默认 `true` 保持向后兼容,与 `keep_teammates` 字段对称命名（baton 默认动作可显式 opt-out）。trivial schema 加 + handler 透传 + helper 分支 + 5 regression test,不走多轮对抗 review。typecheck 双端 + vitest 全套 595 测 0 regression。

## 变更内容

### 1. schema (src/main/agent-deck-mcp/tools/schemas.ts)

- `HAND_OFF_SESSION_SCHEMA` 加 `archive_caller?: z.boolean().optional()` 字段（与 `keep_teammates` 字段同款 boolean 默认行为 + 紧邻分组）
- `HandOffSessionResult.archived` jsdoc 扩 `'skipped'` 多来源说明: external caller(防御短路) + caller 显式传 archive_caller=false(显式 caller 意图)
- 字段命名决策见 plan §设计决策 1：`archive_caller` 不是 `keep_caller`(与 `keep_teammates` 对称风格 — 都是「描述会做什么动作」+ 默认值 + boolean opt-out)

### 2. handler (src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts)

- `runBatonCleanup` 调用透传 `archiveCaller: args.archive_caller !== false`(默认 true,仅 caller 显式 false 跳过)
- 与 `keepTeammates: args.keep_teammates === true` 字段并列(两 opt-out 字段互相独立可分别 opt-out)

### 3. helper (src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts)

- `RunBatonCleanupInput` 加 `archiveCaller?: boolean` 字段(optional + default true 保持 archive_plan 调用方零改动向后兼容)
- phase 2 入口 external sentinel 短路之后加 `if (input.archiveCaller === false) return { teammatesShutdown, archived: 'skipped' }`(零副作用 — 不调 getFn / archiveFn)
- 顶部 jsdoc 「archive caller 三态」段 + `RunBatonCleanupResult.archived` 字段 jsdoc 同步反映 archive_caller=false 新分支

### 4. test 加 case

- `__tests__/baton-cleanup.test.ts` 加 case 11 (archiveCaller=false → phase 2 跳过 + archived='skipped' + 不调 getFn/archiveFn / phase 1 仍跑) + case 12 (两 opt-out 字段同时启用 → phase 1+2 都跳)
- `__tests__/hand-off-session.handler-deny-happy.test.ts` 新建 describe `archive_caller opt-out` 加 3 case (handler 端到端透传 archive_caller=false / 显式 archive_caller=true 等同默认 / archive_caller=false + keep_teammates=true 正交两字段)

## 测试

- typecheck 双端 0 错(node + web)
- vitest 全套 39 文件 / 531 passed / 64 skipped / **0 failure**(better-sqlite3 ABI 不匹配 64 环境 skip,与本改动无关)
- 直接受影响: baton-cleanup.test.ts 12/12 + hand-off-session.handler-deny-happy.test.ts 22/22 + hand-off-session.handler-cwd-generic + impl-core + session/hand-off + archive-plan handler 全过

## 引用

- 配套 plan(归档后): [`plans/hand-off-mcp-archive-opt-20260515.md`](../plans/hand-off-mcp-archive-opt-20260515.md)
- 父功能: CHANGELOG_97(baton 自动归档 caller 落地)+ CHANGELOG_106(teammate shutdown 同款 keep_teammates opt-out)+ CHANGELOG_109(R37 baton-cleanup helper 抽出)— 本次 archive_caller opt-out 与 keep_teammates 字段对称
