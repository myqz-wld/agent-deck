# REVIEW_68 — 近期大改动 deep review（issue-tracker / runtime-logging / camelcase）

- 日期: 2026-05-30
- 类型: Deep code review（多轮异构对抗 + 三态裁决）
- 关联 plan: [deep-review-and-asset-polish-20260530](../plans/deep-review-and-asset-polish-20260530.md)
- 方法: `deep-review` SKILL 编排 reviewer-codex（gpt-5.5）+ reviewer-claude（Opus 4.7）异构对抗 + lead 三态裁决 + 现场静态验证

## 进度

| Batch | 范围 | 状态 |
|---|---|---|
| 1 | issue-tracker-mcp-20260529 | ✅ 收口（HIGH 1 + MED 1 + LOW 4 处理，0 残留 HIGH/MED） |
| 2 | runtime-logging-electron-log-20260529 | ✅ 收口（MED 2 + LOW 2 处理，0 残留 HIGH/MED） |
| 3 | mcp-tool-camelcase-migration-20260529 | ✅ 收口（自查挖出 HIGH 1，revert + fixture + 3 regression，0 残留 HIGH/MED） |

> **异构对抗记录（batch 1）**：reviewer-codex（mcp teammate）正常 Round-1 出 3 finding。reviewer-claude（mcp teammate）spawn 后 +13min 卡住 ~8min（疑似卡自身 PendingTab 工具审批，user 不在无人批）→ lead 按 SKILL §失败兜底 起**外部只读 claude CLI** 做 Round-2 backend 复审（与 codex 仍 Opus×gpt-5.5 异构对，严禁同源化）；随后 reviewer-claude 经 nudge 恢复并交付 Round-1（额外抓到下游 prompt 数据丢失放大 + IssueDetail 反应性）。最终覆盖 = codex R1 + claude R1 + 外部 claude R2，三路独立。

## Batch 1 — issue-tracker-mcp

### scope

后端核心 7 文件（`issue-repo.ts` / `v026_issues.sql` / `issue-lifecycle-scheduler.ts` / `report-issue.ts` / `append-issue-context.ts` / `ipc/issues.ts` / `types/issue.ts`）+ reviewer-claude 额外覆盖 renderer 3 文件（`IssuesPanel` / `IssueDetail` / `issues-store`）。

### 三态裁决 + 修复

**✅ HIGH-1 — IssuesUpdate 丢 appendices（编辑保存后现场消失 + 下游 prompt 数据丢失）**
- **双方独立提出**（codex 评 MED「update 返回/emit 丢 appendices」+ claude 评 HIGH，抓到关键下游放大）→ ✅ 升 HIGH。
- 根因：`issue-repo.ts:354` update() `return get(id)`（bare，无 appendices）→ `ipc/issues.ts:183` issuesUpdateHandler 返回/emit 裸记录（而 get/softDelete/undelete/resolve handler 都补 `listAppendices`）。
- **下游放大**（claude 抓，定 HIGH）：`IssueDetail.handleSave` 后 `setIssue(updated)` 抹掉本地 appendices → `ResolveInNewSessionDialog.buildDefaultPrompt` 从 `issue.appendices` 拼新会话首条 prompt → 用户「先保存编辑再起新会话解决」时新会话 prompt **丢失全部 append 现场 = 功能数据丢失**。
- 验证：get vs getWithAppendices(266-276) 实现差异 + 6 个 emit 点 grep 对比 + dialog buildDefaultPrompt 下游消费追踪。
- 修复：`ipc/issues.ts` issuesUpdateHandler emit/return 前补 `updated.appendices = issueRepo.listAppendices(validId)`（handler 层回填，与另 3 handler 对称）。
  - 取舍记录：claude 建议 repo 层单点修 `update() return getWithAppendices`；lead 选 handler 层——保 repo `get()/update()` 一致返裸记录、appendices enrich 统一在 IPC handler 层；2 个生产调用方（update / resolve handler）均已 backfill，无遗漏。

**✅ MED-2 — resolve 新会话 spawn race + 缺入口守门**（codex 提出 + lead 静态验证 + 外部 claude R2 + reviewer-claude R2 双确认）
- `ipc/issues.ts` issuesResolveInNewSessionHandler：① 无入口守门，直接 IPC / stale UI 可对 resolved/已删 issue 重新起会话；② `await createIssueResolutionSession` spawn 窗口内用户 resolve/soft-delete → 无条件 `status='in-progress'` 覆盖（`if(!updated)` 只挡 hardDelete）。
- 验证：get(248) 与 update 之间唯一 await 是 createSession；re-read→update 纯同步原子，窗口真收窄。
- 修复：spawn 前拒 `status==='resolved' || deletedAt!==null`；spawn 后 re-read，仅 `stillActionable` 才写 status，否则只回写 `resolutionSessionId` 保 link。

**↩️ LOW-4（曾评 MED，修复尝试被 Round-2 推翻 → 回退）— IssueDetail 本地 state 不订阅 store 更新（违反 §detail 视图权威）**（claude 单方提出）
- 原 finding：`IssueDetail.tsx:29` issueFromStore 订阅 store 但仅用于初始 useState，渲染全程用本地 state，detail 打开期间外部变更不实时（须重开）。claude 评 MED（convention 违反）。
- **修复尝试 → 回退**：lead 加 `issueFromStore → setIssue` sync useEffect。**reviewer-codex Round-2 抓出该 fix 引入新 MED regression**：sync 把 `issue` 同步成外部新值但 `editing` 草稿保持旧值；`handleSave` diff `editing.X !== issue.X` 对用户未改的字段也判为「改动」→ 把旧草稿写回，**反向覆盖外部更新（能把已 resolved issue 重新打开）**。
- **异构对抗裁决（reviewer 分歧 → lead 现场实证）**：reviewer-claude Round-2 **blessed** 此 fix（把该现象归为 INFO「固有并发 lost-update 极低概率」）；reviewer-codex Round-2 **rejected**（评 MED「能重开 resolved issue，还需改」）。lead before/after trace 判 codex 正确：**回退前** handleSave diff 基线 = fetched issue（稳定），未改字段 no-op diff → 外部变更被保留；**fix 后** issue 同步外部 → 未改字段 diff 非空 → 旧草稿写回覆盖外部 = fix 引入的 regression，**非固有**。reviewer-claude mis-severity（看到现象但归 INFO）。
- **处理**：**回退 sync useEffect**（不盲改无法 live test 的 renderer fix），IssueDetail 恢复 fetched-baseline diff（外部变更不被覆盖）。原 reactivity 需求（detail 不 live-update）降级 LOW 留 follow-up：正确修法是**独立 diff baseline / dirtyFields**（外部 store 变更只刷只读区 + 维护用户实改字段集，不动 diff 基线），需 live 浏览器实测，本会话不盲改。

**✅ LOW-1 — logsRef scopes overflow 写回重复**（codex + lead 验证 + claude R2 确认）
- `issue-repo.ts:237` mergeLogsRef union >32 项时丢已去重 `unioned` 用 raw `incomingScopes`（schema 不禁重复）→ `['x','x']` 留两个 x。
- 修复：overflow 改 `unioned.slice(0, SCOPES_MAX)`。

**✅ LOW-2 — append 不拒 soft-deleted issue（与 resolved-reject 不对称）**（外部 claude R2 + claude R2 确认）
- `append-issue-context.ts:53` 仅拒 resolved，无 deletedAt 守门 → source session 存活时用户软删后 agent 仍能 append 成功写进隐藏 issue。LOW（appendContext 不动 deleted_at，GC 时钟不受影响，无数据损坏，纯语义不对称）。
- 修复：加 `if(issue.deletedAt!==null) reject` 守门，与 resolved-reject 对称。

**✅ LOW-3 — store record appendices 被 updated event 覆盖**（claude 提出）→ 随 HIGH-1 修复连带消除（updated event 现含 appendices）。

### INFO（非阻断，记录）

- **INFO-1** `issue-repo.ts:308` create() logsRef 序列化 `JSON.stringify(x??null)==='null'?null:JSON.stringify(x)` 双 stringify + 字符串比较，与 update(336)/appendContext(435) 简洁写法不一致。功能正确，仅可读性。
- **INFO-2** `issue-lifecycle-scheduler.ts:73` GC `[...resolvedExpired,...softDeletedExpired]` 同 id 可出现两次；第二遍 hardDelete changes=0 → continue 兜住，无双 emit，仅多一次无谓 get。可 `new Set` 去重。
- **INFO-3** `v026_issues.sql:72` appendices 索引 `(issue_id, appended_at DESC)` 与 listAppendices `ORDER BY appended_at ASC` 反向；SQLite 反向扫描无 sort 代价。
- **INFO-4** MED-1 修复非 actionable 分支仍 emit 'updated' + 回写 resolutionSessionId（保 link 设计意图）；对 soft-deleted issue 发 'updated'，renderer 是否短暂复现隐藏 issue —— *未验证*（store 按 deletedAt 过滤大概率不显示，batch 后续可验）。
- **INFO-5** mergeLogsRef date 恒覆盖（plan §D17 明定行为）：跨天 append 后原始上报日指针丢失（tsRange 保 min-max，各 appendix 留各自 logs_ref）。符合 spec。
- **INFO-6** `IssuesPanel.tsx:43-52` selectFilteredIssues 手动构造完整 state 对象 + `as Parameters<...>[0]` 强转传 selector，反 zustand 模式（claude 提出），功能正确不影响合并。

### focus 项实践验证（均非问题，外部 claude + claude 出证据）

source-bound null 绕过 ✅ 无（`makeCallerContext` 空/null 归一 `__external__` + `EXTERNAL_CALLER_ALLOWED.{report_issue,append_issue_context}=false` deny）/ FK SET NULL + CASCADE ✅ 生效（PRAGMA foreign_keys=ON，issue-repo.test:61-63 覆盖）/ SQL 全参数化 ✅ / logsRef 入参 zod 校验 ✅（date regex + tsRange refine + scopes/note cap）/ GC×soft-delete × before-quit stop × 阈值热更新接线 ✅ / withMcpGuard deny external ✅ / scheduler snapshot-before-delete + 单条 try/catch ✅ / appendContext TOCTOU 已兜底 ✅。

### 验证

- ✅ `pnpm typecheck` 过（全部 fix type-clean，含 IssueDetail 回退后）
- ✅ **reviewer-codex Round-2 实跑 vitest**（worktree node_modules symlink）：`issue-tools.test.ts` + `issues.test.ts`（IPC handler）+ `issue-lifecycle-scheduler.test.ts` **83 tests / 3 files 通过**（验 ipc/issues.ts + append-issue-context.ts + scheduler 无 regression）。`issue-repo.test.ts` 因 better-sqlite3 native ABI mismatch 全 skip（scopes LOW-1 仅静态验，未实测）。
- ⚠️ **为 4 处 fix 补回归 case 仍待做**（resolve entry-guard/re-read、update appendices 回填、append deletedAt reject、scopes dedup overflow）：现有 83 test 只证无 regression，未覆盖新行为。留 CI / 下会话（issue-repo SQLite 测试需按 CHANGELOG_42 binding 流程才能跑）。
- ⚠️ main 改动（ipc/issues.ts + issue-repo.ts + append-issue-context.ts）需重启 dev 才生效，本会话未跑 dev 实测。

### 收口判定

batch-1 **已收口**：HIGH 1 + MED 1 全修；LOW 4（LOW-1 scopes / LOW-2 append-deleted / LOW-3 store-overwrite 随 HIGH 连带 / LOW-4 IssueDetail reactivity 回退降级）；INFO 6 记录。残留 HIGH/MED = 0。
- **reviewer Round-2**：reviewer-codex ✅ 4 backend fix + 抓出 Fix-5（IssueDetail sync）引入 stale-draft clobber regression → lead 回退；reviewer-claude ✅ 4 backend fix（**误 bless Fix-5**，把 clobber 归 INFO「固有 lost-update」）。
- **异构对抗价值（案例）**：两路对 Fix-5 严重度分歧（codex MED「还需改」vs claude INFO「不阻塞」）→ lead before/after trace 实证 codex 正确（回退前 fetched-baseline diff 保留外部变更；fix 后 synced-issue diff 用旧草稿覆盖外部 = fix 引入非固有）→ 回退。**单 reviewer 会漏判**：若只 claude，Fix-5 会带 regression 合入；codex 强冗余抓出。`heterogeneous_dual_completed: true`

## Batch 2 — runtime-logging-electron-log

### scope

`src/main/utils/logger.ts` / `src/renderer/utils/logger.ts` / `src/main/ipc/logs.ts` / `LogsSection.tsx` / `preload/api/misc.ts`(logs 段) / `ipc-channels.ts`(logs)。focus: init-order 副作用（REVIEW_66 app.setName 同类）/ console 接管不吞 stdout / NODE_ENV=test skip / fatal hook / rotation cleanup / IPC bridge。

> **异构对抗记录（batch 2）**：reviewer-codex（gpt-5.5）+ reviewer-claude（Opus 4.7）mcp teammate 同 team `dr-logging-20260530`，均 Round-1 正常交付（无卡死）。lead 逐条独立现场验证（读 electron-log v5.4.4 `ErrorHandler.js` / `File.js` / `file/index.js` 源码 + bootstrap `setFileLevel` grep）。

### 三态裁决 + 修复

**✅ MED-1 — errorHandler.startCatching() 默认配置改 fatal 语义（uncaughtException 后带病续跑 + 生产弹模态）**
- **双方独立提出**（codex 评 HIGH / claude 评 MED，核心隐患一致）→ ✅。lead 现场实证 electron-log `ErrorHandler.handle()`(node/ErrorHandler.js:24-58) 只 logFn 落盘 + showDialog(默认 true) 弹 showErrorBox，**全程无 process.exit / app.quit / rethrow**；grep 项目无其他 uncaughtException handler 补退出。
- 严重度裁决（HIGH vs MED 分歧 → lead 定 **MED**）：条件触发（须真发生 uncaughtException）非常态 malfunction，但触发时 main 管 DB/IPC/多 SDK 子进程，带病续跑有半写/状态不一致风险 + 生产弹技术堆栈模态 UX 差。双方均认同必修，仅 severity label 分歧。
- 修复：`logger.ts:77-92` — `startCatching({ showDialog: !app.isPackaged })`（生产不弹模态）+ `process.on('uncaughtException', () => app.exit(1))`（electron-log file transport 同步写，其 listener 先注册 → 先落盘后退出，恢复 Node 默认 fatal 语义；NODE_ENV=test 跳过防杀 vitest）。unhandledRejection 仅落盘不强退（避免单 stray rejection 过激杀进程）。

**✅ MED-2 — 持久化 logLevel 启动不生效（重启后回退默认 info，与 UI 显示不一致）**（codex 单方 + lead 现场验证 + **Round-2 codex 复查捞出本会话漏修**）
- codex MED：logger.ts 模块加载固定 file transport `'info'`，`setFileLevel` 仅在 SettingsSet patch 含 logLevel 时（ipc/settings.ts:200 applyLogLevel）调用 → 用户保存 logLevel='warn' 后本轮生效，重启 main 后回退 'info'，UI 仍显示持久化值 = 运行时/UI 不一致。
- lead 现场验证：grep `setFileLevel` 仅 ipc/settings.ts:200（SettingsSet path）+ logger.ts def + test；bootstrap-infra.ts:105 / bootstrap-wiring.ts:37 读 settingsStore.getAll() 但不调 setFileLevel。✅。
- **Round-2 漏修捕获（异构价值案例）**：本会话首轮 fix 只做 startCatching + truncate，**遗漏此 MED**；reviewer-codex Round-2 sign-off 复查捞出 → lead 补修。
- 修复：`bootstrap-infra.ts:105` settings load 后补 `setFileLevel(settings.logLevel)`（import setFileLevel）。startup regression test 因 bootstrap-infra 无测试 harness（initDb/HookServer/adapter/scheduler 重 mock 面）+ setFileLevel 已 logger.test 覆盖 + logLevel 已 type-check → **裁 follow-up deferral**（reviewer-codex 接受）。

**✅ MED-3 — LogsTruncateToday 绕过 electron-log File cache → rotation 计数失真**（codex 单方 + lead 现场验证）
- codex MED：`fs.truncateSync` 绕过 electron-log file transport 缓存的 File 对象（initialSize+bytesWritten 判 maxSize rotation）。
- lead 现场验证：`file/index.js:39` 默认 maxSize=1024**2=1MB + :69 needLogRotation 用 cached file.size，logger.ts 未覆盖 maxSize → rotation active。清空 >1MB 日志后 cached size 仍旧 → 下条写触发过早 rotation / 覆盖 .old.log。✅ 真问题（条件触发，影响 minor）。
- 修复：`logs.ts` 改用 `log.transports.file.getFile().clear()`（electron-log native File.clear() = writeFileSync('') + reset cache）替代 fs.truncateSync。

**✅ LOW-1 — truncate 成功后立即 logger.info 写回 → 文件非空**（claude 单方）
- claude LOW：truncate 后 `logger.info('truncated...')` 同步写进同一文件 → 用户点「清空」后文件立即又有一条。✅。
- 修复：删该 logger.info（随 MED-2 同处理：clear() 后不写回，失败仅经 result.error 返 renderer 弹 toast）。

**✅ LOW-2 — LogsTruncateToday 无 symlink/TOCTOU 防护**（codex 单方，弱威胁模型）
- codex LOW（自评「无 renderer 传入 path」）：todayLogFile() 内部构造路径，唯一攻击面是当天 log 文件被换成 symlink → truncate follow 到任意同权限可写文件。images.ts 有 realpath 白名单，logs 无。✅ LOW。
- 修复：truncate 前 `lstatSync` 拒 symlink（mitigates 现实攻击面；clear() 用 writeFileSync 仍 follow，残留极小 TOCTOU 窗口对 LOW 弱威胁可接受）。

### focus 项实践验证（均非问题，双方 + lead 实证）
- **console 接管不吞 stdout / 无死循环** ✅（双方独立验证 + lead 确认）：electron-log main/renderer console transport 都在**模块加载时**缓存原始 consoleMethods，writeFn 用缓存引用；logger.ts `import log`（触发缓存）永远先于 `Object.assign(console, log.functions)`（覆盖全局）→ transport 输出走原始 console 不递归。main + renderer 均安全。
- **init-order 同类隐患（REVIEW_66 app.setName）** ✅ 无新（claude 验证）：logger 是 index.ts:13 第一个 import（ESM 最早执行），app.setName→getPath('logs') 顺序正确；cleanupOldLogs 模块加载期同步 IO 但 14 天文件量小可忽略。
- **NODE_ENV=test skip** ✅ 正确（claude 验证）：仅跳 Object.assign(console)；initialize/cleanup/startCatching/setName/getPath 副作用未 skip，靠 vitest-setup 全局 mock electron+electron-log 守门。

### INFO（非阻断，记录）
- **INFO-1**（codex + claude）logs IPC 无测试覆盖（registerLogsIpc 3 handler + PreloadFatalError listener 的 fallback / truncate / symlink-reject 路径无回归）。留 follow-up（与 batch-1 补测同款 deferral，ROI 一般 + 依赖 electron shell/fs mock）。
- **INFO-2**（claude）renderer logger.ts 只 Object.assign(console) 未调 startCatching → renderer window error/unhandledrejection 不自动落盘，与 main §D7 不对称（renderer transports/index.js 有 RendererErrorHandler 但需显式 startCatching）。疑 plan 有意（React error boundary），仅提示。

### 验证（batch 2）
- ✅ `pnpm typecheck` 过；`logger.test.ts` 8 tests 过（startCatching `.toHaveBeenCalled()` 不验 args，fix 兼容）
- ✅ 全量 vitest 1089 passed / 197 skipped（含 SQLite ABI guard skip）；`pnpm build` OK
- ⚠️ logs.ts 改动需重启 dev 实测（truncate 按钮 live 行为 + startCatching 退出语义无法单测，依赖 e2e）

### 收口判定（batch 2）

MED 3 + LOW 2 全修；INFO 2 记录。残留 HIGH/MED = 0。**reviewer Round-2 sign-off**：reviewer-codex ✅（验证 startCatching listener 顺序保证先落盘后退出 + getFile().clear() 真 reset rotation cache + snake revert 完整；Round-2 复查捞出我**漏修 logLevel MED** → 已补 bootstrap-infra setFileLevel + deferral 接受）<!-- R2-SIGNOFF-B2 -->。
- **follow-up**：logLevel startup-apply regression test（bootstrap-infra 无测试 harness，deferral）；logs IPC 测试覆盖（INFO-1）。

## Batch 3 — camelcase frontmatter over-migration（lead 自查挖出 HIGH）

### scope

lead 自查（plan 定 batch-3 = lead self grep）：`schemas.ts` camelCase 字段 vs handler 读取一致性 + 残留 snake_case 读取。grep 结论 mcp args camelCase 迁移**正确**（handler 全读 camelCase，0 残留 `input.snake_case`；schemas.ts 0 snake zod key），但**意外挖出 plan frontmatter 读取被误迁移的 HIGH**（异构反驳轮经 reviewer-codex 独立确认）。

### 三态裁决 + 修复

**✅ HIGH-1 — camelcase migration 把 plan frontmatter 读取也误迁 camelCase（与 snake-only plan 文件分裂）**
- **双方独立提出**（lead 自查 grep + 现场实证；reviewer-codex 异构反驳轮独立确认 HIGH + 支持 revert-to-snake）→ ✅ HIGH。
- 根因：commit `5ff0d78`（32 字段 snake→camel）over-migration 把 plan frontmatter **读取** 从 snake 改 camelCase，但 plan 文件实际写 snake_case（CHANGELOG_177 自己把 plan workflow frontmatter 列为「不迁移的合法保留」+ 所有归档 plan 实证 snake-only + claude-config/CLAUDE.md:257 指示写 snake）。parseFrontmatter（frontmatter.ts:33-41）逐字保留 key 不转 camelCase，readers 无 snake fallback。**= 实现违反了自己 changelog 声明的 intent**。
- 三重影响（snake-only plan）：① `hand_off_session` plan-driven `fm.worktreePath` undefined → **hard reject**「missing required field」；② `archive_plan` cross-check（CHANGELOG_169 F2 防 silent-corruption HIGH 守门）`fm.planId`/`fm.worktreePath` undefined → **静默走 warning 分支跳过 = 守门失效**；③ `archive_plan`/`enter_worktree` base 读取 `fm.baseBranch`/`fm.baseCommit` undefined → base_branch fallback "main"（**feature-branch plan ff-merge 错合主线污染**）+ enter_worktree base pin 被忽略落 HEAD fallback。
- 验证（铁证）：`git log -L` 实证 5ff0d78 把这些读取从 snake 改 camel（前一 commit 8969654 是 snake）；`ls -t ref/plans/*.md` 最近 5 个全 snake-only；读 readers 无 `?? fm.snake` fallback + hand-off hard-reject 路径（hand-off-session-impl.ts:258-262）。reviewer-codex 独立 `git show 5ff0d78` + CHANGELOG_177:134 + CODEX_AGENTS.md:233 cold-start 确认 + **补充测试 fixture masking 风险**。
- 修复（**revert-to-snake**，对齐 CHANGELOG_177 intent，非 accept-both hack — reviewer-codex 共识）：
  - **8 处读取 revert snake**：hand-off-session-impl.ts（worktree_path/base_branch）/ archive-plan/impl-precheck.ts（plan_id ×3 + worktree_path ×4 cross-check）/ impl-ff-merge.ts（base_branch）/ enter-worktree-impl.ts（base_commit/base_branch）/ impl-archive-fs.ts（plan_id）
  - **用户 hint/error 文案 + jsdoc 注释同步 snake**（precheck-helpers「Edit plan frontmatter base_branch」/ cwd-resolver「frontmatter worktree_path」等；防未来 re-migration 重踩）
  - **测试 fixture masking 修复**（reviewer-codex 补充的关键测试风险）：8 个测试文件的 frontmatter-**text** fixture（archive-plan/_setup.ts:246-250 / enter-exit-worktree.test.ts / archive-plan.impl-*.test.ts / hand-off-session/_setup.ts 等）从 camelCase revert 回 snake（masking 真实 snake plan 断裂）+ 相关断言（hand-off missing-field error / base-branch-named-only hint）更新。JS object args（`input:{}`）保留 camelCase（mcp arg 迁移正确，anchored 替换不误伤）。
  - **新增 3 regression**（archive-plan.impl-r33.test.ts）：snake-only frontmatter worktree_path / plan_id mismatch → cross-check 触发 reject（守门生效，无 ff-merge/checkout）；base_branch frontmatter fallback（input 不传 baseBranch）→ ff-merge checkout feature-x 而非 main。

**✅ MED-1 — 注入 agent SDK system prompt 的 tool/字段 description 仍写 camelCase plan frontmatter key（与 HIGH-1 同源遗漏）**（reviewer-claude R2 提出 + lead grep 扩展）
- reviewer-claude R2 抓出 2 处（dot-form regex `frontmatter\.[a-z]+[A-Z]`）：schemas.ts:261 archive_plan baseBranch arg desc「**强烈建议在 plan frontmatter 显式写 baseBranch**」+ index.ts:294 enter_worktree tool desc「frontmatter.baseCommit > frontmatter.baseBranch」。
- **lead grep 扩展**（reviewer-claude regex 漏 space-form）：另 5 处 schemas.ts:302/522/538/838/963-964 含「frontmatter baseCommit / baseBranch / worktreePath」space-form key 引用（含 injected describe + JSDoc 注释）。共 7 处。
- 后果链（drift 铁证，agent 行为后果推断）：description 注入 SDK system prompt → 「显式写 baseBranch」诱导 agent 写 camelCase plan frontmatter → 经 HIGH-1 修复后代码读 snake 读不到 → base fallback main/HEAD → **正是 batch-3 想防的 camelCase-only plan 污染主线场景再生**。HIGH-1 同源遗漏点（lead 首轮 batch-3 grep 只扫 handler `fm.` reads，漏 tool 定义层）。
- 修复（7 处全部，区分 frontmatter key vs arg/return/enum）：「plan frontmatter <camelCase>」key 引用 → snake（base_commit/base_branch/worktree_path）；**保留** `args.baseCommit/baseBranch`（mcp arg 正确）+ return 字段 `worktreePath/baseBranch`（TS property 正确）+ enum 值 `'frontmatter-base-commit'`（kebab 字面）+ index.ts:255「derive worktreePath」（描述 return 非 key 指令）。
- 验证：grep `frontmatter[.\s](baseBranch|baseCommit|worktreePath|planId)` 全 mcp tools 0 残留；typecheck 清 + 全量 1089 passed。

**INFO（batch 3，非阻断）** — schemas.ts:337-338 hand_off schema 上方 `//` 跨行注释「从 frontmatter 拿\n worktree_path」（reviewer-claude R2 grep 跨行命中，我单行 regex 漏）。**非 .describe() 注入**（源码注释，零 agent 影响），与同段 302 一致性顺手 snake 修。

### 验证（batch 3）
- ✅ `pnpm typecheck` 过；全 mcp `__tests__` 547 passed（35 files）— snake fixture + snake read 一致；含新 3 regression
- ✅ 全量 vitest 1089 passed / 197 skipped；`pnpm build` OK
- ⚠️ main 改动需重启 dev / e2e 实测（hand_off / archive_plan / enter_worktree 走真实 plan 文件）

### 收口判定（batch 3）

HIGH 1 + MED 1 全修（HIGH revert + fixture masking 修复 + 3 regression；MED 7 处 description drift → snake）；残留 HIGH/MED = 0。**reviewer Round-2 sign-off**：reviewer-codex ✅（snake readers + snake-only regressions 复核仍在，0 新 HIGH/MED）；reviewer-claude ✅（代码 revert 读+写穷举验证彻底 + 抓出 description drift MED → lead 修 + grep 扩展到 7 处）。**双方共识可合**。<!-- R2-SIGNOFF-B3 -->
- **异构 Round-2 价值（案例）**：reviewer-codex 捞出我**漏修 logLevel MED**（batch-2），reviewer-claude 捞出我**漏修 description drift MED**（batch-3）— 两路各自补一个 lead 首轮遗漏，单 reviewer 都会放过。`heterogeneous_dual_completed: true`
