# REVIEW_116 — 开机自启重复注册登录项

- 触发：用户报「开机自启好像没有用，然后每次启动都会额外写一条项目到表格里」。
- 范围：`src/main/index/bootstrap-infra.ts` 启动同步、`src/main/ipc/settings.ts` 设置热更新、登录项 helper。
- 方法：单方现场读码 + Electron 33 本地类型核对 + 定向回归测试。窄范围确定性 bug，未起异构对抗。
- 关联 changelog：无（bug 修复走 REVIEW only）。

## 结论

1. **MED ✅ 启动阶段无条件写 macOS login item**
   - 证据：`bootstrap-infra.ts` 每次非 dev 启动都会调用 `app.setLoginItemSettings({ openAtLogin: settings.startOnLogin, openAsHidden: false })`。
   - 风险：macOS 13+ 登录项以 `SMAppService` 状态机管理，`requires-approval` 表示已经提交给系统等待用户批准。此时继续重复写入不会让自启立即生效，反而可能在系统设置「登录项」列表里出现重复 row。
   - 修复：抽 `src/main/login-item.ts`，先 `getLoginItemSettings({ type: 'mainAppService' })` 读状态；`enabled` / `requires-approval` / `openAtLogin=true` 已符合开启意图时直接跳过写入。

2. **LOW ✅ 启动路径和设置路径 login item 逻辑分叉**
   - 证据：启动 bootstrap 和 SettingsSet 各自手写 `setLoginItemSettings` 参数。
   - 风险：后续再补平台差异或状态机守门时容易只改一侧。
   - 修复：两处统一调用 `syncLoginItemSetting`；dev 模式仍由调用方守门，保留原先「dev 不写系统登录项」行为。

## 回归测试

- 新增 `src/main/__tests__/login-item.test.ts`：
  - macOS `enabled` 不重复写。
  - macOS `requires-approval` 不重复写。
  - macOS `not-registered` 才写 `type: 'mainAppService'`。
  - macOS `not-found` 优先于 stale `openAtLogin=true`，避免误跳过修复注册。
  - macOS 关闭时会注销。
  - dev / unsupported platform 不触碰系统 API。
  - Windows 保持按 `openAtLogin` 对比。

## 验证

- `pnpm vitest run src/main/__tests__/login-item.test.ts` ✅ 8 passed。
- `pnpm typecheck` ✅。
- `pnpm build` ✅。
