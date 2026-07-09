---
plan_id: provider-usage-cache-refresh-20260615
status: completed
created: 2026-06-15
completed: 2026-06-15
base_commit: 1bd4ae1005cbf6553be0f3fc98b53242b750c9fd
branch: main
workspace: /Users/wanglidong/Repository/agent-deck
changelog: ref/changelogs/CHANGELOG_261.md
---

# Provider Usage Cache And Background Refresh

## Goal

数据 tab 的冷数据在应用打开时预取；“额度窗口”不应每次打开都重新打 provider 查询；切回页面时优先展示缓存，长时间停留时定时刷新。没有订阅的账号需要明确展示“未订阅”。Claude 不应必须依赖用户已有 live 会话，能在后台启动只读 usage 查询时走后台查询。

## Invariants

- 不读取或保存 API key；Claude 仍走本机 Claude Code OAuth/credentials。
- provider usage 查询不写 session DB、不创建应用会话、不触发可见会话事件。
- renderer 切 tab 不清空已有额度窗口结果。
- App 打开时预取每日 token 明细和 provider usage 快照。
- main 端有 TTL 和 in-flight dedupe，避免重复打开数据页时并发/重复打外部查询。
- 后台 Claude 查询不发送用户 prompt，不发起模型 turn；只初始化 SDK Query 后调 `/usage` control request，并在 finally close。
- 无订阅与 provider 不支持、错误、未初始化要区分展示。

## Decisions

- 缓存分两层：renderer zustand store 保留上次快照用于即时渲染；main provider usage IPC 做 TTL 缓存和 in-flight 合并，防重复外部请求。
- DataPanel 继续在打开时尝试刷新，但如果 renderer/main 缓存仍 fresh，不显示整块 loading，也不覆盖旧数据。
- App 顶层负责启动预取；DataPanel 负责页面停留期间的 provider 定时刷新和每日明细补拉。
- 刷新间隔保持 60s；main TTL 设为 55s，避免页面内 interval 每分钟能刷新到新结果，同时快速切 tab 不重复拉。
- Claude live session 优先复用；无 live session 时 fallback 到后台 SDK Query。后台 Query 使用 `settingSources: []`、无 MCP/plugin/system prompt 注入，降低副作用面。
- Claude `subscription_type === null && rate_limits_available === false` 映射为 `not_subscribed`。

## Checklist

- [x] 读仓库规则、相关 changelog/review/index 和额度窗口现状。
- [x] main provider usage IPC 增加 TTL cache + in-flight dedupe。
- [x] Claude 增加无 live session 的后台 usage 查询 helper。
- [x] shared/provider usage 类型和 UI 增加 `not_subscribed` 状态。
- [x] renderer store/DataPanel 使用缓存状态，切回即时显示并驻留时定时刷新。
- [x] App mount 预取 `tokenUsageDaily()` 和 `providerUsageSnapshot()`。
- [x] 补/改单测覆盖 mapping 和 cache 行为。
- [x] 运行 targeted tests、`pnpm typecheck`、`pnpm build`、`git diff --check`。
- [x] 写 changelog 并更新索引，归档 plan。

## Progress

2026-06-15:
- 已确认现状：Codex 用 app-server `account/rateLimits/read`，不依赖打开会话；Deepseek 返回 unsupported；Claude 旧实现只从 live SDK session 的 `usage_EXPERIMENTAL...()` 读取，没有 live session 时显示“需要至少一个可通信的 Claude 会话”。
- 新增 main IPC cache/dedupe：`providerUsageSnapshotHandler` 在 55 秒内直接返回缓存，并合并并发刷新。
- 新增 Claude 后台 helper：无 live session 时启动一个不发送用户消息的 Query，初始化后调用 `/usage` control request，读完或超时都关闭。
- DataPanel 改用 token usage zustand store 保存 provider usage 快照，切 tab 不清空；缓存过期才显示初始读取，停留页面每分钟刷新。
- App mount 预取 daily token rows 和 provider usage 快照，让首次进入数据 tab 可直接展示已有结果；provider 预取与 DataPanel mount 撞车时由 main in-flight dedupe 合并。
- Claude 无订阅限额映射为 `not_subscribed`，UI badge 显示“未订阅”。

## Validation

- `pnpm exec vitest run src/main/adapters/__tests__/provider-usage.test.ts src/main/ipc/__tests__/provider-usage.test.ts` — 9 passed。
- `pnpm typecheck` — passed。
- `pnpm build` — passed。
- `git diff --check` — passed。

## Known Risks

- Claude usage control API 标记 experimental，SDK 未来可能改名或行为变更；错误会被映射为 provider usage error，不应影响其它 provider。
- 后台 SDK Query 使用空闲 AsyncIterable 来避免 user turn；如果 SDK 未来改变 Query 初始化/输入流语义，最多降级为错误快照，main cache 会按 TTL 重试。

## Next-Session First Action

Plan completed. 后续如要做 GUI 实测，在 `/Users/wanglidong/Repository/agent-deck` 按 CLAUDE.md 重启 dev，打开“数据”tab，验证额度窗口切 tab 缓存、60 秒刷新、Claude 无 live 会话后台查询和未订阅 badge。
