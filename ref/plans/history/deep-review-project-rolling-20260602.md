# Deep-review-project (全项目 BUG 排查 + 优化) — 接力状态

> **status: maintenance-mode**（自 2026-06-02，Batch 11 收口后由 user 决策切到 B1 模式）。
> 本文件是「deep review 全项目」任务的跨会话接力载体。用户要求：deep review 全项目、BUG 排查 + 代码优化、自主推进 + 自主 hand off。
> 性质：滚动 review 任务（非代码 plan / 非 worktree）。每批走 `agent-deck:deep-review` SKILL 多轮异构对抗。

## 🛠 Maintenance 模式（自 Batch 11 收口后生效）

**任务到达维护期高点**：Batch 1-11 = 11 批主逻辑 + 4 批 simple-review 收尾 = **15 批 × ~100 个真修**全部收口。高 ROI main 逻辑 + 9c67c120 follow-up 100% 关闭。git ahead origin/main **31 commits**。

**B1 模式**（被动 file-level expiry 驱动增量重审）—— **不再主动找未审面**，改为「churn 触发过期 → 重审」：
- 触发机制：净 churn ≥ min(200 行, LOC 30%) / distinct commits ≥ 3 / 距上次 review ≥ 90 天 + 期间有变更 → 过期
- 决策权在 user：日常不主动跑 review；user 想 review 时**先 `bash "/Applications/Agent Deck.app/Contents/Resources/SOPs/file-level-review-expiry.sh"` 重算过期**，按结果选批走 deep-review / simple-review
- 切 B1 理由：本项目 churn 高（2 周 316 commits）但 B2 周期性 cron 容易在「无过期面」时制造噪音空跑；B1 把决策权完全交给 user
- 与 B2 差异：周期性 cron vs 手动触发

**未来会话 cold-start 协议**（plan §复杂 plan workflow §Step 3 选项 A 同款）：
1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-review-project-rolling-20260602.md` 读 plan
2. 检顶部 status 字段：`maintenance-mode` → 走 B1 模式；其他值走对应模式
3. user 决定 review → 跑 expiry 脚本 + 按结果选批
4. user 决定不开 review → 任务结束等下次

**剩余 follow-up**（已记 issue tracker，由 user 单独处理，本 plan 不再追）：
1. issue 18041912 Signal 1 shutdown race（REVIEW_104 加固区裂口）
2. CHANGELOG_<X> 占位符全局 55 处同款（REVIEW_109 INFO 升级）
3. handler 级测试覆盖（adapters + preload/api）

## 总目标

成熟项目（98+ review）的「全项目 deep review」= 按 **churn / recency / file-level-review-expiry** 锁定**最新未 review / 已过期**代码，分批多轮异构对抗 review + fix 收口。不是一次性扫 61K LOC，是按风险域分批。

## 已完成 / 进行中

> **下一会话第一步**（cold-start）：本任务是滚动 review，无 worktree（直接在 repo root `/Users/apple/Repository/personal/agent-deck` 干活，commit 直接上 main —— 与 Batch 1-9 同款约定）。Batch 1（REVIEW_99）+ Batch 2（REVIEW_100）+ Batch 3（REVIEW_101）+ Batch 4（REVIEW_102 图片附件）+ Batch 5（REVIEW_103 floating-window）+ Batch 6（REVIEW_104 主进程启停子系统 index/ facade）+ Batch 7（REVIEW_105 adapter spawn-options）+ Batch 8（REVIEW_106 task-repo 持久层）+ Batch 9（REVIEW_107 renderer settings/TeamDetail UI 簇，commit ad0fd5e）已收口。**继续 Batch 10**（plan §Batch 10 候选 — 高 ROI main 逻辑已基本覆盖，剩长尾，**优先考虑是否还值得 deep-review** 或转 file-level expiry 常态化增量重审）：①`bash "/Applications/Agent Deck.app/Contents/Resources/SOPs/file-level-review-expiry.sh"` 重算过期 + `git log --oneline -15` 看最新改动 ②**关键方法学**（Batch 4-9 反复踩实，见 §方法学铁律）：expiry 脚本只解析到 REVIEW_65 → **必用 `grep -rlF <basename> ref/reviews/` 逐文件精确核验**，fp:NONE 才是真未审金标准；basename 命中逐个 spot-check 区分 scope-review vs trace-waypoint vs 同名不同文件；**选批先 grep -cE "function|=>" 看函数密度 + spot-check 函数体真 logic**（Batch 8 教训⑦：facade/thin-wrapper fn 密度失真走轻量 simple-review）；**renderer 组件选批必 grep importer / 挂载点确认非 dead code**（Batch 9 教训⑩：fp:NONE 只证未被 review 不证用户路径可达，CodexMcpServersSection 是 fp:NONE 真未审但意图性 dead UI）③`invoke agent-deck:deep-review`（typed args `{kind:'code', paths:[绝对路径]}`）④按 §方法备忘 + §关键踩坑 走。**纪律**：lead 必现场验证不 rubber-stamp（Node sim / 读码 trace / git 考古 / 类型链 trace / 反向验证守门 / web 规范 / electron.d.ts 类型核验 / sqlite3 CLI repro / **grep importer 查可达性**）/ 单方 HIGH 走反驳轮 / 单方 MED lead 自验 / 收口需双 reviewer 都明示 conclude + 0 HIGH/MED / fix 后 typecheck 双配置 + vitest 再 commit / 进度变更先告诉用户。**reviewer 卡死处理**：~28-30min 卡死线（按 lastEventAt 判）shutdown + 重 spawn 重跑 Round 1（合规兜底仍异构）。**Batch 8-9 教训**：⑦ facade/thin-wrapper fn 密度失真选批要 spot-check 函数体 ⑧ 持久层 vs handler 批分清 ⑨ 复发主题（same-ms tie-breaker）穿透全子系统选批主动 grep 历史先例锁漏网 ⑩ **fp:NONE ≠ 用户路径可达 → renderer 组件选批必 grep importer/挂载点，零 importer 直接 git 考古查是否意图性 dead UI（dead UI 不进 deep-review）**。

### ✅ Batch 1 — resume-history 历史注入特性（commits 0d94640→7a5c75a，~1563 行）— **R1→R4 四轮收口完成**
- **REVIEW_99**（`ref/reviews/REVIEW_99.md`）：R1→R4 四轮异构对抗 + 反驳轮，reviewer-claude(Opus4.7) `3508acbc` + reviewer-codex(gpt-5.5) `019e8451`，teamId `591cd6f2-495c-43d4-ada4-c25c75815890`。
- **已修 + commit**：`92d711c`（R1：clamp + raw-continue + maxEventId ?? 0）/ `88fec9b`（R2：close-during-await transition-abort + summary-only fit 重判）/ **R4 cancellation-epoch 收口**（本会话 commit）。
- **R3→R4 carry-forward 收口（cancellation-epoch）**：R3 reviewer-codex 抓出 R2 transition-check fix 本身 2 洞（wasClosed 基线漏「恢复期间第二次 close」HIGH + post-guard 窗口 MED，lead 验真）→ R4 改 cancellation-epoch 方案：
  - `closeImpl`(adapter close 前) / `markClosedImpl`(transition guard 后) / `deleteImpl`(起点) 自增 `closeEpoch` 计数器（`manager/_deps.ts` + `manager/lifecycle.ts`）。
  - recover 入口 emit user message **之后**捕获 `closeEpochBaseline`（codex 第 1 点）；`cancelGuard = !record || getCloseEpoch !== baseline` 替代旧 `closed && !wasClosed` lifecycle 快照。
  - MED 收口：`cancelCheck` thunk 贯穿 createSession，pre-registration await 后 + sessions.set 前二次检查 → throw `RecoveryCancelledError` sentinel。
  - **lead 2 增量自发现**：① sentinel-throw 偏离 codex union 建议（recovering Map 与 restart-controller 共享 Promise<string>，union 会破坏交叉 await）② scheduler 第四入口 gap（batchSetLifecycle/batchDelete 绕过 markClosed/delete → 加 facade bumpCloseEpoch/forgetCloseEpoch + scheduler 显式调）。
  - **R4 both-agree 收口**：reviewer-claude + reviewer-codex 均明示 conclude + 可合，0 HIGH 0 真 MED 0 新增行为 finding。claude 5-scenario 时序脚本 + 115 tests 实跑；codex 读码 trace + 69 tests 实跑。lead 全套 1351 tests + typecheck 双绿。
  - **遗留 INFO（follow-up）**：`json_valid` guard 缺失（listRecentMessages / findLatestAssistantMessage / hasToolUseStartWithFilePath 三处 `json_extract` 无 `json_valid` 前置 guard）。既有 codebase 范式（非本特性引入）+ 不破坏永不阻塞。建议单开小 plan 统一加固。

### ✅ Batch 2 — teamless-dm 特性 + universal-message-watcher 跨 adapter 投递引擎（commit 3a18030 / CHANGELOG_194）— **R1+R2 双轮收口完成**
- **REVIEW_100**（`ref/reviews/REVIEW_100.md`）：R1+R2 双轮异构对抗，reviewer-claude(Opus4.7) `d753622d` + reviewer-codex(gpt-5.5) `019e84f0`，teamId `39cc3570-4acc-46c2-b216-6b43fa16456e`（已 shutdown）。
- **已修 + commit**：`15b0080`（R1 LOW shutdown reschedule race —— stop() 不清 rescheduleAfterCurrent + finally 无 running guard → 加 running 闸门）/ `73b6cbb`（R2 LOW process() 入口缺 stopped guard，15b0080 只 gate finally 调度点拦不住已 queued 的 setImmediate callback → 入口加 `if(!running) return` 执行点 gate；codex 单方 + claude 独立同款发现 = review loop 抓 lead 自身不完整 fix 的价值）/ `2761a1b`（REVIEW_100 + INDEX）。
- **headline risk v027 自引用 FK migration**：双方独立 sqlite3 CLI 实证 rename-old-first 保 reply chain（含朴素重建 DROP old 触发 ON DELETE SET NULL 静默 null + foreign_key_check 反 PASS 反例复刻）。wire format 注入（claude mock 实测）不可利用。
- **R2 both-agree 收口**：双 reviewer 均明示 conclude + 可合，0 HIGH 0 真 MED。1354 tests + typecheck 双绿。
- **遗留 follow-up（issue `7dcb0676`）**：teamless 放大 agent_deck_messages 表无界增长 + listBySession 全表扫描尾延迟（pre-existing 全表性质，teamless 仅边际放大；需独立 retention/index plan，不阻塞收口）。

### ✅ Batch 3 — codex-cli sdk-bridge 断连恢复 / 重启 / 回滚时序链（REVIEW_101，commits 3511d96 + f9dbb0c + e10ff40）— **R1+R2 双轮收口完成**
- **scope（10 文件 1911 LOC）**：`src/main/adapters/codex-cli/sdk-bridge/` 下 `recoverer/recover-and-send-impl.ts`(465) + `recoverer/_deps.ts`(169) + `recoverer/jsonl-discovery.ts`(126) + `recoverer.ts`(184 facade) + `restart-controller.ts`(201) + `resume-path-await.ts`(194) + `codex-jsonl-fallback.ts`(255) + `codex-recoverer-messages.ts`(106) + `session-finalize.ts`(112) + `create-session-rollback.ts`(99)。9/10 精确路径 never-reviewed（Phase4 facade 拆分后子模块新路径不继承已审），Batch 1 resume-history 的 codex 侧姊妹盲区。
- **REVIEW_101**：R1+R2 双轮异构对抗 + 反驳轮，reviewer-claude(Opus4.7) `2eccd1df` + reviewer-codex(gpt-5.5) `019e8520`，teamId `ffda4055-0488-49e1-922c-5a613807f516`（已 shutdown）。
- **异构对抗高光**：双方从不同侧面命中**同一文件 restart-controller 同一薄弱点**（codex restart 没迁移 claude/recover 对称能力）—— reviewer-codex 看 cancel-guard 缺失(HIGH)，reviewer-claude 看 jsonl-fallback 缺失(MED)。
- **反驳轮双方共识**：cancel-guard **HIGH→降 MED**（claude restart 也缺，cancel-epoch 是 recover 专属，两端 restart pre-existing 共缺非 codex-only regression + 窗口秒级 + 可自愈）。reviewer-claude acknowledge R1 漏审升级 mental model（cancellation-epoch 对称必须三维穷举 recover×{claude,codex}+restart×{claude,codex}）。三 MED 合并修法。
- **lead 增量裁决**：现场 trace 修正 reviewer-codex「restart closeSession bump epoch」理由偏差 —— codex adapter 层 closeSession（index.ts:425-472）不 bump epoch（只 sessionManager.close/markClosed/delete 才 bump）→ baseline 前后捕获等价。reviewer-codex R2 认可。
- **合并修法（commit 3511d96）**：RestartCtx 补 4 thunk + RestartCreateOpts 补 resumeMode/model/extraAllowWrite/cancelCheck + restartWithCodexSandbox 接入 maybeCodexJsonlFallback（jsonl 缺走 fresh-cli-reuse-app + 历史注入）+ cancel-guard（closeEpochBaseline + cancelGuard + sentinel special-case）+ model 透传 + 3 回归测试（restart 路径修前 0 覆盖）。
- **R2 INFO 强化（commit f9dbb0c）**：INFO-A baseline 移到 closeSession 之前（消 microtask 漏判窗口 + 语义对齐 recover）+ INFO-B fall-through 注释订正。
- **R2 both-agree 收口**：双 reviewer 均明示 conclude + 可合，0 HIGH 0 真 MED。typecheck 双配置 + 全项目 1357 passed + 236 skipped 零回归。
- **遗留 follow-up**：issue `30ca35a9`（codex recover 重建丢 reviewer spawn-time network/dirs defaults，recover-only MED，需独立 plan migration v028 + 5 层）/ codex restart fallback handoffPrompt 不显示 user bubble + claude restart 缺 cancel-guard（建议合并「restart 路径 codex/claude parity 收尾」issue）/ R1 三 INFO（facade re-export 不全 / DB 同值双写 / IIFE finally 理论窗口）。

### ✅ Batch 4 — 图片附件子系统（REVIEW_102，commits 7d05d67 + 486386b）— **R1+R2+R3 三轮收口完成**
- **scope（8 文件 ~1228 LOC）**：`renderer/hooks/useImageAttachments.ts`(467) + `main/store/image-uploads.ts`(261) + `renderer/hooks/useImageBlob.ts`(88) + `renderer/lib/image-blob-cache.ts`(19) + `renderer/components/ImageLightbox.tsx`(91) + `UploadedImageThumb.tsx`(91) + `main/ipc/_image-constants.ts`(71) + `main/ipc/adapters.ts`(430)。几乎全未审（仅 ipc/images.ts 极早期 REVIEW_18 churn=0）。全新风险面（上传持久化 + blob URL 内存 + 粘贴/拖放并发 race + IPC TOCTOU），与 Batch 1/2/3 mental model 重叠低。
- **方法学修正**：file-level-review-expiry.sh 只解析到 REVIEW_65（66-101 共 36 份未进映射 + 老 review base 全 fallback 初始 commit churn 失真）→ 脚本版「已审」严重低估，改用 `grep -rlF <file> ref/reviews/` 逐文件精确核验绕过脚本 bug。issue UI 三件套（REVIEW_67/69/70 等 2-3 天前刚审 churn≈0）确认排除。**下批必复用此法**。
- **REVIEW_102**：R1+R2+R3 三轮异构对抗，reviewer-claude(Opus4.7) + reviewer-codex(gpt-5.5) `019e855b`，teamId `894e7802`（已 shutdown）。
- **异构对抗高光**：① reviewer-claude 独立命中 generationRef race（lead 预备分析也命中但 claude 推理「复活不可达」更深：id 在 await 后才生成，in-flight 图无 id 用户点不到删）② 双方独立命中缩略图全图 cache 失控（强冗余）。
- **reviewer-claude 首实例卡死**：有 event 但两次收口 nudge 后始终不产 reply，~28min 卡死线 → shutdown + 重 spawn 重跑 Round 1（合规兜底仍异构，未降级同源双 codex）。
- **已修 + commit**：`7d05d67`（R1 合并修法 + 30 测试）+ `486386b`（R2 preflight + 4 集成测试）。0 HIGH / 3 MED（generationRef race / cache 字节预算 128MB / animated webp VP8X 检测）+ 3 LOW（loader 永久 loading / cache FIFO→LRU / R2 webp 被拒 thumbnail）+ 4 INFO 全 fix。
- **R3 both-agree 收口**：双 reviewer 三轮全程 conclude，0 HIGH 0 MED。typecheck 双配置 + 全量 vitest 1391 passed / 236 skipped 零回归（补 34 回归测试）。
- **遗留 follow-up**：① 缩略图彻底修法（落盘 sidecar 缩略图 / IPC maxDim 降采样，本轮只做 cache 字节预算短期止血）② hook 异步 race committed test（issue `6f86ac86`，需引入 jsdom + @testing-library 测试环境）。

### ✅ Batch 5 — floating-window 子系统（REVIEW_103，commits 06e3b36 + d7d72d0 + 58b7cc4 + 3da79e0）— **R1+R2+R3 三轮收口完成**
- **scope（6 文件 828 LOC）**：`main/window.ts`(100 facade，churn=572 自 REVIEW_61 过期) + `window/_deps.ts`(108) + `window/lifecycle.ts`(197) + `window/sizing.ts`(370) + `window/pin-visual.ts`(100) + `window/polish.ts`(45)。Phase 4 Step 4.7 facade 拆分后子模块全 never-reviewed，零测试。与 Batch 1-4（session/message/recovery/image）mental model 重叠低。
- **REVIEW_103**：R1+R2+R3 三轮异构对抗，reviewer-claude(Opus4.7) `05d993a1` + reviewer-codex(gpt-5.5) `019e8669`，teamId `608cda55`（已 shutdown）。
- **MED-1 ✅**（claude 单方 + lead `/tmp/med1-verify.mjs` CASE B 复现）fold→toggle 丢自定义尺寸：wasCompact 派生 curW/curH==lastNormalSize 与 rememberIfCustom MED-2 短路叠加成恒真式 → preferredSize 永不记录。
- **异构对抗教科书 case**：**R2 双 reviewer 独立命中 lead 自己 R1 fromCompact fix 引入的跨屏回归**（关短路后 atMax/atDefault gate 只同屏有效，换屏旧 toggle 尺寸误记 custom 覆盖真实偏好；codex shrink sim + claude CASE E pre/post 反转双实证）→ **lead grow-sim 进一步发现 codex 建议的 clamp 兜底也只挡 shrink 不挡 grow** → 推翻 fromCompact 路线**重设 fold-time capture**（rememberIfCustom 回退 REVIEW_45 原形 + 折叠瞬间 getSize 真实物理尺寸按当前屏判 custom；lead `/tmp/optionX-definitive.mjs` 9-case 全过根除跨屏盲区）。
- **已修 + commit**：`06e3b36`（R1：MED-1 + L-A 启动 alwaysOnTop 对称 + L-B dock-recreate vibrancy + L-C kickRepaint generation guard + L-D timer-slot handle 捕获 + L-E isDestroyed 守门一致 + INFO-1 geometry 测试）/ `d7d72d0`（R2 重设：fold-time capture + alwaysOnTop SSOT state 字段 + compact animate guard）/ `58b7cc4`（R2 注释订正）/ `3da79e0`（R3：lastNormalSize animate guard + 抽 shouldTrustGetSize 纯函数统一三处 + 测试）。
- **R3 both-agree 收口**：双 reviewer 均明示 conclude + 可合，0 HIGH 0 真 MED。claude 15-case sim 复核重设无新回归；codex 同意重设 + 1 非阻塞 *未验证* LOW（已修）。typecheck 双配置 + 全量 1411 passed | 236 skipped（+20 window-sizing 测试）零回归。
- **D-1 ❌不删**：close()/flash() 死代码但 CHANGELOG_4 明确 flash「留着备未来主动呼叫」documented intentional → 注释标注不删（动手前先看清纪律）。
- **遗留 follow-up（非阻塞）**：① close()/flash() 待接线（CHANGELOG_4 intentional，未来主动呼叫接 IPC）② createImpl 无双-create 守护 latent footgun（当前唯一 recreate 入口有 getAllWindows gate 不触发）③ toggleCompactImpl 含 getSize/getBounds 依赖真实 BrowserWindow，integration 行为（fold-time capture 真机时序 / animate guard 真机中间帧）无 committed test（与既有「toggleImpl 不 unit test 只测纯 helper」模式一致，非新欠债）。

### ✅ Batch 6 — 主进程启动/关闭子系统（index/ facade，REVIEW_104，commits 35541c3 + ced3310 + d54af5c）— **R1+R2 双轮收口完成**
- **scope（5 文件 758 LOC，全 fp:NONE never-reviewed + 零测试）**：`index.ts`(82 facade) + `index/bootstrap-infra.ts`(298 Phase 0-8.6 顺序敏感 init) + `index/bootstrap-wiring.ts`(241 Phase 9-11 wiring) + `index/lifecycle-hooks.ts`(126 second-instance/before-quit race-with-timeout) + `index/_deps.ts`(93 BootstrapState + makeDebouncedTeamSender + TOOL_DISPLAY_NAME)。Phase 4 Step 4.8 facade 拆分后子模块全 never-reviewed（同 Batch 3 codex / Batch 5 window 拆分盲区）。
- **选批方法学**：plan #1 推荐的 adapter 类型契约簇（create-session-opts.ts 313 等）= **纯 type declaration 0 函数 0 运行时逻辑**，BUG 排查 ROI 极低 → 改选 index/ 启停子系统（init 顺序/退出清理/race/共享可变态 = 高 BUG ROI）。**下批教训**：选批先 `grep -cE "function|=>" <file>` 看函数密度，纯 type 文件留给「契约漂移」专项不进 deep-review。
- **REVIEW_104**：R1+R2 双轮异构对抗，reviewer-claude(Opus4.7) `aece95d0` + reviewer-codex(gpt-5.5) `019e86c2`，teamId `80ff26a3`（已 shutdown）。
- **异构对抗高光**：① **同一 before-quit 函数两条侵蚀路径**——codex 看「重入无 preventDefault」(MED-A) + claude 看「cleanupSteps reject 跳过 closeDb」(MED-B)，共同侵蚀同一 WAL-checkpoint 不变量，统一修法根治；② claude 与 lead 预备分析独立重合透明快捷键 stale-read(MED-D)；③ **R2 fix 超出原 finding**：claude R2 实测确认 MED-B 的 finally 重构不只堵 reject 路径，**同时堵住同步 stop 步骤抛错路径**（原 finding 没覆盖）；④ 双方独立验证「.catch 不吞 process.exit(1) 卡死信号」（catch 兜快错/timeout 兜慢卡正交，claude node sim hang + codex 读码 trace）。
- **已修 + commit**：`35541c3`（R1：MED-A 重入 preventDefault + MED-B closeDb 移 finally 无条件跑+cleanupSteps.catch 哨兵 + MED-C session-upserted listener try/catch + MED-D 透明快捷键读 floating.windowTransparent SSOT 新增 facade getter + LOW-E initInfra 返回 settings 透传 + INFO-F 新增 _deps.test.ts 8 test）/ `ced3310`（R2：bootstrap-infra 文件头 banner 注释订正 return boolean→AppSettings|null）/ `d54af5c`（REVIEW_104 + INDEX）。0 HIGH / 4 MED / 1 LOW / 1 INFO 全 fix + 3 INFO 文档化。
- **R2 both-agree 收口**：双 reviewer 均明示 conclude + 可合，0 HIGH 0 真 MED 0 新真问题。codex 独立复验 before-quit 重构/PRE_LISTEN 顺序/EADDRINUSE 双 closeDb 幂等/PATH mutate 顺序全通过；claude 4 focus 逐项 node sim 实测。lead 现场验证：Electron .d.ts 类型核验 + node sim before-quit 四路径 closeDb + debounce 时序 + 读码 trace。dual typecheck 双绿 + 1419 passed | 236 skipped（+8）零回归。
- **遗留 follow-up（非阻塞，双方裁定可接受）**：① before-quit 重入路径无独立 timeout（首轮 race timeout 已兜底）② cleanup reject 退 exit code 0（与修前语义一致，warn-only cleanup 无非 0 收益）③ 其余裸 listener 不包 try/catch（只透传不触 DB，过度防御噪音）④ 子系统 integration test deferral（需 Electron app harness，lead 已 node sim 补纯逻辑）。

### ✅ Batch 7 — adapter spawn-options 构建 + 注册分发（options-builder.ts + registry.ts，REVIEW_105，commits 3b9f6b7 + 9ba12f8）— **R1+R2 双轮收口完成**
- **scope（2 文件 412 LOC，高内聚 adapter spawn 入口 + 生命周期）**：`adapters/options-builder.ts`(312，**fp:NONE 真未审**——basename 命中 REVIEW_47/36/75/60/79 经逐个核验全是 claude-code/sdk-bridge/ 下同名子文件 query-options-builder/thread-options-builder，顶层真未审) + `adapters/registry.ts`(100，REVIEW_2 远古审 line 61、D2 重构后过期)。无直接测试。options-builder 含**安全敏感** reviewer-* unsafe default spread（sandbox/approval/network/dirs 强制覆盖）= 高 BUG ROI；纯 type create-session-opts.ts(313, 0 函数) 按 Batch 6 教训排除。
- **REVIEW_105**：R1+R2 双轮异构对抗，reviewer-claude(Opus4.7) `ad3bfb4e` + reviewer-codex(gpt-5.5) `019e8704`，teamId `b3fe4a29`（已 shutdown）。
- **异构对抗高光**：**MED-1 双 reviewer + lead 预备分析三重独立命中** resumeCliSid/resumeMode narrow 漏挑（facade type 都声明 + Raw jsdoc「都消费」但两 narrow 都不挑 + facade.createSession 白名单不 spread = 死字段 + 契约矛盾）；R1 codex 增量「单修 builder 不够 facade index.ts 也丢」lead 验证成立；**R2 双方独立命中同一 LOW**（envOverrideExtra 守门例外集错归类）。
- **lead 决定性增量（修法方向）**：用户授权 lead 定方向。**架构一致性铁证**——bridge 内部 CreateSessionOpts 已有同款 internal 字段 cancelCheck/skipFirstUserEmit 只活在 bridge 不进 facade，resumeCliSid/resumeMode 语义相同（plan reverse-rename line 222「caller 不该传」）却误混进 facade → 选**方向 b 收窄删字段=回归既定分层**（非发明新约定）。
- **已修 + commit**：`3b9f6b7`（R1：MED-1 删 facade 三处声明 + SSOT 7 组合不变量表 jsdoc 迁到 bridge create-session/_deps.ts + 改 6 处悬空引用 + field 级 TS 守门(c，守门点 9，反向验证临时加 _probe typecheck 立报 TS2322) / MED-2 initAll 返回 AdapterInitResult[] + bootstrap surface 失败项保留续跑 resilience + 3 field-coverage 测试 + 4 registry 测试）/ `9ba12f8`（R2：envOverrideExtra 守门例外集理由订正 + handOff 测试覆盖 + AGENT_DECK_CLAUDE_PATH wrapper stale 注释订正）。
- **R2 both-agree 收口**：双 reviewer 均明示 conclude + 可合，0 HIGH 0 真 MED。删字段方向(b)成立 + initAll「续跑+surface」取舍可接受。typecheck 双绿 + 1426 passed | 236 skipped（+7）零回归。lead 现场验证：git 考古 + 类型链 trace（bridge vs facade 双套独立 type）+ 反向验证 field 守门 + SSOT 迁移自洽 grep + envOverrideExtra 零 producer 实证。
- **正向确认**：reviewer-* unsafe default spread 安全边界无洞（覆盖顺序正确 caller 不可绕过 + agentName 与 body 加载强耦合 + TC8-11b 覆盖）。
- **遗留 follow-up（非阻塞，双方裁定可接受）**：① envOverrideExtra 彻底归位 bridge（方向 b，牵动 codex index.ts:96 透传链，与 MED-1 一致性最高，需独立小 plan；当前 a 方案 jsdoc 拆分 + 维护警告零风险够用）② initAll UI 事件 surface（可选增强，当前 logger.error 兜底已是合理下限）。
- **Batch 7 新增教训**：① **lead 预备独立分析与双 reviewer 三重命中**是异构对抗最强信号（MED-1）；② **修法方向有分叉时找架构一致性铁证**（bridge 已有同款 internal 字段分层 = 删字段是回归既定模式非发明新约定，比「最小改动」理由更硬）；③ **field 级 TS 守门必反向验证**（临时注入假字段看 typecheck 是否报错，证明守门非 vacuous）；④ **R2 fix 顺手清同源 stale 注释**（AGENT_DECK_CLAUDE_PATH wrapper 残留，Batch 5/6 教训③第三次复现——cross-adapter 改造删代码漏改注释）；⑤ **零 producer 死字段是模式**（resumeCliSid/resumeMode/envOverrideExtra 同款：facade 声明 + bridge 消费链就绪但无 SET 点，下批审 adapter 层注意这个反模式）。



> 下个会话第一步：先跑 `bash "/Applications/Agent Deck.app/Contents/Resources/SOPs/file-level-review-expiry.sh"` 重算过期清单 + `git log --oneline -30` 看最新改动，再选批。下面是本会话扫出的候选（可能已变）：

- **✅ Batch 2 完成 — teamless-dm + universal-message-watcher**（REVIEW_100，R1+R2 双轮异构对抗收口）：commits `15b0080`（R1 shutdown reschedule race）+ `73b6cbb`（R2 process 入口 guard 补全）。0 HIGH 0 真 MED，双 reviewer R2 both-agree conclude。headline v027 自引用 FK migration 双方 sqlite3 实证 rename-old-first 保 reply chain。follow-up issue `7dcb0676`（teamless 表无界增长 + listBySession 全表扫描，pre-existing，需独立 retention/index plan）。1354 tests + typecheck 双绿。
- **✅ Batch 3 完成 — codex-cli sdk-bridge 断连恢复/重启/回滚链**（REVIEW_101，R1+R2 双轮异构对抗收口）：commits `3511d96`（R1 合并修法）+ `f9dbb0c`（R2 强化）+ `e10ff40`（REVIEW_101）。0 HIGH 0 真 MED，双 reviewer R2 both-agree conclude。异构高光：双方命中同一文件 restart-controller 不同侧面（cancel-guard / jsonl-fallback）。follow-up issue `30ca35a9`（recover 丢 reviewer network/dirs，recover-only）。1357 tests + typecheck 双绿。
- **❌ MCP hand-off / archive-plan / spawn 热点 — 已排除**（昨天 REVIEW_96 brace-展开写法 `{handler-main,cwd-resolver,team-adopt-coordinator}.ts` + archive-plan 族已覆盖，churn=0 不重审；expiry 脚本对 brace 写法假阴性，需人工甄别）。
- **Batch 4 候选 — issue tracker UI**（IssueDetail.tsx 530行 / ResolveInNewSessionDialog / IssuesPanel / issues-store）：renderer 侧 issue 面板。⚠️ 注意 REVIEW_93/95 才 1 天前审过且 churn≈0，**下个会话必先重算过期确认是否真需重审**（很可能不过期 → 另选未审面）。
- **其他未审候选**（本会话 Batch 3 扫出，按 LOC）：`renderer/hooks/useImageAttachments.ts`(467 never-reviewed) / `adapters/options-builder.ts`(312) / `adapters/types/create-session-opts.ts`(313) / `session/manager/lifecycle.ts`(360) / `store/session-repo/core-crud.ts`(346) / `ipc/issues.ts`(337) / `session/summarizer/index.ts`(326) / `index/bootstrap-infra.ts`(298) / `session/manager-ingest-pipeline.ts`(295)。下个会话用 `comm -23 all_src reviewed_paths` 重算精确未审清单。
- **log viewer**（LogViewerModal churn 4）：已 REVIEW_98 simple-review 覆盖 + a11y 留 follow-up，可能不需重审。

- **Batch 6 候选（本会话 Batch 5 精算，basename SSOT 双重核验过的高置信 TRULY-NEVER）**：full-path + basename 双 grep 都 0 命中的真未审文件（按 LOC）：
  - **adapter 类型契约簇（内聚，推荐 Batch 6）**：`main/adapters/types/create-session-opts.ts`(313 TRULY NEVER) + `main/adapters/types/agent-adapter.ts`(201 TRULY NEVER) + `main/adapters/types/capabilities.ts`(58) + `main/adapters/types/adapter-context.ts`(20) —— adapter 抽象层 type 契约，与 Batch 1-5 行为代码重叠低；可加 `main/adapters/options-builder.ts`(312) 但**需先 spot-check**（basename bn:6 命中 REVIEW_79/36/47/60/75，疑已审，大概率排除）。
  - **settings UI 簇**：`renderer/components/settings/sections/CodexMcpServersSection.tsx`(176 TRULY NEVER) + `renderer/components/settings/CodexAgentsMdEditor.tsx`(155 TRULY NEVER) + `renderer/components/settings/sections/KeyboardShortcutsSection.tsx`(65)。
  - **utils 簇**：`main/utils/user-shell-path.ts`(165 TRULY NEVER) + `main/utils/resources-placeholder.ts`(131 TRULY NEVER) + `main/utils/optional-fields.ts`(57)。
  - **TeamDetail UI 簇**（多 .tsx，basename collision 需逐个核）：`renderer/components/TeamDetail/EventsSection.tsx`(122) / `TasksSection.tsx`(100) / `MessagesSection.tsx`(88) / `PendingSection.tsx`(85) / `Header.tsx`(65)。
  - ⚠️ **方法学硬约束**（Batch 4/5 反复踩）：`fp:0 bn:N>0`（full-path grep 0 命中但 basename 命中）= **大概率已审**（reviews 用相对路径形态写 scope），必须 `grep -rlF '<basename>' ref/reviews/` 看具体哪份 REVIEW 覆盖 + churn 是否过期再定，**不要直接当未审审第二遍**。已知已审排除：task 子系统 REVIEW_87 全审（本会话验证）/ archive-plan helper REVIEW_74 / issue UI REVIEW_67/69/70/93/95 / options-builder REVIEW_79 等 / session/manager/lifecycle.ts 实际 never（fp:0 bn:10 全是 lifecycle.ts 重名，需 full-path 核）。

- **Batch 7 候选（本会话 Batch 6 精算，fp:NONE 金标准 + spot-check 区分 scope vs trace）**：
  - **⚠️ adapter 类型契约簇仍剩着但不推荐优先**：`create-session-opts.ts`(313) + `agent-adapter.ts`(201) + `capabilities.ts`(58) + `adapter-context.ts`(20) 全 fp:NONE 真未审，但 Batch 6 已确认**纯 type declaration 0 函数**，BUG ROI 极低。若做就走「契约漂移 + 穷举覆盖」轻量 simple-review，不值 deep-review 多轮。
  - **adapters/options-builder.ts（312 LOC，fp:NONE 真未审，推荐 Batch 7）**：本会话核验 REVIEW_79 basename 命中实为 `thread-options-builder.ts`（codex-cli 子 bridge 不同文件），主 `adapters/options-builder.ts` 真 fp:NONE never-reviewed。adapter spawn-options 构建逻辑（claude/codex 分流 + sandbox/permission/env 透传）= 真 logic 高 BUG ROI。可配 `adapters/registry.ts`（adapter 注册 + initAll/shutdownAll，Batch 6 顺手读过 shutdownAll 吞错）一起。
  - **settings UI 簇**（fp 待逐个核）：`renderer/components/settings/sections/CodexMcpServersSection.tsx`(176) + `CodexAgentsMdEditor.tsx`(155) + `KeyboardShortcutsSection.tsx`(65) —— renderer 侧，与 main 逻辑重叠低。
  - **utils 簇**（部分已自审）：`resources-placeholder.ts`(131 fp:NONE) + `optional-fields.ts`(57 fp:NONE) 真未审；但 `user-shell-path.ts`(165) 虽 fp:NONE 实已在自己 plan `sdk-spawn-shell-path-20260529` 异构对抗审过 + 13K test，重审 ROI 低（本会话已核实）。
  - **TeamDetail UI 簇**（多 .tsx basename collision 需逐个核）：`EventsSection.tsx`(122) / `TasksSection.tsx`(100) / `MessagesSection.tsx`(88) / `PendingSection.tsx`(85) / `Header.tsx`(65)。
  - **❌ 已排除（本会话核验）**：core-crud.ts（REVIEW_88 scope 全审，churn 低）/ summarizer/index.ts（REVIEW_84 fp 命中）/ manager-ingest-pipeline.ts（REVIEW_49/83）/ ipc/issues.ts（REVIEW_68/93）/ notify 簇（REVIEW_2/4/20/21 老审但 churn 仅 logger-migrate，低值）。

## 方法备忘（每批照走）

1. **scope 锁定**：churn（`git log --oneline -60 --name-only`）+ 未 review（grep ref/reviews/）+ expiry 脚本。单批 ≤ 10 文件。
2. **invoke** `agent-deck:deep-review` SKILL，typed args `{kind:'code', paths:[...绝对路径]}`。
3. **lead 职责**：起异构对（reviewer-claude claude-code + reviewer-codex codex-cli），三态裁决（✅双方共识/单方+现场验证 ❌反驳 ❓未验证降级），**单方 HIGH 必走反驳轮**，**收口需双方都明示 conclude+可合 + 0 HIGH/MED**。
4. **lead 必做现场验证**：sqlite3 CLI repro / 读码 trace / 边角矩阵 node 脚本 —— 不 rubber-stamp。
5. **fix 后**：typecheck 双配置（`zsh -i -l -c "pnpm typecheck"`）+ 相关 vitest（非 SQLite 真测；SQLite-gated 测试 node ABI 下 skip 正常，用 sqlite3 CLI 验机制）。commit 带详细三态裁决。
6. **改完写 REVIEW_X**（X 递增）+ 同步 `ref/reviews/INDEX.md`。

## 关键踩坑（本会话踩过，避免重复）

- **SQLite 单测 binding-gated**：vitest 在 node ABI 137 下加载 Electron ABI-130 binding 失败 → SQLite 真测全 skip（正常，BY DESIGN）。验机制用 `sqlite3` CLI repro，**不要** `pnpm test` 跑 Electron-as-node（CHANGELOG_42 binding corruption 风险）。
- **emit→DB 是同步链**：`ctx.emit`→`sessionManager.ingest`→`persistEventRow`→`eventRepo.insert`（better-sqlite3 同步）。涉及 emit 时机的 race 分析靠这个事实。
- **测试网会反捕设计缺陷**：R2 isCancelledFn 初版用绝对 closed 态被 6 个 closed-resume 测试反捕 → 改 transition。**fix 后必跑相关集成测试再 commit**。
- reviewer 复用同一对跨轮（send_message 不重 spawn），收口才 shutdown。

- **Batch 8 候选（本会话 Batch 7 收口后快速精算，下会话必重算确认 fp + spot-check）**：
  - **session/manager/lifecycle.ts（360 LOC, 17 fn, fp:0 bn:10 全是 lifecycle.ts 重名）**：fp:0 但 bn 命中全是别处同名 lifecycle.ts（window/lifecycle.ts 已 Batch 5 审 / manager/lifecycle 需 full-path 核），高函数密度 logic-heavy（session 生命周期状态机 active/dormant/closed + epoch），下会话 `grep -rlF "manager/lifecycle" ref/reviews/` 精核是否真未审。
  - **store/session-repo/core-crud.ts（346 LOC, 15 fn, fp:0 bn:7）**：⚠️ plan Batch 6/7 标注「REVIEW_88 scope 全审 churn 低」已排除，下会话先核 REVIEW_88 是否真覆盖 + churn 过期判定（fp:0 但可能 REVIEW_88 用相对路径形态写）。
  - **session/manager-ingest-pipeline.ts（295 LOC, 7 fn, fp:1 bn:6）**：plan 标注 REVIEW_49/83 命中，下会话核是否过期。
  - **❌ 已排除**：summarizer/index.ts（fp:0 但 bn:64 + REVIEW_84 命中，plan 已核）/ event-repo.ts（fp:6 REVIEW_7 等多次审）/ manager.ts（fp:17 reviewed 充分，514 LOC 已超 500 护栏但属既有文件不在本 review scope）。
  - **方法学铁律（Batch 4-7 反复踩实）**：①fp:NONE 才是真未审金标准 ②basename 命中必 grep -rlF 逐个 spot-check 区分 scope-review vs trace-waypoint vs 同名不同文件 ③选批先 grep -cE "function|=>" 看函数密度，纯 type（0 函数）BUG ROI 极低不进 deep-review ④单批 ≤ 10 文件优先高内聚簇。

### 🔄 Batch 8 选批（本会话精核结果 — 上面候选全部推翻）
- **候选全核验为已审，不可用**：①`session/manager/lifecycle.ts` = REVIEW_83 批 E1 正式 scope（line 19 「8 method」）+ REVIEW_85（recordCreatedPermissionMode）+ REVIEW_99（closeEpoch），未过期 ②`store/session-repo/core-crud.ts` = REVIEW_88 批 G1 正式 scope（line 16「core-crud.ts | 332」）③`manager-ingest-pipeline.ts` = REVIEW_49/83 命中。**Batch 7 plan 的 fp:0 判断不准**（two-level path grep 假阴性，reviews 用 basename 形态写 scope）。
- **方法学新教训（本会话踩实，重要）**：⑤ **函数密度对 facade/thin-wrapper 层失真**——preload/api 层（`api/teams.ts` 18fn / `api/adapters.ts` 12fn / `api/misc.ts` 36fn）grep "function|=>" 计数虚高，实际全是 `ipcRenderer.invoke(channel, ...args)` 零逻辑转发（无分支/状态/race/资源管理），与「纯 type 0 逻辑」同类 ROI 极低，属契约漂移轻量 simple-review 范畴，**不进 deep-review**。选批除看 fn 密度，还要 spot-check 函数体是否真有 logic（事务/分支/race/资源/权限）。⑥ **持久层批 vs handler 批要分清**——REVIEW_87 审 task **handler** 层（task-list.ts/task-delete.ts handler），repo 子文件（task-repo-*.ts）只是 trace 佐证非 scope；session-repo(R88)/team-repo(R89)/message-repo(R90)/杂项 store(R91) 各有持久层专批，**独缺 task-repo 持久层专批** → 本批补。
- **✅ Batch 8 锁定 = task-repo 持久层 5 文件（~828 LOC, 32 fn，真 logic-heavy）**：`task-repo-crud.ts`(118/4fn upsert/get/update + UPDATABLE_KEYS 权限) + `task-repo-delete.ts`(134/9fn cascade BFS predicate + cleanupBlocksReferences) + `task-repo-handoff.ts`(141/8fn db.transaction 4 步原子 + chunked DELETE 500 + FK 约束 + ROLLBACK 闭包中间值语义) + `task-repo-list.ts`(116/4fn 三态 scope 分流 + 排序稳定) + `_deps.ts`(319/7fn TaskRepo interface SSOT + Row + 共享 helper，作上下文复审契约)。Phase 4 Step 4.5 拆分(8d3589a)后子模块新路径未被持久层专批覆盖（同 Batch 3/5/6 facade 拆分盲区模式）。churn 极低（仅 6a3b1c7 logger migrate）但 never-scope-reviewed。
- **剩余批次估计（回答用户）**：高 ROI main 逻辑 Batch 1-7 已基本覆盖。剩 **preload/api 层（thin wrapper，轻量 simple-review 即可）+ renderer settings/TeamDetail UI 簇 + 纯 type 契约漂移**。预计 deep-review 还 **2-3 批**（Batch 8 task-repo / Batch 9 renderer UI 簇 / Batch 10 可选长尾），之后转 file-level expiry 驱动的常态化增量重审。

### ✅ Batch 8 — task-repo 持久层（REVIEW_106）— **R1+R2 双轮收口完成**
- **scope（5 文件 ~828 LOC，全 trace-only never-scope-reviewed + Phase4 Step4.5 拆分盲区）**：`task-repo-crud.ts`(118) + `task-repo-delete.ts`(134) + `task-repo-handoff.ts`(141) + `task-repo-list.ts`(116) + `_deps.ts`(319 契约 SSOT)。持久层批独缺的最后一块（R88/89/90/91 已覆盖 session/team/message/杂项 store，REVIEW_87 审的是 task **handler** 层非 repo 层）。
- **REVIEW_106**：R1+R2 双轮异构对抗，reviewer-claude(Opus4.7) `2707b6ee` + reviewer-codex(gpt-5.5) `019e8762`，teamId `425271f6`（已 shutdown）。commit：见 git log（本会话 fix+测试+REVIEW 一次性收口）。
- **异构对抗高光**：① **MED-1 三重独立命中**（lead 预备 sqlite3 复现 + claude 真 SQLite+EXPLAIN+分页 + codex sqlite3）list `ORDER BY updated_at DESC` same-ms 无 tie-breaker = **复发主题第 5 次**（REVIEW_84/89/90/91），task-repo 是漏网最后一个 list repo；实测当前返 rowid-ASC（最旧在前）恰违 jsdoc newest-first；② R2 三方一致命中复合索引 `(updated_at, rowid)` 死路（SQLite 拒具名 rowid 列），**claude 增量更深**：现有 idx_tasks_updated_at 隐含尾随 rowid ASC → rowid ASC 免 TEMP B-TREE 但 oldest-first，rowid DESC 退化 TEMP B-TREE FOR RIGHT PART 但 newest-first 自洽（lead EXPLAIN 实证）。
- **已修**：R1 3 fix（MED-1 `ORDER BY updated_at DESC, rowid DESC` 必须 rowid 非 id + LOW visibleScope>500 退化 personal-only 不丢 caller personal + LOW subject LOWER ASCII-only 补 jsdoc）+ 2 回归测试（raw SQL 同毫秒 5 行 + 501 teamIds）+ R2 2 注释订正（顶部 jsdoc >500 漂移 + ORDER BY rowid DESC/ASC 取舍）。1 MED ✅ + 2 LOW ✅ + 2 INFO ✅ 全 fix；R1 3 INFO 维持 + 1 INFO 可辩护不改。
- **R2 both-agree 收口**：双 reviewer 均明示 conclude + 可合，0 HIGH 0 真 MED。typecheck 双配置双绿 + task-repo 67 tests（reviewer Electron-as-node 实跑 passed）+ lead sqlite3 CLI 验机制（binding-gated skip BY DESIGN，避 binding corruption）。
- **正向确认**：handoff 4 步单 tx ROLLBACK re-throw 闭包脏返回不可达 / delete cascade predicate 越权不展开下游 / IN 500 上限 / rowid tie-breaker 与三路径 WHERE 正交 / crypto.randomUUID 全局可用 / toColumnValue/safeJsonArray nullish 守门。
- **遗留 follow-up（非阻塞，双方裁定可接受）**：① cleanupBlocksReferences 全表扫 O(N)（当前规模可忽略，blocks JSON 列无法直接索引）② 裸 list() TEMP B-TREE（表增大可改 rowid ASC 复用索引，代价同毫秒簇 oldest-first）③ subject 非 ASCII case-insensitive 搜索需 ICU。
- **Batch 8 新增教训（已写入方法学）**：⑦ **函数密度对 facade/thin-wrapper 层失真**——preload/api grep fn 计数虚高但全是 ipcRenderer.invoke 零逻辑转发，选批除 fn 密度还要 spot-check 函数体真 logic（事务/分支/race/资源/权限）；⑧ **持久层批 vs handler 批分清**——同一子系统 handler 审过 ≠ repo 层审过，facade 拆分子模块按 trace-waypoint 而非 scope 判未审；⑨ **复发主题穿透全子系统**——same-ms tie-breaker 第 5 次穿过持久层全部 list repo，选批可主动 grep 历史先例（如 `tie-breaker|rowid|same-ms`）锁定同类盲区漏网文件。

### 📍 Batch 9 候选（本会话精算，下会话必重算确认 fp + spot-check）
- **renderer settings UI 簇**（fp:NONE 真未审，本会话全量 grep 确认）：`renderer/components/settings/sections/LogViewerModal.tsx`(205) + `CodexMcpServersSection.tsx`(176) + `settings/CodexAgentsMdEditor.tsx`(155) + `sections/KeyboardShortcutsSection.tsx`(65)。renderer 侧 UI，与 main 逻辑重叠低，ROI 中等。
- **TeamDetail UI 簇**（fp:NONE）：`TeamDetail/EventsSection.tsx`(122) / `TasksSection.tsx`(100) / `MessagesSection.tsx`(88) / `PendingSection.tsx`(85) / `Header.tsx`(65)。展示层 ROI 偏低。
- **preload/api 层**（fp:NONE 整层真未审，但 thin wrapper）：`api/teams.ts`(133/18fn) + `api/adapters.ts`(136/12fn) + `api/misc.ts`(207/36fn) + `api/sessions.ts`(76) + `api/issues.ts`(79) + `api/events.ts`(61) + `api/_helpers.ts`(32)。**Batch 8 教训⑦**：grep fn 计数虚高但全是 `ipcRenderer.invoke` 零逻辑转发 → 走**轻量 simple-review**（契约漂移 / IPC 序列化边界）不值 deep-review 多轮。
- **纯 type 契约**（不进 deep-review，留 simple-review 契约漂移专项）：`adapters/types/create-session-opts.ts`(266/0fn) + `agent-adapter.ts`(201/0fn)。
- **方法学铁律（Batch 4-9 反复踩实）**：①fp:NONE 才是真未审金标准（two-level path grep 假阴性，reviews 用 basename 形态写 scope）②basename 命中必 grep -rlF 逐个 spot-check 区分 scope-review vs trace-waypoint vs 同名不同文件 ③选批先 grep -cE "function|=>" 看函数密度 + **spot-check 函数体真 logic**（Batch 8 教训⑦：facade/thin-wrapper fn 密度失真）④单批 ≤ 10 文件优先高内聚簇 ⑤持久层/子系统 handler 审过 ≠ 全部审过（Batch 8 教训⑧）⑥**renderer 组件选批必 grep importer / 挂载点确认非 dead code**（Batch 9 教训⑩：**fp:NONE 只证未被 review，不证用户路径可达**；零 importer → git 考古查是否意图性下架 dead UI，dead UI 不进 deep-review；CodexMcpServersSection 是 fp:NONE 真未审但用户 5/28 主动下架的零挂载 dead UI，审中被 reviewer-codex 集成可达性维度抓出 = reviewer-claude+lead 共同盲区）。

### ✅ Batch 9 — renderer settings/TeamDetail UI 簇（REVIEW_107，commit ad0fd5e）— **R1+R2+R3 三轮收口完成（含 scope 误差纠正）**
- **初选 scope（8 文件 fp:NONE）→ 审中发现 1 个意图性 dead UI → 用户决策删除 → 有效 scope 4 文件 + 1 抽离模块**：改 `TeamDetail/PendingSection.tsx`(MED-D) + `EventsSection.tsx`(LOW-A+INFO) + `helpers.ts`(LOW-B) + 新增 `events-payload-describe.ts`（抽离）；**删** `settings/sections/CodexMcpServersSection.tsx`（dead UI）。`CodexAgentsMdEditor.tsx` R1 双方 PASS 无 finding 排除。
- **REVIEW_107**：R1+R2+R3 三轮异构对抗，reviewer-claude(Opus4.7) `4fb4ce50` + reviewer-codex(gpt-5.5) `019e8784`，teamId `aff7ab01`（已 shutdown）。
- **异构对抗最大价值高光 = 集成可达性维度抓出 scope 误差**：reviewer-codex R2 抓出 HIGH-1 `CodexMcpServersSection` 完全零挂载（rg 全 renderer 只命中自身定义）→ lead R1 所有 fix 都在用户路径不可达死组件上。命中 **reviewer-claude + lead 共同盲区**（双方只审「组件本身对不对」判 byte-equivalent+conclude，都没查「组件用户路径是否可达」）。**lead git 考古坐实**：commit 09f58a3(5/11)建+挂 → 0137aad(5/28,CHANGELOG_160)用户主动「不管 mcp 也去掉 codex mcp」删 UI 挂载（字段持久化保留/UI 不暴露/文件故意留）= 意图性 dead UI 非 regression → **用户决策删整组件**。reviewer-claude R3 acknowledge 盲区 + 升级 mental model「审组件先 grep importer 零 importer 质疑 dead code」。
- **MED-D ✅ 仲裁矛盾**（codex MED 真问题 / claude INFO PASS 误判同源）：PendingSection 漏 archived/lifecycle 过滤 → lead 裁 codex 对（PendingTab 确用 selectPendingBuckets 带 archivedAt 过滤，claude 误以为同源 raw maps；archive.ts:59 只 UPDATE archived_at 不碰 leftAt 正交 → archived-but-active-member 可达）→ 复用 selectPendingBuckets 消口径漂移 + 7 selector 测试（此前 0 测试）。
- **LOW-A ✅**（双方独立 codex MED/claude LOW）EventsSection truthy 非 string 原始值 payload `'in'` 抛 TypeError → 整 app 崩（唯一 RootErrorBoundary 在 app 根 blast radius 大）；lead 双通道核实 SDK+hook emitter 全产 object payload **不可达**自降 LOW，护栏成本一行值得加（同 REVIEW_98）→ `typeof !== 'object'` 守门。**LOW-B ✅**（双方共识）relativeTime(NaN)→"NaN 天前" → `!Number.isFinite` 守门（三 caller 受益）。**INFO ✅** describeEventPayload 每行 hoist 复用。
- **R1 2 MED 随组件删作废**（claude save 回灌 + codex parseAndValidate 收紧）——非判断错（claude 审组件对不对是对的），是组件不该在 scope（dead UI）。
- **R3 both-agree 收口**：双 reviewer 均明示 conclude，0 HIGH 0 真 MED。typecheck 双配置双绿 + 123 renderer tests 零回归（删后；+24 新测试 events-payload-describe 17 + session-selectors 7）。
- **正向确认**：MessagesSection msg.body XSS 安全（MarkdownText 无 rehype-raw + safeProtocol 剥离 js:/data: URI）/ EventsSection raw-leak 安全（default 返「无更多详情」非 JSON.stringify）/ slice(0,30) newest-first 不丢数据 / CodexAgentsMdEditor cleanup 契约全链 useCallback memoize / key 全稳定主键。
- **遗留 follow-up（非阻塞）**：① **transport-specific 字段校验**（codex R2 MED-2，Codex 0.135 实测 HTTP+args/env、stdio+bearer 互斥铁证）：CodexMcpServersSection 已删此校验不存在，但 settings.codexMcpServers 字段+toml-writer 仍在；**若未来重新挂载 UI 编辑通路需补**（parser/toml-writer 拒 transport-specific 字段错配）② renderer 组件级测试环境（jsdom + @testing-library），当前 node-env 只测抽离纯逻辑（与既有 renderer 测试模式一致非新欠债）。

### ✅ Batch 9 收尾（用户加做：日志排查 + 轻量 simple-review，commit 6ec754c）
- **日志排查**（用户要求看 ~/Library/Logs/Agent Deck/ 找 error/warn）：扫 06-01/06-02 两天，error/warn 聚类后**唯一真信号 = Signal 1**（已上报 issue `18041912`，low）：退出时 `closeDb()` 后 adapter in-flight `agent-event` 仍走 `ingest→findByCliSessionId→getDb()` 抛 "Database not initialized" unhandledRejection（**仅落盘不强退** logger.ts:84 → 退出期 log 噪音非 crash，4 天 1 次；REVIEW_104 只给 session-upserted listener 加 try/catch，ingest 自身 DB 访问路径未加 shutdown guard = 不对称裂口）。**不当场修**：触及 before-quit/DB-lifecycle/ingest 热路径 REVIEW_104 加固区，应走独立 focused review。其余非真信号：webFrameMain disposed 14×（Electron 内部，我们唯一 webContents.send 在 safeSend 已 guard isDestroyed）/ codex malformed agent role 152×（**别的项目** hilo-agent-opencode 的 .codex/agents 坏文件，已 suppress UI emit）/ monaco unmount race 44×（by-design suppressed）/ CLI forked 12× + summarizer timeout 10× + settings-env reject 5×（全设计内预期降级）。
- **轻量 simple-review**（用户要求收尾 preload/api thin wrapper + 纯 type 契约）：scope 6 文件（preload/api 4 fp:NONE：_helpers/adapters/issues/teams + 纯 type create-session-opts/agent-adapter）。单次异构对抗 reviewer-claude `62e96e02` + reviewer-codex `019e87bb`（已 shutdown），**0 HIGH/0 MED 双方可合**。核心确认：**IPC 契约（channel/参数序/返回形状）无漂移 + listener cleanup 全配套（subscribe<T> 返回 unsubscribe）+ 序列化边界无 function/Map/Set + type 自洽 4 套 AssertSameKeys 守门**。**修 2 doc-drift**（commit 6ec754c，comment-only）：agent-adapter.ts receiveTeammateMessage 注释补三段 wire format `[from][msg][sid]`（CHANGELOG_100）/ create-session-opts.ts additionalDirectories 注释补 `/tmp`（spike4 reviewer-codex sandbox-exec 需求）。**scope 外 follow-up**（issue `9c67c120`，low）：ipc/adapters.ts 18 处 String(x) 裸 cast vs parseStringId 风格混用（不擅自扩 scope 改未审文件，需 main/ipc/adapters.ts 独立批次）。**不改**：_helpers.subscribe 无 schema 校验（实际 leak 路径 0）/ envOverrideExtra 死字段（已知 REVIEW_105 follow-up 故意保留）/ teams.ts payload:unknown（by-design）。
- **Batch 9 教训⑪（已隐含进方法学）**：滚动 review 任务里**用户真实信号（日志 error/warn）比静态选批更高 ROI**——日志排查直接挖出 Signal 1（shutdown race，静态选批难命中），且能区分「我们的 bug vs 外部项目噪音 vs by-design suppressed」。收尾批优先扫一遍最近日志再决定是否还值 deep-review。


### 📍 Batch 10 候选（本会话快速估计，下会话必重算 + 评估是否还值 deep-review）
- **高 ROI main 逻辑 Batch 1-8 已基本覆盖**；renderer 高 logic UI 簇 Batch 9 覆盖（含 dead UI 清理）。**剩长尾**：
  - **preload/api 层**（fp:NONE 整层真未审但 thin wrapper）：`api/teams.ts`/`adapters.ts`/`misc.ts`/`sessions.ts`/`issues.ts`/`events.ts`/`_helpers.ts` —— **Batch 8 教训⑦**：全 ipcRenderer.invoke 零逻辑转发 → 走**轻量 simple-review**（契约漂移/IPC 序列化边界）不进 deep-review 多轮。
  - **纯 type 契约**（不进 deep-review，留 simple-review 契约漂移专项）：`adapters/types/create-session-opts.ts`(0fn) + `agent-adapter.ts`(0fn)。
  - **剩余 renderer UI**（**先 grep importer 确认非 dead UI，Batch 9 教训⑩**）：`TeamDetail/TasksSection.tsx`(R1 已捎带审 PASS) / `MembersSection.tsx` / `LineageSection.tsx` / `settings/CodexAgentsMdEditor.tsx`(Batch 9 R1 PASS) 等展示层，ROI 偏低。
- **建议**：Batch 10 大概率是「**收尾批**」——要么挑 1 批真有 logic 的剩余面（先 grep importer 排 dead），要么**转 file-level expiry 驱动的常态化增量重审**（不再主动找未审面，改为「churn 触发过期 → 重审」）。下会话与用户确认是否继续主动 deep-review 还是转常态化。

### ✅ Batch 10 收口（ipc/adapters.ts 主逻辑面 simple-review，commit bd1c0c3）
- **scope（1 文件 430 LOC +60/-32）**：`src/main/ipc/adapters.ts`（R24 列名 trace-waypoint 0 finding 命中 = 真未审主逻辑面，跨度 5/4→6/2 共 ~8 周未触动；plan §172 用户选确认走轻量 simple-review 收尾）。**精核**：`grep -rlF "ipc/adapters" ref/reviews/` 命中 R18/R24/R34/R43/R80/R91/R102，逐个 spot-check 确认 R24 列名非 scope 审（0 finding 命中 R24 真问题表）；`grep -cE "function|=>"` 仅 18 —— **教训⑦ 风险高**（facade 计数失真），但 spot-check 11 个 IPC handler 厚逻辑确认非 thin wrapper。
- **REVIEW_108**：单次异构对抗 reviewer-claude + reviewer-codex（已 shutdown，teamId `6272b945-440b-4fac-92f2-a29588acbd92`），lead 现场验证（spot-check adapters.ts:75-428 + spawn.ts:364-380 范式 + can-use-tool.ts:341 bypass 字面量短路 + _helpers.ts parsePermissionMode 白名单）。
- **6 finding 三态裁决**：**双方独立命中 2 项**（MED-1 mode 白名单 / LOW-1 13 处 String() 风格分裂 = 9c67c120 follow-up 主要债务 100% 收口）；**codex 独立命中 1 项**（MED-2 createSession post-create 泄露：line 185 recordCreatedPermissionMode 裸调在 try-catch 外 → 失败 throw 冒泡让 SDK 子进程活下来 = 孤儿活 session）；**claude 独立命中 1 项**（LOW-2 canSetPermissionMode gate 不对称 cli.ts:285 → codex session 落无意义 permission_mode 列）；**codex MED-1 (sessionId 校验前写附件) 被 LOW-1 整改覆盖** — 不单独立项（claude R1 走 persistAttachments 三处回滚对称确认通过）；**claude INFO** 11 handler 零测试覆盖降 follow-up。
- **已修**：R1 4 真修（合并 MED-1+LOW-2 1 if 块 / 合并 MED-2+LOW-2 1 if 块 / LOW-1 13 处 parseStringId 替 + RestartWith*Sandbox 改 parseCodexSandboxMode/parseSandboxMode helper 复用 + String(handoffPrompt ?? '') 改 typeof === 'string' 守门）。`+60/-32` 单文件。**正向 confirm**：R11 Bug 2 bypassPermissions 冷切护栏保持 / persistAttachments 三处回滚对称保持 / IpcInputError 错误透传全收口（与 _helpers.ts「IPC 边界一次性校验 + 收口」原则统一）。
- **收口判定**：0 HIGH 0 真 MED 0 未整改 LOW。typecheck 双配置（tsconfig.node.json + tsconfig.web.json）**双绿** + vitest 全量 **1450 passed / 238 skipped / 0 failed**（+0 测试 = handler 测试 follow-up 不属本批）。
- **9c67c120 follow-up**：本批收口 13 处（修前 18 处 → 修后 5 处）。**残留 5 处** = preload/api 层 thin wrapper，Batch 8 教训⑦ 走契约专项（scope 外）。
- **遗留 follow-up**（非阻塞）：① **handler 级测试覆盖**（adapters.test.ts mock adapterRegistry + sessionRepo + image-uploads 整套 stub，优先 SetPermissionMode 回滚路径 + persistAttachments 三回滚分支 + createSession recordCreatedPermissionMode 失败 warn-only 不冒泡。属测试基础设施补强，工作量 ≥ 半天）② 9c67c120 残留 5 处 preload/api 走契约专项简单 simple-review ③ issue 18041912（Signal 1 shutdown race ingest→getDb DB-not-init）— 触及 before-quit/DB-lifecycle/ingest 热路径 REVIEW_104 加固区裂口，应走独立 focused review；④ 9c67c120 残留 5 处契约专项完成后再决定是否常态化转 file-level expiry。

### 下一会话第一步（Batch 11 决策点）
- **本批 plan §172 收尾批已走完**。Batch 11 = **决策点**：① 走 focused Signal 1 修（issue 18041912 shutdown race 独立批次）— deep-review 多轮；② 走 9c67c120 残留 5 处 preload/api 契约专项 — simple-review 单次；③ 走常态 file-level expiry 驱动的增量重审（`bash file-level-review-expiry.sh` 重新计算，选 ≥1 个高 churn 过期面 deep-review）；④ 或项目维护期到达，用户主动停。
- **首选建议**：② 9c67c120 残留 5 处契约专项（最贴合 plan §Batch 10 选批 + 9c67c120 follow-up 完全收口 + Batch 8 教训⑦ thin wrapper simple-review 是正确范式）。但用户已收尾批走完一次，可能倾向③ 常态化。下会话先与用户确认方向再开干。

### ✅ Batch 11 收口（preload/api 残留 5 处契约专项 simple-review，commit a3cd951）
- **scope（5 文件 724 LOC 0 改动）**：`src/preload/api/adapters.ts`(136) + `issues.ts`(79) + `misc.ts`(207) + `sessions.ts`(76) + `teams.ts`(133)。**已审 skip**：_helpers.ts(R107 已审) / events.ts(R45 IPC channel 已审 listener cleanup 同款范式) / preload/index.ts 聚合层 / shared/{ipc-channels,types,mcp-tools}.ts(R107 类型 SSOT 已审)。
- **REVIEW_109**：单次异构对抗 reviewer-claude(Opus4.7) `c69352b2` + reviewer-codex(gpt-5.5) `019e87e8`，teamId `4d7cee85-df0e-41f5-93f3-9c2ca4dd5536`（已 shutdown）。
- **0 真修**：双方共识 0 HIGH / 0 MED / 0 LOW。claude 实战验证 8 维度（脚本提取 84 IpcInvoke + 2 IpcEvent comm diff 零孤儿 + arg 序/数 + return 形状 + 序列化边界 + listener cleanup + typecheck 0 error 硬证据 + cast 守门 + shared 枚举漂移）全部通过。
- **payload 泛型逐字段对齐**：teams onAgentDeck{Team,Message}Changed payload `{kind, teamId: string\|null, messageId, payload}[]` ↔ main bootstrap-wiring.ts:189 makeDebouncedTeamSender（含 teamless DM teamId: string\|null）—— 严于 R107 同类 simple-review 验证强度。
- **1 INFO follow-up**：adapters.ts:76 `CHANGELOG_<X>` 占位符 — git blame 实证 e140b52b 2026-05-14 **pre-existing 遗留**（grep 全 src/ **55 处同款**系统遗留，非本批引入）→ 不擅自扩 scope 留全局 doc-drift 清理专项。
- **双方共识 + 实战验证可合，0 改动**，typecheck 双绿 + vitest 1450 passed \| 238 skipped \| 0 failed。
- **9c67c120 follow-up 100% 关闭**：Batch 10 收 13 处 main 端 + 本批 5 文件 0 漂移 = **0 剩余**。

### ✅ 任务到达维护期高点（plan §Batch 11 决策点已走完）

**总统计**：Batch 1-11 = 11 批主逻辑 + 4 批 simple-review 收尾 = **15 批 × ~100 个真修**。git ahead origin/main **30 commits**。

**已完成/收口**：
- 高 ROI main 逻辑全审：adapter/sdk-bridge/teams/store/agent-deck-mcp/任务持久层/renderer UI 簇/ipc-adapters
- 4 批 simple-review 收尾（Batch 9 preload+type / Batch 10 ipc-adapters / Batch 11 preload/api 残留）+ 1 批 doc-drift 清理
- 删 1 dead UI 组件（CodexMcpServersSection）
- 9c67c120 follow-up 100% 关闭
- 2 复发主题穿透全子系统收口（same-ms tie-breaker 第 5 次 / can-use-tool 风格分裂）

**剩余 follow-up（非阻塞）**：
1. **CHANGELOG_<X> 占位符全局清理**（REVIEW_109 INFO）—— grep 全 src/ 55 处同款遗留（capabilities.ts / agent-adapter.ts / codex-cli / preload/api/adapters.ts:76 等），可走 focused 简单 review 一次性回填（codex sandbox 冷切真实编号疑为 CHANGELOG_54）
2. **issue 18041912**（Signal 1 shutdown race ingest→getDb DB-not-init）—— 触及 before-quit/DB-lifecycle/ingest 热路径 REVIEW_104 加固区裂口，应走独立 focused deep-review 多轮
3. **handler 级测试覆盖**（REVIEW_108 follow-up）—— adapters.test.ts mock adapterRegistry+sessionRepo+image-uploads 整套 stub，优先 SetPermissionMode 回滚路径 + persistAttachments 三回滚分支 + createSession recordCreatedPermissionMode 失败 warn-only 不冒泡，工作量 ≥ 半天
4. **preload/api handler 测试**（REVIEW_109 follow-up）—— 5 文件 0 测试覆盖尴尬，0 改动但 0 测试

**下一会话第一步（用户决策）**：
- 继续主动 deep-review（哪个方向？建议走 focused Signal 1 issue 18041912）
- 转常态 file-level expiry 驱动的增量重审（不再主动找未审面）
- 停 + follow-up 路线（按 issue tracker 走）
- 用户提新需求时再开

