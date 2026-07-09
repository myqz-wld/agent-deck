# REVIEW_103 — floating-window 子系统 deep-review（R1+R2+R3 三轮异构对抗收口）

> 全项目滚动 deep-review Batch 5。承接 Batch 1（REVIEW_99 resume-history）/ Batch 2（REVIEW_100 teamless-dm）/ Batch 3（REVIEW_101 codex sdk-bridge）/ Batch 4（REVIEW_102 图片附件）。
> commits：`06e3b36`（R1）+ `58b7cc4`（R2 注释订正）+ `d7d72d0`（R2 重设）+ `3da79e0`（R3）。

## 背景与诉求

漂浮主窗口子系统（`main/window/` Phase 4 Step 4.7 facade 拆分产物）全部从未独立 review：facade `window.ts` 上次 REVIEW_61 覆盖后 churn=572（Phase 4 重写，已过期），5 个子模块 `_deps.ts` / `lifecycle.ts` / `sizing.ts` / `pin-visual.ts` / `polish.ts` 拆分后新路径 never-reviewed。零测试。高 bug 面：macOS 单例 recreate（Cmd+W → dock activate）generation guard、全局快捷键跨窗口生命周期常驻（含 null/destroyed window 入口）、setBounds 异步动画 race、100ms invalidate `setInterval` loop。

**Scope（6 文件 828 LOC）**：
| 文件 | LOC | 职责 |
|---|---|---|
| `window.ts` | 100 | facade FloatingWindow class + thin delegate + singleton |
| `window/_deps.ts` | 101→108 | consts + FloatingWindowState interface + createInitialState + icon helpers |
| `window/lifecycle.ts` | 197 | createImpl 建窗 + closeImpl |
| `window/sizing.ts` | 285→370 | toggleCompact / toggleMaximize / toggleDefault + geometry helpers |
| `window/pin-visual.ts` | 100 | setAlwaysOnTop / setWindowTransparent / invalidate loop / kickRepaintAfterPin |
| `window/polish.ts` | 45 | setIgnoreMouse / flash 闪烁动画 |

## 方法

R1+R2+R3 三轮异构对抗：reviewer-claude（claude-code adapter，Opus 4.7）+ reviewer-codex（codex-cli adapter，gpt-5.5 xhigh）in-process SDK teammate + lead 三态裁决。lead 全程现场验证不 rubber-stamp：6 个 node sim 脚本（geometry 全矩阵 / MED-1 pre/post / cross-display shrink+grow / fold-time-capture 9-case / unfold-chain / lastNormalSize animate guard）+ 读码 trace（bootstrap-wiring 调用点 / dock-activate ordering / 'closed' listener 同步清理）+ electron.d.ts 类型核验 + 全仓 grep 调用点。

**方法学复用 Batch 4 修正**：file-level-review-expiry.sh 只解析到 REVIEW_65（66-102 共 37 份未进映射 churn 失真）→ 改 `grep -rlF <basename>` 逐文件精确核验绕过脚本 bug。本批两次自纠中间产物假阳/假阴（regex 漏相对路径形态 → useImageAttachments/archive-plan 误判未审；2-seg key → task 子系统误判未审）后用 basename SSOT 锁定 6 文件全真未审。

## 轮次概览

| 轮次 | reviewer-claude | reviewer-codex | lead 裁决 |
|---|---|---|---|
| R1 | 0H / 1M / 3L / 2I | 0H / 3L / 1I | MED-1 sim 实证修；5 LOW + 测试修；死代码❌不删 |
| R2 | 0H / 1M（fix 自身回归）/ 0L / 2I | 0H / 1M（同一回归）/ 1L / 1*未验证* | 双方独立命中 lead R1 fix 跨屏回归 → 推翻 fromCompact 重设 fold-time capture + alwaysOnTop SSOT |
| R3 | ✅conclude 0H/0M / 1I + 流程提醒 | ✅conclude 0H/0M / 1*未验证* L | LOW（lastNormalSize animate guard）修 + 抽 shouldTrustGetSize 纯函数 |

## R1 finding 三态裁决（全部现场验证）

### ✅ MED-1（fold→toggle 丢自定义尺寸）— claude 单方 + lead node sim 复现
`toggleMaximize`/`toggleDefault` 在 `wasCompact` 时把 `curW/curH` 派生自 `lastNormalSize`（sizing.ts:86-87），与 `rememberIfCustom` 的 REVIEW_45 MED-2「physical==lastNormalSize」短路（sizing.ts:234）叠加成**恒真式**（拿 lastNormalSize 跟自己比）→ `preferredSize` 永不记录。用户「拖到自定义尺寸 → 折叠 → Cmd+Alt+= 最大 → 再按想恢复」拿到 default 520×680 兜底，自定义尺寸丢失。lead `/tmp/med1-verify.mjs` CASE B 复现（CASE A 不折叠正常 / CASE B 折叠后丢失 / CASE C default 不误记）。**R1 修法**（后被 R2 推翻）：rememberIfCustom 加 fromCompact 参数 compact 路径跳过短路。

### ✅ L-A（启动 alwaysOnTop 不对称）— codex#3 + lead 验证
bootstrap-wiring.ts:42 只 `setWindowTransparent(settings)` 不 `setAlwaysOnTop`；createImpl 硬编码 `alwaysOnTop:true`。持久化 `alwaysOnTop=false`（default=true）用户启动时窗口先置顶，靠 App.tsx:54-64 mount effect 异步 `setAlwaysOnTop(settings.alwaysOnTop)` 自愈；renderer/preload 加载失败则永久置顶。**修法**：bootstrap 补 `floating.setAlwaysOnTop(settings.alwaysOnTop)` 与 transparent 对称。

### ✅ L-B（dock-recreate vibrancy 闪跳）— claude 单方
dock-activate 重建 winB 走 createImpl 硬编码 `vibrancy:'under-window'` 无视 `state.windowTransparent` → winB show 时「实玻璃→frosted」闪跳，靠 renderer mount 自愈。**修法**：createImpl 末尾按 `state.windowTransparent` 显式 setVibrancy（R2 进一步把构造 vibrancy 也读 state）。

### ✅ L-C（kickRepaintAfterPin setImmediate 无 generation guard）— codex#1
`setImmediate` 回调重读 `state.win`，若 winA 进 pin 后立刻 close + dock activate 建 winB，回调把 winB content size 改成 winA 旧尺寸 —— 违背 lifecycle.ts createImpl 同款 capturedWin 不变量。**修法**：固定 capturedWin + 回调 `state.win === capturedWin && !isDestroyed` 守门。

### ✅ L-D（timer-slot 无脑置 null）— codex#2（claude 判 fine — lead ordering proof 证伪 live）
`fallbackShowTimer`（lifecycle.ts）+ flash interval（polish.ts）callback 无条件置 `state.X = null`，旧 generation timer 跨 close+recreate 到点会清掉已被 winB 覆盖的新句柄。**lead 裁决**：`getAllWindows()===0` gate（window.ts:96）保证 winA 'closed' 同步清 timerA 先于 winB 创建 → live 不可达，latent-only。但与 generation guard 不变量对齐零成本 → **修**：捕获本轮 handle，仅 `slot === 自己` 时清。

### ✅ L-E（null/isDestroyed 守门不一致）— claude + codex partial
`toggleCompact`/`setAlwaysOnTop`/`setWindowTransparent`/`setIgnoreMouse` 只守 null；`toggleMaximize`/`toggleDefault`/`kickRepaintAfterPin`/`flashImpl` 都守 `isDestroyed`。destroyed-nonnull window 调原生 API 会 throw（'closed' listener 同步置 null 使其几乎不可达）。**修法**：4 入口补 isDestroyed 一致性守门。

### ❌ D-1（close()/flash() 死代码）— 双方命中，lead ❌不删
`FloatingWindow.close()` 与 `.flash()` 全仓零生产调用点。但 **CHANGELOG_4.md:11 明确**：删 notify/visual.ts 的 flash 调用后「`FloatingWindow.flash()` 方法本身**留着不删，备未来主动呼叫的高优场景**」= documented intentional decision。**lead 裁决：不删**（删除违反已记录产品决策 + 「动手前先看清」纪律）→ 注释标注「待接线特性 / 无 IPC face / 接线即可用」，REVIEW_45/61 加固保留。

### ✅ INFO-1（geometry 纯函数零测试）— 双方命中
`isNear`/`centerInDisplay`/`clampPositionInDisplay`/`rememberIfCustom` file-private 0 覆盖，承载 REVIEW_45 多次踩坑点。**修法**：加 `__testExports` + `window-sizing.test.ts`。

### INFO-2（createImpl 无双 create 守护）— claude，latent footgun 记录
createImpl 入口无条件 `state.win = new BrowserWindow`，唯一 recreate 入口有 `getAllWindows()===0` 守门故不触发；未来新 caller 误调即 orphan 旧窗口。记录备查不改。

## R2 — 异构对抗高光：双 reviewer 独立命中 lead 自己 R1 fix 的跨屏回归

### ✅ MED（R1 fromCompact fix 引入跨屏 preferredSize 污染）— 双方独立命中 + lead grow-sim 加深
R1 用 `!fromCompact &&` 把 REVIEW_45 MED-2 跨屏短路在 compact 路径整个禁用，仅 `atMax/atDefault` gate 当 backstop —— 但该 gate **只在同屏有效**。用户「拖到 custom → max → 折叠 → 显示器几何变化（换屏/插拔/改 DPI）→ 展开 max」时，`curW/curH`（旧屏 toggle 尺寸）对新屏既非 max 也非 default → 滑过 gate 被当 custom 记录，**真实自定义尺寸被覆盖销毁** —— 正是 MED-2 当初要防的污染被重新打开。

- reviewer-codex sim：大屏 max 1880×1040 折叠 → 小屏 → 输出 preferredSize 从 {700,500} 变 {1880,1040}（shrink 方向 clobber）
- reviewer-claude sim「CASE E」：pre-fix preferredSize {700,500} 保留 / post-fix {1880,1040} 销毁，pre/post 行为反转确证本 fix 引入
- **lead grow-sim `/tmp/grow-residual.mjs` 加深**：reviewer-codex R2 建议的「clamp 候选撞 max/default 则 skip」兜底**只挡 shrink 不挡 grow**（custom 700×500 在更大屏 3400 宽上既非 max 也非 default → clamp 不改 in-bounds 值 → 仍 clobber）。lead 据此**推翻 fromCompact 路线整体重设**，不在 review loop 里 ship 第三个 partial fix。

**重设修法（fold-time capture，commit d7d72d0）**：
- 根因：unfold→toggle 路径 curW/curH 派生自 lastNormalSize，结构上无法区分「折叠前真实尺寸」与「折叠时正处 toggle 尺寸的 stale」，在那里怎么修都按下葫芦起瓢。
- `rememberIfCustom` **删 fromCompact 参数回退 REVIEW_45 原形**（无条件 physical==lastNormalSize 短路）→ unfold→toggle wasCompact 分支必短路 no-op，跨屏污染面彻底关闭。
- 新增 `captureCustomIfApplicable` + 纯决策 `shouldCaptureCustom`：**折叠瞬间**（toggleCompactImpl 进 compact 分支）用 `state.win.getSize()` 真实物理尺寸按**当前屏** max/default 判 custom 存 preferredSize —— 唯一能拿到「折叠前用户真实尺寸」的时机。
- lead `/tmp/optionX-definitive.mjs` 9-case 全过：MED-1 / CASE E shrink / GROW / CASE C / 跨屏 custom 双向 / animate-guard@fold / latest-custom-wins / fold-at-max 保留 / 无折叠直接 max。

### ✅ R2 LOW（dock-recreate alwaysOnTop 无 SSOT）— codex 单方 + lead 验证
L-A 修了 bootstrap，但 dock-activate recreate 走 createImpl 不经 bootstrap reconcile，`FloatingWindowState` 无 `alwaysOnTop` 字段 → recreate 仍硬编码置顶。**修法**：state 加 `alwaysOnTop` 字段（pin SSOT），setAlwaysOnTopImpl 写入（guard 之前），createImpl 构造 `alwaysOnTop:state.alwaysOnTop` + `setAlwaysOnTop(state.alwaysOnTop, level)` 读 state（双设无冲突 —— 构造器无法指定 'floating'|'normal' level，setAlwaysOnTop 补 level，claude 确认必要非冗余）。create() reset 块不复位 alwaysOnTop/windowTransparent（持久视觉 SSOT 跨 recreate 存活）。

### ✅ R2 *未验证*（compact 动画中间帧）— codex 自标 → lead 收口
toggleCompact 进 compact `getSize()` 在 setBounds animate（~250ms）期间取中间帧 → 折叠/展开恢复中间帧。captureCustomIfApplicable 内置 `ANIMATE_GUARD_MS` 守门一并收口（R3 进一步扩到 lastNormalSize）。

### R2 INFO ×2（claude，非 bug 记录）
启动序列 vibrancy 同值连设 3 次（show:false 期间幂等无可见闪）/ createImpl 'closed' listener 注册在 setAlwaysOnTop 之后（native 不抛错 + createImpl 抛错 app 整体起不来非 leak）。记录备查不改。

## R3 最终确认（双方 both-agree 收口）

### ✅ R3 LOW（lastNormalSize animate 中间帧）— codex *未验证* + lead sim 实证
R2 的 animate guard 只护 preferredSize，但 toggleCompactImpl 仍无条件把 `getSize()` 中间帧写进 `lastNormalSize`（preferredSize 之外另一条恢复路径）→ 展开恢复中间帧。lead `/tmp/r3-lastnormal-guard.mjs` 6-case 实证。**修法**：进 compact 写 lastNormalSize 前过 animate guard，300ms 内沿用既有 lastNormalSize。

### ✅ R3 INFO（animate guard 无测试 + 三处重复）— claude
新 guard 走不到现有纯函数测试 + 与 captureCustomIfApplicable/rememberIfCustom 三处 animate-guard 逻辑重复。**采纳**：抽纯函数 `shouldTrustGetSize(now, lastToggleAt)` 统一三处 + 进 `__testExports` + 2 boundary case（gap 0/100/299 distrust，300/5000/0 trust）。

### 流程（claude 提醒）
R3 LOW fix 一并 commit（3da79e0），让归档 commit 树与 reviewer 工作树一致。reviewer-claude 已 review 该 WIP 并确认逻辑正确。

## lead 额外验证的健壮项（finding 反向证伪储备）

- **geometry 边角**（node sim 实证正确，无 finding）：负坐标左屏 center 不越界 / 极小屏（窗口宽于屏）center floor 到 display.x / clampPos maxX<minX 退化 pin-left / isNear 4px 容差。
- **L-A 启动副作用**（trace 确认无害）：默认 alwaysOnTop=true 时 setAlwaysOnTop 在 show:false window 上 startInvalidateLoop 幂等 + invalidate() 隐藏 window 无害 + 3× setVibrancy 同值幂等。
- **preferredSize 状态机**（`/tmp/statemachine-sim.mjs` + `/tmp/r3-unfold-chain.mjs` 全过）：max↔default↔custom 三态 / 重复 re-max custom 保留 / 跨屏 stale-pref clamp→fallback / fold→unfold→drag-new→fold 新 custom 覆盖 / fold-at-max 不误记。
- **timer / generation guard**（R3 双方复核全闭合）：fallbackShowTimer + flashTimer 跨 close+recreate clearTimeout/clearInterval 兜底正确；loadURL/loadFile 失败（did-fail-load 落日志 + fallback show）+ dock.setIcon（try/catch）已覆盖。

## 验证

- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）每轮绿（R2 typecheck 抓到 makeState 漏 alwaysOnTop 字段，体现 dual-typecheck 守门价值）。
- vitest 全量零回归：R1 1405 → R2 1409 → R3 1411 passed | 236 skipped（+20 window-sizing 测试）。236 skip 是 SQLite binding-gated 测试（BY DESIGN）。
- `window-sizing.test.ts` 20 case：isNear 容差 2 / centerInDisplay 负坐标+极小屏 3 / clampPos 越界+宽于屏 3 / rememberIfCustom 回退原形 + wasCompact 短路 5 / shouldTrustGetSize boundary 2 / shouldCaptureCustom MED-1+CASE-C+max+跨屏双向+容差 5。

## 收口结论

**R1+R2+R3 三轮 both-agree conclude，0 HIGH / 0 真 MED 残留。** 1 MED（fold→toggle 丢自定义尺寸 + 其 R1 fix 引入跨屏回归 → R2 fold-time capture 重设根除）+ 6 LOW（L-A~L-E + R3 lastNormalSize guard）+ 6 INFO（INFO-1 测试补 / D-1 死代码注释 / 其余记录）全处理。

**异构对抗教科书 case**：
1. R1 reviewer-claude 独立命中 MED-1（codex 未见）。
2. **R2 双 reviewer 独立命中 lead 自己 R1 fix 的跨屏回归** —— review loop 抓 lead 不完整 fix 的核心价值。
3. **lead grow-sim 进一步发现 reviewer-codex R2 建议的 clamp 兜底也只挡 shrink 不挡 grow** → 推翻整条路线重设，避免 ship 第三个 partial fix（lead 不盲从单个 reviewer 建议，自己 sim 验证到底）。
4. fold-time capture 重设把 custom 判定从「unfold 派生 stale」结构性盲区挪到「折叠瞬间真实尺寸 + 当前屏几何」，根除而非缝补。

**遗留 follow-up（非阻塞，记录备查）**：
- D-1 死代码 close()/flash() 待接线（CHANGELOG_4 intentional retained，未来主动呼叫场景接 IPC）。
- INFO-2 createImpl 无双-create 守护（latent footgun，当前唯一 recreate 入口有 getAllWindows gate 不触发）。
- toggleCompactImpl 含 getSize/getBounds 依赖真实 BrowserWindow，integration 行为（fold-time capture 真机时序 / animate guard 真机中间帧）无 committed test，与既有「toggleImpl 不 unit test 只测纯 helper」模式一致，非新欠债。
