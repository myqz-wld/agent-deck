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

<!-- 历史升级范例（已升到 CLAUDE.md 的可在此处留 1-2 行注解，便于追溯）：
- P1 + P2 + P5 同主题已半升级到「资源清理 & TOCTOU 防线」小节作为预防（CHANGELOG_16），但表里仍保留 count=1 等下次再撞同主题时计数推进
- U2 在 2026-04-24 count=3 走双对抗（Opus 4.7 + codex gpt-5.4 xhigh）三态裁决（修改后落地），新建「会话恢复 / 断连 UX（resume 优先）」小节升入 CLAUDE.md（CHANGELOG_25）
-->
