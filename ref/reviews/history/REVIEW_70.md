# REVIEW_70 — issue-tracker 草稿状态机 + codex sdk-bridge win32 多平台 deep review

- 日期: 2026-05-31
- 类型: Debug / 数据正确性 + 多平台回归（聚焦 BUG 排查 + 代码优化）
- 触发: 用户「deep review，聚焦于 BUG 排查和代码优化」+ 自主推进 / 自主 hand off。scope 由 lead 基于 git 最近改动（HEAD~6→HEAD）+ 已审文件过期机制自定。
- 关联: CHANGELOG_189（issue-tracker 体验 + update_issue_status 协议）/ CHANGELOG_188 / REVIEW_69（codex-sdk 0.135 升级）/ commit 5b3c875..6da8db5
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh，in-process SDK teammate）+ 反驳轮 + 三态裁决。**补 REVIEW_69 缺口**：那轮 reviewer-claude 因外部 `claude -p` 在 background-Bash sandbox 系统性 hang 缺席 = codex-binary / issue UI 从未经完整异构对抗；本轮走 deep-review SKILL in-process teammate（不撞外部 CLI hang）补齐。
- 收口: 批 A 4 轮 + 批 B 2 轮，双 reviewer 均明确 conclude。typecheck + build + 全量 1138 passed / 197 skipped（SQLite ABI 门控）。

## 范围（两批）

**批 A — issue-tracker 协议 + UI**（10 文件，重点 update_issue_status 新协议从未经异构对抗）：
- src/renderer/components/IssueDetail.tsx（草稿状态机重构）
- src/renderer/components/issue-detail-editing.ts（**新建** — 纯逻辑抽离，可单测）
- src/renderer/components/IssuesPanel.tsx / ResolveInNewSessionDialog.tsx / stores/issues-store.ts
- src/main/agent-deck-mcp/tools/handlers/{update-issue-status,append-issue-context,report-issue}.ts / types.ts / schemas.ts

**批 B — codex sdk-bridge**（codex-sdk 0.135 + bundled rg PATH，REVIEW_69 单方 + 仅 darwin-arm64 覆盖不足）：
- src/main/adapters/codex-cli/sdk-bridge/codex-binary.ts
- src/main/adapters/codex-cli/sdk-bridge/index.ts / codex-instance-pool.ts（核实无 bug）

## 三态裁决

### 批 A — issue-tracker（4 数据正确性 HIGH/MED + 2 MED + 2 LOW）

#### ✅ HIGH-A 跨 issue 草稿污染（reviewer-claude 单方 + lead node 复现）
`<IssueDetail issueId={selectedIssueId}>` 未 keyed + `editing` buffer 在 issueId 变化时从不重置。两个 effect 的 `hasDraft` 守护把「A 的草稿」与旧 base(=issue A) 比对 → 切到 B 时 base 仍是 A → hasDraft 恒 true → B 的数据永远 load 不进 editing → handleSave 用 A 草稿 diff issue B → `issuesUpdate(B, A的全字段)` = **持久跨 issue 数据损坏**。
- 验证：lead node 1:1 复刻组件逻辑实测 `issuesUpdate("BBB", {title:"A EDITED", description:"A desc", status:"open", ...})` 污染确认。
- 修复：IssuesPanel.tsx `<IssueDetail key={selectedIssueId}>` 强制 per-issue remount（fresh state）为主防线 + buildUpdatePatch `expectedIssueId` 守护为第二道防线。

#### ✅ HIGH-B 外部改字段、用户没碰 → 保存回滚（reviewer-codex 单方 + lead node 复现）
解决会话改 status=resolved 后，用户只改 title 点保存 → 旧 editing.status='open' 一起被 diff 提交 → 静默 reopen。
- 验证：lead node 复现 `patch={title, status:'open'}`。
- 修复：见下方 baseline 模型（4 轮迭代收敛）。

#### ✅ Round2-HIGH 碰过 status 又改回原值 → 回滚（reviewer-codex 单方 + lead node 复现）
首版修复用「dirtyFields: Set 记录触碰历史」。用户点 status open→in-progress→改回 open 后 dirty 仍含 status（永久标记），外部改 resolved → rebase 保留旧 open → save 提交 open 回滚。根因：dirty 用「曾触碰」语义无法表达「改回了」。

#### ✅ Round3-MED 冲突字段改回旧值 stale no-op / UI-DB 分叉（reviewer-codex 单方 + lead node 复现）
第二版修复用「editing vs baseline 提交判定 + 冲突字段保留旧 baseline 锚点」。baseline=open，用户改 in-progress（草稿），外部改 resolved（rebase 保留 editing=in-progress + baseline=open），用户改回 open → editing===baseline → 空 patch 跳 IPC → UI 显 open 但 DB 留 resolved 分叉，且用户无法改回 open。

**HIGH-B / Round2-HIGH / Round3-MED 统一根治（baseline 模型 v2，4 轮收敛）**：
- 新建 `issue-detail-editing.ts` 抽纯逻辑（与 session-list-tree.ts 同款约定，node-env 可单测）
- `editing`（用户缓冲）+ `baseline`（= 最新已知服务器值快照，每次 rebase 推进 latest）双 state
- **提交判定** `buildUpdatePatch(editing, issue, expectedIssueId)`：比较 editing vs **最新 issue**（非 baseline）—— 修 Round3-MED（冲突字段改回旧值时 editing(open)!==issue(resolved) → 提交 open，UI=DB 一致）
- **草稿判定**（rebase 内）：editing[k] vs prevBaseline[k] 归一化比较 → 无草稿同步 latest、有草稿保留
- labels 归一化（parseLabels split/trim/filter）：「a,b」vs「a, b」等价
- reviewer-claude Round 4 验证核心不变量：`baseline.fields === toEditing(issue).fields` 在每个 committed 态恒成立（多 event 叉乘 node sim 验证）

#### ✅ MED 二次起解决会话覆盖 resolutionSessionId（reviewer-claude 单方 + lead 读代码确认）
in-progress 时「起新会话解决」按钮仍显示（`!isResolved`）→ 再次点击覆盖 resolutionSessionId → 前一解决会话失去 update_issue_status 授权（静默）。
- 修复：按钮文案在已有 resolutionSessionId 时变「换解决会话」+ title 提示；ResolveInNewSessionDialog 顶部加 warning banner。

#### ✅ MED 测试盲区（reviewer-claude 单方 + lead find 确认）
IssueDetail 草稿逻辑（HIGH 所在）零自动化覆盖（vitest node env 无 jsdom）。
- 修复：抽 issue-detail-editing.ts 纯逻辑 + 新建 issue-detail-editing.test.ts（23 case：dirty 闸门 / rebase / HIGH-A 守护 / HIGH-B / Round2-HIGH / Round3-MED 端到端叉乘）。

#### ✅ LOW append hint 误导（reviewer-codex 单方 + lead 读代码确认）
append-issue-context resolved-reject hint 说「源/解决会话可先 reopen 再 append」，但 append 是 strict source-bound（能走到 resolved-reject 必已过 source 校验 = 必是 source 会话），提到「解决会话」误导。
- 修复：改 hint 措辞「能走到这步说明你是该 issue 的源会话」。

#### MED-1 debounce 旧 filters 覆盖刚切 tab（reviewer-codex 单方 + lead node 复现）
IssuesPanel debounce effect 只依赖 keywordInput，timeout callback 捕获旧 filters。用户输入搜索后 300ms 内切「已解决」tab → 旧 timeout 用旧 filters 覆盖回「活跃」。
- 修复：issues-store setFilters 支持 functional updater + debounce 用 `setFilters(prev => ...)` 读最新。

#### INFO（批 A，留 follow-up，非阻塞）
- 同毫秒 updatedAt 短路（store-sync `base.updatedAt === issueFromStore.updatedAt` guard 对同 ms 双更新漏一拍，只读显示滞后，低概率）
- LOW-2 删→恢复后草稿复活（handleSoftDelete/Undelete 只 setIssue 不动 editing；同 issue 可见非静默，「删错恢复草稿还在」语义歧义，双 reviewer 认同留 INFO）
- 后端 update_issue_status 授权模型三方核查通过（callerSid in-process closure 不可伪造 / resolutionSessionId 仅 IPC 写 UPDATE_PATCH_SCHEMA .strict() 挡 UI / 双 null 不误放行 / external 全 deny）

### 批 B — codex sdk-bridge（1 HIGH + 1 MED + 1 LOW，全 win32 平台特定）

#### ✅ MED win32 binName 硬编码（lead 预审单方 + 双 reviewer 独立确认）
`resolveBundledCodexPathDirs` line 101 硬编码 `join(vendorTripleDir, 'bin', 'codex')` 探测 new 布局，但 win32 binName 是 `codex.exe`（PLATFORM_BINARY_MAP）→ win32 new 布局 bin/codex 不存在 → 误判 legacy → fallback path/ 也不存在（new 是 codex-path/）→ 返 [] → win32 打包版 bundled rg 不注入。与隔壁 resolveBundledCodexBinary 用 spec.binName 不对称。REVIEW_69 单方 + 仅 darwin-arm64 覆盖漏掉。
- 修复：改用 spec.binName 探测。

#### ✅ HIGH win32 PATH key/casing 分叉（双方独立提出 — reviewer-claude 标 HIGH / reviewer-codex 标 MED → 异构强冗余确认）
`prependBundledCodexPathDirs` 硬编码读写 `env.PATH`，但 win32 env key 大小写不敏感、实际常是 `Path`（snapshotProcessEnv verbatim 拷贝）→ 当前逻辑留下原 `Path` + 新增只含 helper 的 `PATH` → codex 子进程读 `Path`（无 helper）→ bundled rg 不生效。
- **激活链洞察**（reviewer-claude）：修复前 win32 resolveBundledCodexPathDirs 返 [] → prepend early return 不碰 PATH → 此 bug **dormant**；lead 的 binName 修复让 win32 返 [codex-path] → prepend 真正执行 → 撞 env.PATH 硬编码 → bug **激活**。两者必须一起修。
- 验证：lead 读 SDK 0.135 dist/index.js:472-490 pathEnvKey/prependPathDirs + node trace win32 {Path} 分叉复现；双 reviewer 独立 trace（codex 覆盖 {PaTh}→PaTh 等 casing 边角）。
- 修复：移植 SDK pathEnvKey（win32 选 case-insensitive path key，优先 Path）+ prependBundledCodexPathDirs win32 删其他大小写变体 + prepend 到选中 key。

#### ✅ LOW new 布局双条件（reviewer-claude 单方 + lead 读 SDK 源码确认）
SDK resolveNativePackage 判 new 布局 = `isFile(bin/<binName>) && isFile(codex-package.json)` 双条件 + 用 isFile（statSync().isFile()）；旧实现只判 existsSync(bin/<binName>) 单条件 → 畸形布局「有 bin/codex 但无 codex-package.json」时与 SDK 分叉。
- 修复：抽 `isNewLayout(vendorTripleDir, binName)` helper（两个 resolve 函数共用，消除重复判定）+ statSync().isFile() 对齐 SDK。candidate dir 仍用 existsSync（目录判定，与 SDK isDirectory 对齐 — reviewer-claude 确认正确）。

#### INFO（批 B，核实结论非问题）
- oneshot pool「不补 rg PATH」假设成立（双方确认）：summarizer-runner / handoff-runner 只跑纯文本总结（sandboxMode read-only + prompt 明确不调工具），不触发 codex 文件搜索 → 无需 rg
- ensureCodex line 273 `if(overridePath && !userCodexPath)` 注入条件正确（仅 bundled 二进制补 helper，用户自填 codexCliPath 不污染）；per-session codexBySession Map lifecycle 正确

## 测试

- 新建 issue-detail-editing.test.ts：23 case（HIGH-A expectedIssueId 守护 / HIGH-B / Round2-HIGH / Round3-MED 端到端 / labels 归一化 / rebase 叉乘）
- codex-binary-layout.test.ts：10 → 15 case（+win32 binName new/legacy + win32 PATH key 双 case + new 布局双条件「有 bin 无 codex-package.json → legacy」）；win32 case 用 Object.defineProperty stub process.platform/arch
- **测试有效性验证**：临时还原 binName 修复 → win32 case 准确 fail（证明非假绿）→ 还原修复全绿
- 全量 1138 passed / 197 skipped（SQLite ABI 门控）+ typecheck + build 通过

## 异构对抗价值（本轮教科书案例）

1. **补 REVIEW_69 缺口**：那轮 reviewer-claude 环境性缺席 → codex-binary 单方审 + 仅 darwin-arm64 → win32 两个真 bug（binName + PATH key）漏掉。本轮异构 + 多平台思维抓出。
2. **HIGH-B 4 轮迭代收敛**：dirty「触碰历史」→ baseline「锚点保留旧值」→ baseline「提交判定比最新 issue」。每轮 reviewer-codex 抓出上一版修复的二阶缺陷（Round2-HIGH / Round3-MED），lead node 复现 + 重新设计。reviewer-claude 认领漏审并升级 mental model：审 dirty/diff 状态机必须把「触碰历史 vs 当前实际差异」当独立维度 + 构造「本地草稿 × 并发外部改动」叉乘格子。
3. **双方独立提出同一 win32 PATH key**（claude HIGH / codex MED）= 异构强冗余即验证，无需反驳轮。
4. **激活链洞察**（reviewer-claude）：lead 的 MED 修复激活了 dormant HIGH，两者必须一起修 —— 单方修复会「修了 binName 仍被 PATH 键挡」净结果失败。

## 收口判定

批 A + 批 B 均双 reviewer 明确 conclude。所有 HIGH/MED 根治且有回归 test 兜底，baseline 模型核心不变量经多 event 叉乘验证恒成立，win32 修复逐行对齐 SDK 0.135。剩余仅 INFO follow-up（批 A 3 个 / 批 B 0 个）。可合。

## 已知未做（follow-up）

- 同毫秒 updatedAt 短路（只读滞后一拍，低概率，INFO）
- 删→恢复草稿复活（语义歧义，留产品决策，INFO）
- IssueDetail 完整组件渲染测试（需引入 jsdom；本轮已用纯逻辑抽离 + 23 case 覆盖核心状态机，组件壳层渲染未覆盖）
