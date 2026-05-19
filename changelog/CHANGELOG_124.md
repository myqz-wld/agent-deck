# CHANGELOG_124 — 全局快捷键加「一键最大 / 一键回默认」窗口尺寸切换（4 轮异构对抗 review × fix 收口）

## 概要

在已有 `Cmd+Alt+P`（toggle 置顶）/ `Cmd+Alt+T`（toggle 透明）基础上再加 `Cmd+Alt+=` / `Cmd+Alt+-` 两个全局快捷键：

- `Cmd/Ctrl+Alt+=` → 一键放大到屏幕 workArea 最大（减 40px 边距）
- `Cmd/Ctrl+Alt+-` → 一键回到默认 520×680

两键各自 toggle：再按一次恢复上次「自定义」尺寸（共享 `preferredSize` 记忆字段）。改完后用户主动触发 `deep-code-review` SKILL,异构对抗 review 跑了 4 轮 × fix 收口,详 [REVIEW_45.md](../reviews/REVIEW_45.md)。

## 变更内容

### `src/main/window.ts`（主战场）

- 新增 `FloatingWindow.toggleMaximize()` / `toggleDefault()` 两个方法 + `applyTargetSize` / `rememberIfCustom` / `isNear` / `centerInDisplay` / `clampPositionInDisplay` 5 个 private helper
- 新增 `preferredSize: { width, height } | null` 字段（in-memory 记忆「自定义」尺寸）+ `lastToggleAt: number` 字段（animate race guard）+ `emitCompactChanged: ((compact: boolean) => void) | null` 回调（compact UI 同步）
- 新增常量 `MIN_WIDTH=380` / `MIN_HEIGHT=260` / `MAX_INSET=40` / `TARGET_TOLERANCE_PX=4` / `ANIMATE_GUARD_MS=300`
- BrowserWindow constructor 加 `minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT`（normal 态底线保护）
- `toggleCompact` 改造：双向 `setMinimumSize`（进 compact 降 COMPACT_HEIGHT / 退 compact 升 MIN_HEIGHT）+ 退 compact 时 lastNormalSize.height clamp 到 MIN_HEIGHT（防 R1 旧路径残留 < 260 值）
- `create()` 末尾复位 4 字段（`compact / preferredSize / lastNormalSize / lastToggleAt`）让 macOS Cmd+W 关窗 + dock activate 重建路径不携带旧瞬态状态

### `src/main/index.ts`

- block 10.6 注册 `CommandOrControl+Alt+=` / `CommandOrControl+Alt+-` 两 globalShortcut 调 `floating.toggleMaximize()` / `toggleDefault()`
- bootstrap line 258 接 `floating.emitCompactChanged = safeSend(IpcEvent.CompactToggled)` 让 toggle 退 compact 时同步 renderer

### `src/shared/ipc-channels.ts` + `src/preload/api/events.ts` + `src/renderer/App.tsx`

- 新增 `IpcEvent.CompactToggled` 通道 + `onCompactToggled` preload subscribe + App.tsx useEffect listener `setCompact(value)` 同步本地 state（避免 toggle 退 compact 后 UI 按钮 label `{compact ? '▢' : '─'}` 与窗口实际尺寸反转）

### `src/renderer/components/settings/sections/WindowSection.tsx`

- 抽 `const mod = IS_DARWIN ? 'Cmd' : 'Ctrl'` 常量去重 4 处
- 透明 toggle 描述下方新增「快捷键速查」短文列出 4 个窗口控制快捷键

### `README.md` — 「键盘快捷键」表

新增 `Cmd+Alt+=` / `Cmd+Alt+-` 两行 + callout「与浏览器自带页面缩放正交」。

## 设计决策

1. **toggle vs 一次性**：选 toggle 与已有 `Cmd+Alt+P/T` 系列一致；用户按错可一键回退而非手动拖窗口边缘。最初版本用「梯度递进 ±60×80」，用户反馈改为「一次最小最大 toggle」。
2. **preferredSize in-memory 不持久化**：尺寸偏好通常是「本次会话临时」语义，长跨度持久化反而误导（重启场景常对应 display / 工作流变化）。注释明示「重启清零」，如未来用户报再走 settings 升级。
3. **键位 `Cmd+Alt+=` / `Cmd+Alt+-`**：与已有 `Cmd+Alt+P/T` 串成「窗口控制」一组；靠 Alt 修饰键与浏览器 `Cmd+=/Cmd+-` 页面缩放正交。Electron accelerator `=` 与 `Plus` 等价（注释加 Plus fallback hint）。
4. **不发 IPC event for 窗口尺寸**：窗口尺寸非 persistent state，BrowserWindow 'resize' DOM 自动响应，无需双端同步。但 `compact` 是 persistent state（影响 UI 按钮 label），toggle* 退 compact 时必须 emit `IpcEvent.CompactToggled` 给 renderer 同步。
5. **`rememberIfCustom` 三层短路设计**：(1) curSize === lastNormalSize 短路（跨屏后用户没拖窗口物理尺寸不变,不污染 preferredSize）+ (2) Date.now() - lastToggleAt < 300ms 短路（macOS setBounds animate 中间帧不污染）+ (3) !atMax && !atDefault 才存（toggle 自身在 max ↔ default 跳变不污染）。三层全过才记录「真正用户拖出来的中间尺寸」。
6. **fallback 撞顶双层保护**：朴素 isNear(fb, target) 排掉等于 target 的 fb + clamp 后再 isNear 一次（fb < target 但 fb > 当前屏 maxW 时 clamp 退化为 target，仍要 fallback 到 alt）。
7. **max 时居中,非 max 保留 x/y 但 clamp 屏内**：max 是 snap 大动作居中合理（且默认 x 靠右创建 + setSize 不改位置会让窗口右边界离屏）；default toggle 是小调整保留位置避免突兀。

## 4 轮 review × fix 历程（详 [REVIEW_45.md](../reviews/REVIEW_45.md)）

- **R1**：HIGH 1（setSize 不改位置离屏 codex 单方现场算术验证）+ MED 4（compact UI 不同步 / preferredSize clamp 死锁双方独立 + R1 fix 自身衍生）+ LOW 2 + INFO 2，N 不可合 → fix 6 文件 280 行
- **R2**：MED 2（minHeight=COMPACT_HEIGHT regression 双方独立 + preferredSize 跨屏污染 claude 单方 + lead focus 4 引导）+ LOW 1 + INFO 2 + 1 follow-up vitest，N 不可合 → fix 5 处
- **R3**：MED 1（create 不复位瞬态状态 codex 单方）+ LOW 1 双方共识（animate race lastToggleAt guard）+ 2 INFO defer → fix 3 处
- **R4**：双方 0 finding **Y 可合 ✅** 收口

**合计**：1 HIGH + 4 MED + 4 LOW + 5 INFO → 7 修 + 2 defer + 1 follow-up plan。

## Defer / Follow-up

- INFO close() dead code（grep 全仓无 caller，defensive 加无害不撤）
- INFO setMinimumSize → setBounds 两段跳（macOS lazy vs eager 行为 *未验证* 需 GUI 实测）
- 非 finding observation：toggleCompact IPC return vs toggleMaximize emit IPC event 双 renderer 同步路径理论 race（< 1ms 同时触发 + IPC reorder，用户再点一次即恢复）
- follow-up plan：vitest 单测覆盖几何状态机（toggle / preferredSize / compact 互动 / 边界 / 撞顶）

## 验证

- `pnpm typecheck` R1/R2/R3 fix 后各跑一次,三次都过（两端 tsc 0 error）
- mental walk-through 全场景跑通：默认起步 / 用户拖 custom / compact 中按 / 多显示器跨屏 / 动画期间连按 / Cmd+W 关窗后 dock activate 重建
- 未跑 vitest（无几何状态机测试,留 follow-up）
- 未跑 dev / 装包实测（用户离开期间 lead 自主决策推进，留用户方便时验证按键是否生效）
