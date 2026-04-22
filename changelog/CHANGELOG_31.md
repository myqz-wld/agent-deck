# CHANGELOG_31: 修「等待你的输入」误报（取消事件不再切 waiting / 不弹通知）

## 概要

实测反馈：会话明明已经处理完一条 pending（点了「允许」/「批准计划」/「提交回答」），或者 SDK 自己 timeout / abort / session-end，应用还会再弹一次「Agent 等待你的输入」系统通知 + 提示音，状态徽标也会卡在 `waiting`。

根因：SDK 通道的取消事件（`permission-cancelled` / `ask-question-cancelled` / `exit-plan-cancelled`）跟真请求复用了同一个事件 kind（`waiting-for-user`），下游通知分发和 activity 状态机一律按"又一次需要用户输入"处理。本次让取消事件**只走 store 的 pending Map 移除路径**，不再切 activity、不再触发通知。

## 变更内容

### `src/main/session/manager.ts`
- `nextActivityState` 多接 `payload` 参数：`waiting-for-user` kind 时检查 `payload.type`，以 `-cancelled` 结尾（permission-cancelled / ask-question-cancelled / exit-plan-cancelled）的视为「撤掉那条 pending」事件，activity 保持 `current` 不切到 `waiting`
- 注释说明这种「kind 复用、type 区分」的设计取舍

### `src/main/index.ts`
- 通知分发的 `waiting-for-user` 分支加 `*-cancelled` 短路：取消事件直接 return，不调 `notifyUser`，不再弹「Agent 等待你的输入」系统通知 / 提示音
- `payload` 提取一次复用，避免重复 cast

## 关键场景验证

- 用户点「允许本次」 → SDK abort signal 触发 `permission-cancelled` → 应用之前会再弹一次通知，现在静默
- ExitPlanMode timeout → emit `exit-plan-cancelled` → 应用之前会再弹通知 + 状态卡 waiting，现在通知静默 + activity 跟随后续真实事件（message / tool-use-start）演进
- session-end finally 清空所有 pending 时 emit 的 cancelled 事件 → 之前会重复弹通知，现在静默

## 没动的地方

- 「kind」字段保持 `waiting-for-user` 不变：renderer store 已经按 `payload.type` 正确区分（`isPermissionCancelled` / `isAskQuestionCancelled` / `isExitPlanCancelled`），cancel toast 也是按 type 区分的，改 kind 反而要全链路重新对齐
- Hook 通道的 Notification 事件保持现状：Claude Code CLI 的 Notification hook 触发场景本来就是「需要操作」（"needs your permission" / "waiting for your input"），不在本次清理范围
- `ActivityFeed` 的 `describe()` 文案已经能正确显示「⚪ 权限请求已被 SDK 取消」等，不动
