# 项目约定候选（待观察）

> 此文件由 Claude Code 自动维护。**不要手工删条目**。
> 当某条 count ≥ 3 时，会被升级到 [CLAUDE.md](../CLAUDE.md) 「项目特定约定」节。

## 用法（给 Claude Code 的内部约定）

两类候选，**同一文件分 section**：

| 类型 | 触发条件 |
|---|---|
| **用户反馈** (`# 用户反馈候选`) | 用户给「纠正性 / 偏好性」反馈：「不要…」「应该…」「我已经说过…」「以后…」「记住…」「每次…」 |
| **Agent 踩坑** (`# Agent 踩坑候选`) | Coding Agent 在 review / 修 bug / 排查时**自己**发现踩了同类坑，或 review 报告里反复出现同类问题（典型：try/finally 漏 cleanup、TOCTOU、N+1 查询、async listener 不被 await） |

**操作流程**（每次接到符合条件的反馈 / 自己发现踩坑时）：

1. **判断范围**：
   - 用户反馈：必须是**项目内的工程偏好 / 设计取舍 / 工作流偏好**，一次性请求（"帮我改这个 bug"）不算
   - Agent 踩坑：必须是**模式化问题**（一类问题反复出现），不是单点 bug
2. **读本文件**，找语义相近的已有条目：
   - 找到 → `count` +1，更新 `last_at` 为今天日期
   - 没找到 → 新增条目（`count: 1`），写在对应 section
3. **count 达到 3** → 这是「约定升级」决策，按通用 CLAUDE.md「决策对抗」节走**双对抗三态裁决**：
   - 起两个独立异构 Agent，各自评审升级提案：措辞是否准确 / 边界是否清晰 / 与已有约定有无冲突 / 升级到哪一节最合适
   - 三态结果汇总后告诉用户「这条 [反馈/踩坑] 累计 3 次，对抗审视结论 ✅/❌/⚠️ 如下，要升级吗？」
   - 用户确认后才写入 [CLAUDE.md](../CLAUDE.md) 「项目特定约定」相应小节，从本文件删除该条目
4. **count < 3** → 静默更新本文件，不打扰用户

> 30 天未更新且 count < 3 → 下次扫描可主动清理。

---

# 用户反馈候选

按 `count` 倒序。

| ID | 描述 | count | first_at | last_at | 触发样例 |
|----|------|-------|----------|---------|----------|
| U1 | 用户在 UI 上做的选择默认要持久化（DB / 设置文件），不要只放内存让重启丢 | 1 | 2026-04-21 | 2026-04-21 | "权限的记忆也不能放内存吧" |

---

# Agent 踩坑候选

按 `count` 倒序。

| ID | 描述 | count | first_at | last_at | 触发样例 |
|----|------|-------|----------|---------|----------|
| P1 | 注册资源 / 标记后没在 try/finally 释放——失败路径漏清，状态卡 N 秒 / 误吞同类事件 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #2: sdk-bridge.ts releasePending 只在成功路径调，失败时 60s ttl 内同 cwd hook 被误吞 |
| P2 | 路径白名单 TOCTOU——校验用原始 path、读取走 realpath，symlink 改指向后越权 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #3: ipc.ts loadImageBlob symlink TOCTOU |
| P3 | 查表 / 校验时用全表扫 + 限 N 条 + JS 侧 .find/.filter，长会话或大数据后旧记录永久查不到 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #6: ImageRead 路径靠 listForSession 500 限制兜底 |
| P4 | Map / Set / cache 写入有分支条件，但 delete 只在某一分支末尾——其他分支线性泄漏 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #4: toolUseNames 只有图片工具分支 delete |
| P5 | Electron `before-quit` / 类似事件 listener 用 `async () => { await ... }`——回调返回的 Promise 不会被 await，清理只能碰运气跑完 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #7: index.ts before-quit |
| P6 | 全局 fuzzy 兜底匹配（"池子里只剩一个就一定是它"）——并发场景下会跨实体误命中 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #1: pendingSdkCwds size===1 模糊匹配误吞外部 CLI |
| P7 | catch 只 console.warn 吞错——上层 / UI 拿不到失败原因，用户看到「神秘 session-end」 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #5: SDK query loop catch |
| P8 | 依赖 npm/dev-only env（`process.env.npm_package_version` 之类）——打包后 undefined，硬编码默认值悄悄上线 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #8: AppGetVersion 永远显示 0.1.0 |
| P9 | 测试断言 / 命令输出含**几千个连续重复字符**（`'x'.repeat(N)` 类）进对话 context——后续轮次触发 Anthropic AUP classifier 误判为异常负载，整轮回复被拦截。预防：测试用更短输入验证截断（8KB+1 而非 8KB+5KB）；或改用 `.toMatch(/regex/)` 让失败信息少 dump 原文；任何 Bash 输出 ≥ 5K 单字符重复时主动 `wc -l` / `head` 而非完整 read 进 context | 1 | 2026-04-24 | 2026-04-24 | Phase 2.1 vitest 跑 payload-truncate 截断测试，失败 assertion 把 13KB `'xxx...'` 完整 dump 到 stderr → 输出进对话 context → 后续 commit 流程被 AUP 拦截整轮回复 |
| P10 | 单测对生成的 SQL fragment 只做 regex / `toContain` 字符串匹配，没把生成的 SQL 灌进真 sqlite3 跑——broken SQL（语法错 / 列名错 / FTS 别名 MATCH 等）能从单测全过混上线，生产一调就抛。预防：涉及 SQL fragment 构造的纯函数测试要配独立「真 SQL 集成校验脚本」（`scripts/verify-fts5.sh` 即此类），跑在 system sqlite3 CLI 而不是 vitest（绕过 better-sqlite3 binding 不可用），并把 broken 形态作为 regression guard 验证它**仍然 fail** | 1 | 2026-04-24 | 2026-04-24 | Phase 4 N5 落地 search-predicate.test.ts 13 项全过，但 `fts MATCH @kw_fts` 别名形态在 SQLite parse fail（"no such column: fts"），整条 FTS 路径一搜就抛——Opus 4.7 现场用 sqlite3 CLI 跑出来的 |
| P11 | 「字节预算」类阈值用 `string.length` / `s.slice(0, max)` 比较截断——String.length 是 UTF-16 code units，不是 UTF-8 字节，emoji / 中文实际写入字节最高可达声明上限 3 倍；`slice(0, max)` 切到 surrogate pair 中间会切出孤儿 high surrogate（下游 JSON.parse 不报错但 UI 渲染替换字符 / 断字）。预防：任何与「字节」相关的阈值（SQLite 单行上限 / 网络协议 length-prefix / 文件名上限 / DB blob）一律 `Buffer.byteLength(s, 'utf8')` 算字节 + utf-8 安全切（找到 ≤ max 的最后一个 code point 边界），永不混用 `s.length` | 1 | 2026-04-24 | 2026-04-24 | REVIEW_4 H3: payload-truncate.ts 阈值 256K/8K 全用 string.length，emoji/中文实际可写 ~3× + truncateString 切 surrogate pair；测试只用 ASCII 'x' 验证骗不出该 bug |
| P12 | 依赖上游 SDK / CLI / 协议「文档默认行为」前必先最小复现脚本实测一遍——文档与实际行为不符是常态而非例外。涉及 fork / resume / streaming / 协议幂等性等关键假设的代码改动，没做实测就基于文档断言写「当前路径完全收敛」/「默认不会发生 X」类判断的，迟早被生产打脸。预防：写代码前先 5-10 分钟跑个最小脚本验证，把实测输出贴进 CHANGELOG / REVIEW 当证据 | 1 | 2026-04-24 | 2026-04-24 | CHANGELOG_24 备注「SDK 默认 resume: sessionId（不 fork）路径完全收敛」基于 sdk.d.ts:1255-1258 文档断言，但实测 CLI streaming + resume + 新 prompt 一定 fork → CHANGELOG_26 B 方案落地后用户场景仍然崩，REVIEW_6 才用最小复现脚本铁证根因 |
| P13 | 用 Map / Set / 数组的 `entries()` / `for...of` 反查 + `break` 推断「最新创建 / 最近匹配」的项——Map 迭代是**插入顺序**，break 取 first 不等于 latest；同 key 多次 set 不重排，新 entry 在末尾；同条件多 entry 时 first 是历史最早那条。预防：上游函数有返回值的话直接用返回值，不要事后反查；必须反查时显式按 ts / id / cwd+ts 排序后取 last，不要赌 iteration order | 1 | 2026-04-25 | 2026-04-25 | REVIEW_7 H1: sdk-bridge.ts recoverAndSend post-fallback 用 `for...entries() if cwd===rec.cwd break` 取 first 推断 newRealId，注释说「最新」但同 cwd 已有别的 SDK 会话时取错 → events/file_changes 子表错迁到不相关会话 |
| P14 | 跨进程 emit 顺序依赖未文档化的 IPC 队列序——main 端 `eventBus.emit(A) → emit(B)` 经 `webContents.send` 到 renderer 的顺序虽然在 Electron 同 webContents 内是串行的，但跨 channel / 经过 contextBridge 后语义未文档化稳定。renderer 端 store action 应对乱序鲁棒（任意顺序到达不破坏 by-session 数据），不依赖发端顺序。预防：renderer 端 `renameSession / removeSession / upsertSession` 等改 by-session 状态的 action，对「目标 key 已有数据」加 defensive `if (!next.has(toId))`，不覆盖较新数据 | 1 | 2026-04-25 | 2026-04-25 | REVIEW_7 M4: manager.ts renameSdkSession emit `session-renamed → session-upserted`，renderer 若 upsert 先到 → store.sessions.set(toId,newRec) 后 renameSession 用 fromRec 覆盖 → newer record 数据丢失（虽然 fork 路径下 NEW_ID 是新 id 几乎不会触发，但加 defensive 让乱序场景鲁棒） |
| P15 | React `setState((prev) => { ...; setView(x); select(y); return ...; })` updater callback 内调副作用——React StrictMode 开发态会双调 updater 验证 pure，setView / select 各执行 2 次（虽然第二次 noop 但反模式）；生产模式下也可能受并发渲染影响。预防：updater callback 必须 pure（仅返回新 state），副作用挪到外层（用 ref 持当前值在 listener 顶层比较 + 直接调副作用），或挪到 `useEffect` 监听依赖项变化 | 1 | 2026-04-25 | 2026-04-25 | REVIEW_7 L1: App.tsx onSessionRenamed listener 内 `setHistorySession((prev) => { if (prev?.id === from) { setView('live'); select(to); return null; } return prev; })` 在 updater 调 setView/select |
| P16 | Electron / Node main 进程未给 `process.stdout` / `process.stderr` 装 `'error'` listener——packaged GUI 模式下 launchd 把 stdout 接到一段 pipe，对端早期关闭后任何 console.log/error 立即抛 EPIPE → 因 stream 'error' 没 listener Node 升级为 uncaughtException → main 进程整个 die，HookServer / Helper / SDK 跟着退。预防：main 入口 imports 之后第一时间装 `process.stdout.on('error', () => {}); process.stderr.on('error', () => {});`，**不**接管全局 uncaughtException（语义副作用大）；调试输出长期方向是换 logger 而不是裸 console.log，但加 listener 是源头一次解决所有调用点的最小修 | 1 | 2026-04-29 | 2026-04-29 | REVIEW_10: 打包验证 wrapper 拉起后 main 立刻 EPIPE crash，stack 落在 window.ts:85 showOnce 的 console.log；grep src/main/ 全无 uncaughtException / stdout.on / stderr.on 兜底 |
| P17 | 「双通道防护」陷阱——给 SDK / 上游错误加 `expectedClose` 之类的 gate 时，必须同时 gate **catch 通道**（throw / abort / cleanup）和 **frame 通道**（SDK 自己合法推 is_error / error result message 然后正常关流），且**同分支内三个 sink 一起 gate**（红字 message / finished UI 状态 / mac 系统通知 routeEventToNotification 都靠同一 frame 触发）。只 gate 一边等于防护漏一半，只 gate 一个 sink 等于通道漏 2/3。SDK 把「应用主动 abort」翻译成 result 帧而非异常是常态（CLI 内部状态机检查不通过即合法 result frame，不抛错），通道差异通过红字文本前缀差异即可识别（catch 通道带「SDK 流中断：」前缀，frame 通道直翻 `⚠ ${detail}`）。预防：任何「区分应用主动 close 与意外抛错」的 flag 检查，先 grep 出所有 emit 红字 / error / finished / 系统通知的 sink 位置，整段 frame 在 flag 命中时**前置 return 整体静默**比逐个 sink 加 `&& !flag` 更稳 | 2 | 2026-04-29 | 2026-04-29 | REVIEW_11 Bug 1: D' 修法只 gate sdk-bridge.ts:1437 catch 块漏 line 1590 result frame；REVIEW_13 Bug 6: result frame 加 gate 但只 gate 红字 emit 漏 finished emit → routeEventToNotification 推 mac 系统通知「Agent 出错」 |
| P18 | 「allow = 同意退出」语义陷阱——SDK 工具协议中 `behavior:'allow'` 字面意义是「批准这次工具调用」，但某些工具的语义就是「请求退出当前模式」（典型 ExitPlanMode），allow 即**语义性退出**。如果业务想「批准内容但保持模式」必须改用 `behavior:'deny' + message` 形式让工具调用失败，通过 message 告诉 Claude「认可但保持模式」，**不能依赖事后 setPermissionMode 兜底**——post-allow 时序里 SDK 内部状态机已翻档，setPermissionMode 命中 race（CHANGELOG_47 同病灶 + REVIEW_11 Bug 3 双重证据：bypass 与 plan 都被 SDK 在 post-allow 窗口静默吞档）。预防：写 ExitPlanMode 类「mode-toggle 工具」的 resolver 时，识别哪些 targetMode 与「退出」语义冲突（plan→plan 即冲突），单独走 deny+message 分支并守卫外层不调 setPermissionMode；message 文案要明确「不要立刻再次调用同名工具」防 deny→retry 死循环 | 1 | 2026-04-29 | 2026-04-29 | REVIEW_11 Bug 3: ExitPlanMode resolver 对所有 approve 分支都 allow，CLI 把 approve+plan 视为退出 plan 立刻翻 default，外层 setPermissionMode('plan') race 失效 → UI 标签写「保持 Plan」实际行为是 default，下次 edit 走普通 PreToolUse 询问框 |
| P19 | 「同源黑名单只挡精确 ID」陷阱——sessionId 黑名单 / cwd claim 这类「按值匹配」的跨进程去重 / 隔离机制，对「上游进程内部 fork 出新 ID」/「上游 fallback 到不同 cwd 兜底值」的迟到事件天然失效。CLI 子进程被 SIGTERM 后内部 cleanup race 路径可能生成新 sessionId（与应用层 closeSession 时记录的 OLD_ID 完全无关）、可能用 HOME 兜底 cwd（而不是会话原始 cwd）—— 实测 approve-bypass 冷切场景两者**同时**发生 → recentlyDeleted 黑名单 + consumePendingSdkClaim 双兜底全失效，孤儿 source='cli' record 被创建。预防：跨进程边界的去重 / 隔离机制不能完全依赖「上游推上来的值」（sessionId / cwd / pid 都可能错乱），应在**应用 spawn 子进程时主动注入身份标记**（env / args / ipc handshake），下游事件靠该标记识别归属，不依赖业务字段。典型实现：env 注入 → hook 命令转发为 HTTP header → ingest 入口按 header skip。**误伤防线**：身份标记只对「应用主动 spawn 的子进程」生效，外部独立进程（用户终端跑 `claude`）天然没有标记，按「未知 / 默认外部」处理 → 零误伤 | 1 | 2026-04-29 | 2026-04-29 | REVIEW_12 Bug 5: REVIEW_9 1B (recentlyDeleted) + REVIEW_5 H1 (cwd claim) 双兜底防 approve-bypass 孤儿，但 OLD CLI fork 出新 sessionId Y + cwd=`/Users/apple` 兜底 → 两层全失效；改用 AGENT_DECK_ORIGIN env + X-Agent-Deck-Origin header origin tag 协议从源头解决 |
| P20 | 「调研 SDK / 第三方库能力时只看仓库当前调用面推断能力边界」陷阱——SDK 暴露的 API 远超应用当前用法是常态，仅靠 grep / 读 `sdk-bridge.ts` 当前 query options 等于把「没用过的能力」当「不支持」。Sub-agent 只看代码不查 `.d.ts` 时极易做出「SDK 不支持 X」类错判。与 P12 互补——P12 防「文档说有但实际没」（→ 实测），P20 防「代码没用就以为没」（→ 查类型定义）。预防：调研 SDK / 库能力时强制读 `.d.ts` 类型定义（grep 字段名 + Read 关键 section）+ 必要时实测；不能仅凭代码当前调用面下结论；prompt 给 subagent 时显式写「请查 d.ts 看可用但未用的能力，不要只看应用当前用法」 | 1 | 2026-04-30 | 2026-04-30 | REVIEW_14: Agent A Explore subagent 只读 sdk-bridge.ts:476-525 query options，错判「SDK 不支持 PreToolUse/PostToolUse hook，仅 canUseTool」+「Claude Code 无 OS 级沙盒」；主 agent 现场读 sdk.d.ts:1279 (hooks) / 1562 (sandbox) / 4656-4732 (sandbox 完整结构) / 1602 (managedSettings) 拿铁证反驳，三大能力 SDK 0.2.118 早就有，Agent Deck 100% 没用 |
| P21 | 「调研 SDK / 复杂系统**行为机制**时凭直觉 / 局部观察推断 → 误判」陷阱——sandbox / proxy / 双层防护这种「实际跑起来涉及多层并行 + 工具回路 + 环境变量注入」的机制，纯靠「现象观察 + 类比推理」很容易把表象误当根因。典型坏路径：「用户没看到弹框 → 推断分支没触发 → 标死代码」「curl 拿到 proxy 403 → 推断没用工具回路 → 改配置消除 network」。**两者真相都是有 log 一秒就揭穿但没 log 时怎么猜都是错**（双层并行不是二选一 / 自动 deny 路径用户看不到但 log 有铁证）。与 P20 互补——P20 是「能力存不存在」类（→ 查 d.ts），P21 是「行为怎么工作」类（→ 加 log + 实测）。预防：碰到 sandbox / proxy / 跨进程 / SDK 内置工具这类「行为机制」问题，**先在关键决策点加临时 log + 跑实证**（log 完成调查后清理 / 保留 1 行高价值的）；尤其「分支没触发」「字段不生效」这种「负断言」必须靠 log 证伪不能靠「用户视角没看到」 | 1 | 2026-04-30 | 2026-04-30 | REVIEW_15: 实施过程连续 4 次假设错误（managedSettings.sandbox 装载整套 / 不传 network 走工具回路代替 HTTP_PROXY / canUseTool 分支是死代码 / 是某字段触发 SDK 切模式）全被实测证伪；加 [canusetool] log 一秒揭穿真相（双层并行 + canUseTool 分支稳定生效），用户给 X-Proxy-Error: blocked-by-allowlist 头补完真相 |

<!-- 历史升级范例（已升到 CLAUDE.md 的可在此处留 1-2 行注解，便于追溯）：
- P1 + P2 + P5 同主题已半升级到「资源清理 & TOCTOU 防线」小节作为预防（CHANGELOG_16），但表里仍保留 count=1 等下次再撞同主题时计数推进
- U2 在 2026-04-24 count=3 走双对抗（Opus 4.7 + codex gpt-5.4 xhigh）三态裁决（修改后落地），新建「会话恢复 / 断连 UX（resume 优先）」小节升入 CLAUDE.md（CHANGELOG_25）
-->
