# REVIEW_104 — 主进程启动/关闭子系统（index/ facade）deep-review

> 全项目滚动 deep review **Batch 6**。承接 REVIEW_99（resume-history）/ REVIEW_100（teamless-dm）/ REVIEW_101（codex sdk-bridge）/ REVIEW_102（图片附件）/ REVIEW_103（floating-window）。
> 性质：code deep-review，多轮异构对抗 + 三态裁决。

## scope（5 文件 758 LOC，全 path-level never-reviewed + 零测试）

Phase 4 Step 4.8 facade 拆分后的主进程启动/关闭子系统。子模块新路径不继承拆分前 `index.ts` 的已审状态（与 Batch 3 codex sdk-bridge 拆分 / Batch 5 window 拆分同款盲区）：

| 文件 | LOC | 职责 |
|---|---|---|
| `src/main/index.ts` | 82 | facade：single-instance lock + bootstrappedPromise + lifecycle hooks 注册 |
| `src/main/index/bootstrap-infra.ts` | 298 | Phase 0-8.6 顺序敏感 init（env PATH mutate / initDb / settings / HookServer / adapter register+initAll / setSessionCloseFn / setSessionRenameHookFn / MCP HTTP PRE_LISTEN mount / hookServer.start EADDRINUSE fail-loud / scheduler×3+summarizer / syncAgentDeckSection / universalMessageWatcher / loginItem / bootstrapIpc / loadBundledAssets / reapStaleUploads） |
| `src/main/index/bootstrap-wiring.ts` | 241 | Phase 9-11 wiring（floating.create + safeSend 闭包 + emitCompactChanged + 9 eventBus.on + caller-archive-failed 双通道 try/catch listener + 2 debounced sender + ensureFocusableOnActivate + 4 globalShortcut.register + setImmediate handleCliArgv） |
| `src/main/index/lifecycle-hooks.ts` | 126 | second-instance / window-all-closed / before-quit（cleaningUp guard + globalShortcut.unregisterAll + scheduler/summarizer/watcher stop + race-with-timeout 10s + closeDb 保 WAL checkpoint） |
| `src/main/index/_deps.ts` | 93 | BootstrapState 可变单例 + createInitialBootstrapState factory + makeDebouncedTeamSender 16ms debouncer + TOOL_DISPLAY_NAME 穷举 Record |

**scope 锁定方法学**（复用 Batch 4/5）：expiry 脚本只解析到 REVIEW_65（66-103 共 38 份未进映射 + 老 review base churn 失真）→ 用 `grep -rlF <basename> ref/reviews/` 逐文件精确核验。5 文件 full-path grep 全 `NONE`；basename 命中（REVIEW_68/100/103）全是 **trace-waypoint**（emit→ingest 地标 / stop()-ordering 提及），非系统性 scope 审查；`index/_deps.ts` 零专属命中（纯 basename collision）。

**选批理由**：plan #1 推荐的 adapter 类型契约簇（create-session-opts.ts 等）= 纯 type declaration 0 函数 0 运行时逻辑，BUG 排查 ROI 极低 → 改选 index/ 启停子系统（真 init 顺序 / 退出清理 / race / 共享可变态 = 高 BUG ROI），与 Batch 1-5 mental model 重叠低。

## 过程

R1+R2 双轮异构对抗：reviewer-claude（claude-code adapter，Opus 4.7）`aece95d0` + reviewer-codex（codex-cli adapter，gpt-5.5 xhigh）`019e86c2`，teamId `80ff26a3-ee1d-4517-b80d-6170ae764a95`（已 shutdown）。

lead 全程现场验证不 rubber-stamp：
- **Electron `.d.ts` 类型核验**：before-quit 无 preventDefault → 默认终止；`app.exit()` 不触发 before-quit
- **node sim**（`/tmp/beforequit-sim.mjs`）：before-quit 重构后 normal/throw-sync/reject-async/timeout 四路径 closeDb 全跑
- **node sim**（`/tmp/debounce-sim.mjs`）：makeDebouncedTeamSender dedup + 16ms + trailing-flush CORRECT
- **读码 trace**：enrichWithTeams→findActiveMembershipsBySession→getDb() throw 链；emit 在 lifecycle-scheduler:70 setInterval tick；closeDb 幂等（db.ts:52 null guard）；EADDRINUSE app.exit(1) 不触发 before-quit → 无双 closeDb
- **全仓 grep**：main 端无 `settingsStore.set('windowTransparent')`（透明持久化唯一靠 renderer 往返）；同 hazard 已在 caller-archive-failed + agent-deck-mcp/tools/handlers/spawn.ts:367 加固

**异构对抗高光**：
1. **同一 before-quit 函数的两条侵蚀路径**：reviewer-codex 看「重入无 preventDefault」（MED-A），reviewer-claude 看「cleanupSteps reject 跳过 closeDb」（MED-B）——两条不同路径共同侵蚀同一 WAL-checkpoint 不变量，统一修法一并根治。
2. **claude 与 lead 独立重合**：透明快捷键 stale-read（MED-D）——claude finding 与 lead 预备分析完全重合（双重验证）。
3. **R2 fix 超出原 finding 范围**：reviewer-claude R2 实测确认 MED-B 的 finally 重构不只堵 reject 路径，**同时堵住了同步 stop 步骤抛错路径**（claude R1 原 finding 没覆盖）——review loop 正向价值：fix 比 finding 更全。
4. **双方独立验证「.catch 不吞 process.exit(1) 卡死信号」**：catch 兜快错（fast reject → app.exit(0)）、timeout 兜慢卡（hang → process.exit(1)），正交不遮蔽——claude node sim hang 路径 + codex 读码 trace 两路实证同结论。

## 三态裁决

| # | Finding | 来源 | 裁决 | 验证 |
|---|---|---|---|---|
| **MED-A** | before-quit 重入分支无 `preventDefault()` → cleanup 期间第二次 Cmd+Q 走 Electron 默认终止，截断 in-flight cleanup（shutdownAll/hookServer.stop/closeDb）→ WAL 不 checkpoint | reviewer-codex 单方 | ✅ 真问题 | Electron `.d.ts` 实测：重入 `if(cleaningUp) return` 不拦截；`app.exit(0)` 不触发 before-quit 故最终退出不卡 guard |
| **MED-B** | before-quit `cleanupSteps` reject 路径跳过 closeDb（注释承诺「closeDb 总跑」在 reject 路径不成立） | reviewer-claude 单方 | ✅ 真问题 | node sim Promise.race reject→跳 catch→closeDb skip；当前三步全 guarded 故不可达，但结构契约缝真实（任何人加无 try/catch await 即触发）；R2 claude 复测确认 finally 重构额外堵 sync-throw 路径 |
| **MED-C** | `session-upserted` listener 裸奔，enrichWithTeams DB-throw 冒泡进 timer emit caller（与同文件已加固的 caller-archive-failed listener 不对称） | reviewer-claude 单方 | ✅ 真问题 | getDb() null→throw（db.ts:52）；emit 在 lifecycle-scheduler:70 setInterval tick → listener 抛中断 batch loop + timer 冒泡 uncaughtException；同 hazard 已在 caller-archive-failed + spawn.ts:367 加固 = 不对称裂口 |
| **MED-D** | 透明快捷键（Cmd+Alt+T）读 `settingsStore.get('windowTransparent')` 而非 live state，setWindowTransparentImpl 从不写回 store，renderer 死/快连按时 toggle desync（与 pin 快捷键读 live `w.isAlwaysOnTop()` 不对称） | reviewer-claude 单方 + lead 独立 | ✅ 真问题 | grep 确认 main 端无 settingsStore.set('windowTransparent')，唯一持久化是 renderer 往返（App.tsx:102）；REVIEW_103 L-A 刚修过启动期同型问题，快捷键路径是镜像遗漏 |
| **LOW-E** | `settingsStore.getAll()` 启动期读两次（infra Phase 2 + wiring Phase 9） | 双方（codex INFO + claude LOW） | ✅ 真但 LOW | 同 .then 内无 await 间隙，两次读快照等价无 correctness 问题，纯重复读 |
| **INFO-F** | 启停子系统零测试覆盖（debouncer / TOOL_DISPLAY_NAME / before-quit 四路径） | 双方 | ✅ 接受 | debouncer 逻辑 sim CORRECT；缺 committed test |
| INFO-G | `void reapStaleUploads()` + `setImmediate(handleCliArgv)` fire-and-forget | reviewer-claude | ✅ 安全非缺陷 | 双方+lead 实测内部全 guarded 永不 reject，void 用法正确 |
| INFO-H | window 'closed' 不 null `emitCompactChanged` | reviewer-claude | ✅ 当前无 bug | safeSend 动态读 window getter，recreate 自愈；备忘未来若给 closeImpl 接线需重注入 |
| R2-INFO | bootstrap-infra 文件头 banner 注释残留 `return false` / `返回 boolean` | reviewer-codex R2 非阻塞 | ✅ 已修 | LOW-E 改返回值后漏改顶部 banner（JSDoc+类型已改），同 Batch 5 教训③「fix 后引用同步」 |

**无 HIGH，无需反驳轮**（所有 MED 都已双方共识或单方+现场验证成立）。

## 修复（commits 35541c3 + ced3310）

**`35541c3`（R1 合并修法 + 测试）**：
- **MED-A + MED-B 统一 before-quit 重构**（lifecycle-hooks.ts:64-147）：① 重入分支补 `event.preventDefault()` 挡住 cleanup 期间第二次 quit 的默认终止；② closeDb 移到 `finally` 块开头**无条件**跑（早于 process.exit(1)/app.exit(0)），覆盖 normal/cleanup-throw/reject/timeout 全路径；③ `cleanupSteps.then().catch(()=>'err')` 兜哨兵让 Promise.race 永不 reject。
- **MED-C**（bootstrap-wiring.ts:61）：session-upserted listener 包 try/catch + logger.error 兜底。
- **MED-D**（window.ts 新增 `get windowTransparent()` getter + bootstrap-wiring.ts:200）：透明快捷键读 in-memory SSOT 替代 settingsStore.get，与 pin 读 live 对齐。
- **LOW-E**（index.ts + bootstrap-infra.ts + bootstrap-wiring.ts）：initInfra 返回值 `boolean`→`AppSettings | null`，settings 快照透传 initWiring 省 wiring 段重复读（sentinel false→null，EADDRINUSE 路径返 null defensive 早返回不变）。
- **INFO-F**（新增 index/__tests__/_deps.test.ts 8 test）：makeDebouncedTeamSender debounce 累加/dedup/leading-skip/trailing-flush + createInitialBootstrapState 6 字段+独立对象 + TOOL_DISPLAY_NAME 穷举。

**`ced3310`（R2 follow）**：bootstrap-infra 文件头 banner 注释订正 return boolean→AppSettings|null。

## 收口

**R2 双 reviewer 均明示 conclude + 可合，0 HIGH 0 真 MED 0 新真问题**。
- reviewer-codex R2：0 新 finding，独立复验 before-quit 重构 / PRE_LISTEN 顺序 / EADDRINUSE 双 closeDb 幂等 / PATH mutate 顺序 / exit-code 语义全通过；抓 1 条非阻塞 stale 注释（已修）。
- reviewer-claude R2：0 新真问题，4 个 focus 维度逐项实测（before-quit 三路径 node sim / getter SSOT 跨 recreate / 启动 race 时序 / 测试质量）；确认 MED-B 修法超出原 finding 范围多堵 sync-throw 洞（正向）。

**验证**：dual typecheck（tsconfig.node + tsconfig.web）双绿；全量 vitest **1419 passed | 236 skipped** 零回归（+8 新增 _deps.test.ts）。

## 遗留 follow-up（非阻塞）

- **before-quit 重入路径无独立 timeout**（codex R2 裁定可接受）：重入事件只负责继续挡默认退出，cleanup 永不结束时仍由首轮 `Promise.race(..., 10_000)` timeout 兜底 process.exit(1)。无需独立 timeout。
- **cleanup reject 退 exit code 0**（双方裁定可接受）：cleanup 子步骤本是 warn-only，数据安全关键点 closeDb 已无条件执行；把普通 cleanup reject 升级非 0 退出无明确用户收益。与修前语义一致（原 reject 路径也走 catch→finally app.exit(0)）。
- **其余裸 listener**（session-removed/renamed/summary-added/task-changed/issue-changed/team-*/message-*）：只透传预构造 payload 不触 DB，safeSend 三重 destroyed 守门足够，本轮不包 try/catch（避免过度防御噪音，双方裁定成立）。
- **整子系统 integration test**：initInfra/initWiring/registerLifecycleHooks 的 Phase 时序 / before-quit race-with-timeout 真机路径需 Electron app harness，属 integration（与既有「bootstrap god-function 无 test harness」同款 deferral，lead 已 node sim 补纯逻辑）。
