# CHANGELOG_261: 额度窗口缓存与 Claude 后台查询

## 概要

数据 tab 的冷数据改为应用启动时预取，额度窗口结果改为缓存展示：切走再回来先显示上次快照，停留页面期间继续定时刷新。Claude 不再必须依赖已打开会话；没有 live Claude 会话时会后台启动只读 usage 查询。无订阅账号明确显示“未订阅”。

## 变更内容

- provider usage IPC 增加 55 秒 TTL cache 和 in-flight dedupe，避免每次打开数据页都重新打 provider 查询。
- App mount 时预取 `tokenUsageDaily()` 和 `providerUsageSnapshot()`，用户首次打开数据 tab 时优先看到已加载结果。
- renderer 把额度窗口快照放入 zustand store，DataPanel unmount/remount 不清空已有结果；缓存过期才显示初始读取，页面停留时仍每 60 秒刷新。
- Claude live session usage 仍优先复用；无可通信 live session 时，后台启动不发送用户消息的 SDK Query，只调用 `/usage` control request 后立即关闭。
- `ProviderUsageStatus` 新增 `not_subscribed`，Claude 无订阅限额时展示“未订阅”，与“不支持 / 暂无 / 失败”区分。
- README 同步数据 tab 额度窗口缓存、后台查询和未订阅展示说明。

## 验证

- `pnpm exec vitest run src/main/adapters/__tests__/provider-usage.test.ts src/main/ipc/__tests__/provider-usage.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
