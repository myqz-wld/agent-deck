# REVIEW_45 — 窗口尺寸快捷键 toggle 4 轮异构对抗 review × fix 收口

## 触发场景

用户要求加快捷键放大/缩小窗口，初次设计为「梯度递进 ±60×80」，用户反馈改为「一次最小最大 toggle」，refactor 后用户主动触发 `deep-code-review` SKILL 对 CHANGELOG_124 5 文件改动做异构对抗 review。

## 方法

- 走应用 `agent-deck:deep-code-review` SKILL teammate 模式
- 一对 reviewer（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 high）跨 R1-R4 复用同对（in-memory state 跨轮持久化）
- 4 轮 review × fix 闭环：R1 全量扫 → 修 → R2 复审 → 修 → R3 收口轮 → 修 → R4 最终收口
- `heterogeneous_dual_completed: true`（除 R1 reviewer-codex xhigh 卡 25min 降 high 跑通,后续轮次 high 一次出结果）

## 范围

- 3 个代码文件（R1 scope）：`src/main/window.ts` / `src/main/index.ts` / `src/renderer/components/settings/sections/WindowSection.tsx`
- R1 fix 引入 IPC channel 后 scope 扩到 6 文件：+`src/shared/ipc-channels.ts` + `src/preload/api/events.ts` + `src/renderer/App.tsx`

## 三态裁决（4 轮汇总）

### R1（HIGH 1 / MED 4 / LOW 2 / INFO 2，N 不可合）

| Finding | 来源 | 裁决 | 验证 |
|---|---|---|---|
| toggleMaximize/setSize 不改位置 → 窗口右边界离屏 | codex HIGH-1 单方 | ✅ **HIGH** 必修 | 现场算术：default x=display.x+display.width-520-20=900（1440 屏），maxW=1400 → 右边界 2300 > 1440 离屏 860px |
| compact UI 不同步 renderer（toggle* 改 this.compact 不 emit） | claude MED-1 + codex MED-2 双方独立 | ✅ **MED** 必修 | grep App.tsx:40 本地 state + `CompactToggled` channel 全无 |
| preferredSize clamp 死锁（fb !isNear 但 clamp 后 == max） | claude MED-2 + codex MED-1 双方独立 | ✅ **MED** 必修 | 数学推演：fb={2400,1500} 在 1880×1040 display，clamp 后 nextW=1880=maxW → atMax 仍 true 死循环 |
| BrowserWindow 无 minWidth/minHeight | codex LOW-1 单方 | ✅ **LOW** 顺手修 | 现场 Read window.ts constructor 无 min 字段 |
| preferredSize 不持久化 | claude LOW-1 单方 | ❓ product call | 选 in-memory + 注释明示 |
| 多余空行 / IS_DARWIN 抽常量 | claude INFO×2 | ✅ trivial 顺手清 | — |
| accelerator '=' 跨平台 | 双方 *未验证* | ❓ | 注释加 `Plus` fallback hint |

R1 fix：6 文件 280 行 net+ in-place（uncommitted），typecheck 通过。

### R2（HIGH 0 / MED 2 / LOW 1 / INFO 2，N 不可合）

| Finding | 来源 | 裁决 | 验证 |
|---|---|---|---|
| minHeight=COMPACT_HEIGHT 让 normal 态可手动拖 < MIN_HEIGHT（R1 LOW-1 regression）+ toggleCompact 展开 lastNormalSize 不 clamp | claude MED-1 + codex MED-1 双方独立 | ✅ **MED** 必修（R1 fix 自身 regression） | 现场 Read constructor minHeight + toggleCompact line 222 直接 getSize 不 clamp |
| preferredSize 跨屏被覆写污染（rememberIfCustom 无 lastNormalSize 短路） + 附挂 LOW macOS animate race | claude MED-2 单方（lead R2 prompt focus 4 引导） | ✅ **MED** 必修（修法 a 短路） | 数学 trace 6 步：跨屏后窗口物理尺寸 == 旧 max，被 rememberIfCustom 当 custom 存进 preferredSize |
| emitCompactChanged 字段位置怪异 + close() 漏清理 | claude LOW 单方 | ✅ **LOW** 顺手修 | 现场 Read 字段紧贴 setIgnoreMouse 无空行 + close 不清 |
| centerInDisplay/clampPositionInDisplay 极小屏 / 负 workArea 跑出屏 | claude INFO-1 + codex LOW-1 双方 | ✅ **LOW** 顺手修 | 算术：display.width=300 时 maxW=380，centerX = display.x - 40 越界 |
| 9 行 setBounds 后处理重复 | claude INFO-2 单方 | ✅ INFO 顺手抽 helper | diff 两处 line 301-309 / 364-369 完全相同 |
| 0 unit test | claude 总结 + codex LOW-2 双方 | ❓ follow-up | 留 plan 不本 PR 补 |

R2 fix：5 处改动 in-place，typecheck 通过。

### R3（HIGH 0 / MED 1 + LOW 1 必修 + 2 INFO defer）

| Finding | 来源 | 裁决 | 验证 |
|---|---|---|---|
| create() 不复位瞬态状态 + close 清 emitter 永久丢失 | codex MED-2 单方 + 现场验证 | ✅ **MED** 必修 | grep close() 无 caller 但 BrowserWindow 内置 close path 真存在（用户 macOS Cmd+W 关窗 → dock activate 触发 ensureFocusableOnActivate 重建 → this.compact/preferredSize 仍是旧值） |
| animate race 污染 preferredSize（setBounds animate=true 中间帧绕过 lastNormalSize 短路） | claude LOW（R2 已附挂）+ codex MED-1 R3 升级 | ✅ **LOW**（取较低估更准）必修（lastToggleAt timestamp guard） | 数学：用户 250ms 内连按，getSize 取动画中间帧 1200×850 ≠ lastNormalSize 1880×1040 → 绕短路 → preferred 被污染 |
| close() dead code | claude INFO-1 单方 | ⏭️ defer | claude 自己证伪 R2 LOW 必要性，defensive 加无害 |
| setMinimumSize → setBounds 两段跳 | claude INFO-2 *未验证* | ⏭️ defer | 需 GUI 实测 macOS Electron 33 eager vs lazy 行为 |

R3 fix：3 处改动 in-place（class field + rememberIfCustom guard + create reset），typecheck 通过。

### R4（双方 0 finding，Y 可合 ✅）

- reviewer-claude：R3 fix 4 处全部 mental trace 通过，回答 lead focus 1 四个具体问题（Date.now vs performance.now / 300ms 覆盖动画 / guard 不误伤真拖 / 4 字段 reset 完整）；唯一非 finding 观察：toggleCompact IPC return vs toggleMaximize emit IPC event 双 renderer 同步路径并存有理论 race（< 1ms 同时触发 + IPC reorder），非 R3 引入，挂 follow-up
- reviewer-codex：未发现 R4 regression。lastToggleAt guard 不误伤真拖 / create() 4 字段 reset 完备 / Date.now vs performance.now 系统时钟跳不构成阻塞 / 300ms 覆盖 macOS animate

**R1-R4 4 轮闭环**：HIGH 1 / MED 4 / LOW 4 / INFO 5 → **7 修 + 2 defer + 1 follow-up plan**。

## 主要 fix（按修法分组）

### `src/main/window.ts`（主战场）

| 修法 | 位置 | 来源 |
|---|---|---|
| setSize → setBounds + centerInDisplay/clampPositionInDisplay 两 helper（max 时居中,非 max 时保留 x/y 但 clamp 屏内） | toggleMaximize / toggleDefault + 2 private helper | R1 HIGH-1 codex |
| fallback clamp 后再 isNear 一次,撞顶则走 alt fallback（max ↔ default）防 stale preferredSize 死锁 | toggleMaximize / toggleDefault 中段 | R1 MED-2 双方 |
| BrowserWindow constructor minWidth/minHeight + toggleCompact 双向 setMinimumSize（进 compact 降 COMPACT_HEIGHT / 退 compact 升 MIN_HEIGHT + lastNormalSize clamp 到 MIN_HEIGHT） | constructor + toggleCompact + toggleMaximize/Default 退 compact 路径 | R1 LOW-1 codex + R2 MED-1 双方（regression） |
| rememberIfCustom 入口加 lastNormalSize 短路（防跨屏污染）+ lastToggleAt timestamp guard（防 animate race） | rememberIfCustom + class field + applyTargetSize 末尾写 | R2 MED-2 claude + R3 LOW claude+codex |
| centerInDisplay / clampPositionInDisplay 加 Math.max 兜底防负坐标 | 2 private helper | R2 LOW 双方 |
| applyTargetSize private helper 抽出消 9 行重复 | 新 helper + toggleMaximize/Default 调用 | R2 INFO claude |
| emitCompactChanged 字段挪 class field 区 + close() 加 = null + create() 末尾复位 4 字段（compact/preferredSize/lastNormalSize/lastToggleAt） | class field 区 + close + create | R2 LOW claude + R3 MED codex |

### `src/main/index.ts`

| 修法 | 位置 | 来源 |
|---|---|---|
| block 10.6 注册 Cmd+Alt+= / Cmd+Alt+- globalShortcut 调 toggleMaximize/toggleDefault | line 413-432 | CHANGELOG_124 主体（被 review） |
| bootstrap 接 floating.emitCompactChanged = safeSend(IpcEvent.CompactToggled) | line 258 | R1 MED-1 双方 |
| accelerator '=' 注释加 'Plus' fallback hint + unregisterAll 收尾说明 | block 10.6 注释 | R1 INFO *未验证* |

### `src/shared/ipc-channels.ts` + `src/preload/api/events.ts` + `src/renderer/App.tsx`

| 修法 | 位置 | 来源 |
|---|---|---|
| 新增 `IpcEvent.CompactToggled` 通道 | ipc-channels.ts | R1 MED-1 双方 |
| 新增 `onCompactToggled` preload subscribe | events.ts | R1 MED-1 双方 |
| App.tsx useEffect listener 调 setCompact 同步本地 state | App.tsx | R1 MED-1 双方 |

### `src/renderer/components/settings/sections/WindowSection.tsx`

| 修法 | 位置 | 来源 |
|---|---|---|
| 抽 `const mod = IS_DARWIN ? 'Cmd' : 'Ctrl'` 常量去重 4 处 | line 22 | R1 INFO-2 claude |
| 加快捷键速查行 + JSDoc 加 CHANGELOG_124 注 | line 26 + JSDoc | CHANGELOG_124 主体 |

## Defer / Follow-up

| 项 | 严重度 | 来源 | 处理 |
|---|---|---|---|
| close() dead code（grep 全仓无 caller） | R3 INFO claude | defensive 加无害不撤 |
| setMinimumSize → setBounds 两段跳（macOS lazy vs eager） | R3 INFO *未验证* claude | 需 GUI 实测,如真撞挪 setMinimumSize 到 setBounds 之后 |
| toggleCompact IPC return vs toggleMaximize emit IPC event 双路径理论 race | R4 非 finding observation claude | 极极低概率（< 1ms 同时触发 + IPC reorder），用户再点一次按钮即恢复，挂 vitest follow-up |
| vitest 单测覆盖几何状态机（toggle / preferredSize / compact 互动 / 边界 / 撞顶） | R2 LOW codex + R3 总结 claude | 留 follow-up plan,本 PR 不补 |
| preferredSize 持久化到 settings.json | R1 LOW claude product call | 选 in-memory + 注释明示「重启清零」,如未来用户报再升级 |

## 验证

- `pnpm typecheck` R1/R2/R3 fix 后各跑一次，三次都过（两端 tsc 0 error）
- mental walk-through 全场景跑通：默认起步 / 用户拖 custom / compact 中按 / 多显示器跨屏 / 动画期间连按 / Cmd+W 关窗后 dock activate 重建
- 未跑 vitest（无几何状态机测试，留 follow-up）
- 未跑 dev / 装包实测（用户离开期间 lead 自主决策，留用户方便时验证）

## 关联

- CHANGELOG_124 — 主体功能改动（被 review）
- 用户原始请求：「增加一个快捷键快速放大/缩小窗口」+ 反馈「不是递进的，一次最小最大这种」+ 触发「deep code review 下改动」
