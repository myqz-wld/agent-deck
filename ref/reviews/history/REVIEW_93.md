# REVIEW_93 — 全项目 deep review 批 H1：renderer issue 组件（Batch H 开篇）

- 日期: 2026-06-01
- 类型: 功能 BUG（error state 二义性摧毁表单 + 草稿丢失 / async IPC reject 升级全屏 fatal / stale fetch 退回 event 版本）+ 代码优化（useMemo / 惰性初始化 / 选择器签名收窄）+ a11y（label 关联 / aria-label / type=button）+ 文案校验（renderer 端必填守门）（全项目 deep review 第二十三批，Batch H 子批 H1，renderer + 文案密集子系统开篇）
- 触发: 用户「deep review 下项目，聚焦功能 BUG / 代码优化 / 文字措辞优化，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_92（G5 settings-store，Batch G 收官）/ REVIEW_70（issue-tracker 主体 baseline，本批 renderer 侧补审）/ plan issue-tracker-mcp-20260529（issue 组件来源，HIGH-A/HIGH-B/Round2-HIGH/Round3-MED 历史 finding 已修，本批独立复验）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，**fresh pair dr-project-h-20260531**，旧 G4 pair 已 closed → 重 spawn）+ 反驳轮（HIGH 单方独有）+ 三态裁决 + lead 现场 Read/Grep + IPC schema 交叉验证 + main.tsx unhandledrejection 链追踪 + 全 fix temp-revert 非空验证。
- 收口: R1→R3 三轮。**R1 异构 divergence 互补盲点**：reviewer-claude 押 error-state 二义性 HIGH（save/delete 失败摧毁整表单）/ reviewer-codex 押 stale-fetch race + 初始 IPC catch 缺口 MED。**HIGH 经反驳轮 codex ✅ 同意 + trim 佐证**。R2 codex 补 2 MED（mergeList drop / same-ms updatedAt）+ 1 LOW（adapter 未就绪可提交），claude 0 HIGH/0 MED 同意 conclude + 3 INFO。R3 codex 1 MED（same-ms 兄弟路径未闭合）经 lead 三态裁决 + 反向问询 → **真问题但定为 Follow-up #15**（根因 ms 时间戳非单调 = repo schema scope；renderer band-aid 触最高风险 editing 逻辑不成比例），**双方 R3 共识 conclude**。

## 范围（批 H1）

Batch H（renderer core + issue 组件）开篇子批。issue 组件文案密集 + 含近期改动 = 本批重点（plan 设计决策 3）：

| 文件 | LOC | 处置 |
|---|---|---|
| IssueDetail.tsx | 456→约 510 | **主审**：detail 编辑视图 + editing/baseline 双锚点 state 编排 + 3 async handler |
| IssuesPanel.tsx | 322 | **主审**：list + filter 栏 + debounce 搜索 + onIssueChanged 订阅 |
| ResolveInNewSessionDialog.tsx | 279 | **主审**：起新会话 dialog + adapter capability 字段 + 默认 prompt 拼装 |
| issue-detail-editing.ts | 164→约 185 | **主审**：editing buffer 纯逻辑（toEditing/buildUpdatePatch/rebaseEditingState/fieldEquals）|
| issues-store.ts | 122→约 150 | **主审**：zustand issues store（Map + filter + reducer + selectFilteredIssues）|

focus 维度（plan §下一会话第一步 H 偏移）：React state race / useEffect 依赖 / stale closure / 文案措辞 / XSS / key collision / 受控组件 / a11y。

## 收敛与裁决

### ✅ 单方提出 + 反驳轮 codex 同意（must-fix HIGH）

**HIGH error state 二义性：保存/删除失败摧毁整个表单 + 草稿丢失 + 内联错误块死代码（IssueDetail.tsx:122/199 原始）** — reviewer-claude HIGH（反驳轮 reviewer-codex ✅ 同意 + 补 trim 佐证）

`if (error) return (<极简视图>)` 在**任何** error 真值时 early-return 替换整个组件，但 `setError` 有 4 来源：fetch 失败「未找到」(致命，整替合理) + handleSave/SoftDelete/Undelete catch（操作失败，**本不该摧毁表单**）。
- 死代码反证: 因 L122 在 error 真值 return，到达主视图（L188）时 error 必 falsy → L199 `{error && ...}` 内联错误块**永不可达** → 反证它本意是承担「非破坏性保存错误条」被 L122 抢先吞掉。
- 极易触发: UPDATE_PATCH_SCHEMA（ipc/issues.ts:64-72）`title/description/kind: z.string().min(1)` + repo 层 `trim()` 守门（issue-repo.ts:331-335）；renderer 端 title/kind/description 无必填校验。用户清空标题点保存 → `patch.title=''` → IPC zod reject → handleSave catch → setError → 整表单消失。
- 草稿不可恢复: error 置位后 action bar（含「保存」）随表单消失，唯一出口「关闭」→ onClose → unmount → editing 草稿彻底丢失；error 永不自清（仅 mount-only effect + 已不可达的 handleSave 开头）。
- 验证: lead Read ipc/issues.ts:64-72 确认 min(1) + issue-repo.ts:331-335 确认 trim；控制流追踪确认 L199 死代码。反驳轮 codex 独立确认三点全成立 + 补充 repo trim 也走同 catch 路径。
- 修法: error 拆 `loadError`（致命加载失败，`if (loadError)` early-return 整替）+ `opError`（save/delete 失败主视图内联条，loadError falsy 时可达死代码消除）；handleSave/SoftDelete/Undelete catch 全改 setOpError → 表单+草稿保留；handleSave 加 `validateEditing` 前置校验（空 title/desc/kind、labels>16、单项>64 → setOpError + return，不发 IPC 不丢草稿）。

### ✅ 双方独立提出（must-fix MED）

**MED 初始 async IPC fetch 缺 `.catch`，reject 升级全屏 fatal / 静默卡死（IssueDetail.tsx:88 / IssuesPanel.tsx:66 / ResolveInNewSessionDialog.tsx:93）** — reviewer-claude MED + reviewer-codex MED-2（双方独立）

三处 `void window.api.xxx().then(...)` 无 `.catch`。
- 危害（lead 验证 main.tsx:70-86）: reject → promise 未处理 → main.tsx `unhandledrejection` → showFatal 红色全屏遮挡 8s；之后 IssueDetail 永久卡「加载中...」（error/issue 仍 null），IssuesPanel `.finally` 不消费 reject。违反仓库约定（TeamHub.tsx:40 用 `.catch`）。
- 修法: 三处补 `.catch`。IssueDetail → setLoadError（内联展示 + R2 加重试按钮）；IssuesPanel → setListError（列表区内联）；ResolveDialog → setError（提示 adapter 加载失败）。

### ✅ 单方提出 + lead 现场验证（must-fix MED）

**MED 初始 detail/list fetch 无 updatedAt guard，慢 fetch 退回 onIssueChanged event 版本（IssueDetail.tsx:88 / IssuesPanel.tsx:66）** — reviewer-codex MED-1（lead Read 验证）

detail mount fetch 无 `updatedAt` guard（对比 store-sync effect L110-120 有 `===` guard）；IssuesPanel `setIssues(list)` 整表替换。
- timeline: t0 慢 fetch 取旧 snapshot；t1 onIssueChanged upsert 新 updatedAt；t2 旧 fetch resolve → setIssue(旧) / setIssues(旧整替) 退回旧值。
- 验证: lead Read IssueDetail.tsx:85-100 确认无 guard；issues-store.ts setIssues 全替。
- 修法: detail fetch 加 `fetched.updatedAt < cur.updatedAt → return`（丢弃旧响应）；list 新增 `mergeIssuesFromList`（逐 id 保 updatedAt 更大版本 + 保住 store 已有 appendices）替 setIssues。

### ✅ R2 codex 补充（must-fix）

**MED mergeIssuesFromList membership 剔除 fetch-在途期间 event 新建行（issues-store.ts:76）** — reviewer-codex R2 MED-1（claude R2 INFO-3 同识，severity 争议）

R1 的 mergeIssuesFromList 只遍历 list snapshot 构造新 Map → fetch 在途期间 event 新建/移入 filter 的 issue（不在旧 snapshot）被剔除 → 列表瞬时丢行。
- 裁决: 两方都发现（codex MED / claude INFO-3），lead 判 **keep-all 修法 strictly safer 且更简单**。理由: ① 可见列表由 selectFilteredIssues 渲染时按 filters 重过滤（store Map 是超集 cache 非 filter 镜像，out-of-scope 行不显示）；② hardDelete 走 removeIssue 显式删；③ refetch 走 setIssues 全替兜底防滞留累积 + store 重启清空。
- 修法: mergeIssuesFromList 从 `new Map(s.issues)` 出发，只覆盖 list 内 id（仍保 updatedAt 更大本地版本），**不剔除** snapshot 未含 id → 消除 drop 窗口。

**MED same-ms updatedAt（mount fetch 路径）（IssueDetail.tsx:105）** — reviewer-codex R2 MED-2（lead 验证 + R3 完整裁决见下）

`Date.now()` ms 非单调，同毫秒 create/update/append 可同 updatedAt。R2 修 mount fetch 路径：equal-updatedAt 时只补 appendices（mount fetch 唯一实益，读时 attach 不 bump updated_at）不覆盖 content 字段。

**LOW adapter 列表加载失败/为空后仍可用默认 claude-code 提交（ResolveInNewSessionDialog.tsx:103）** — reviewer-codex R2 LOW（lead 验证）

catch 显示错误但 submit 仅 busy disabled → 用默认 adapter='claude-code' 调 IPC（select 无 option / 能力字段错显）→ IPC 二次失败。
- 修法: 加 `adaptersReady` state（usable.length>0 才 true）；handleSubmit 入口 `!adaptersReady` 拒提交；button `disabled={busy || !adaptersReady}`。

### ✅ R2 claude 补充 + lead 采纳

**INFO→fix loadError 无 in-place 重试（IssueDetail.tsx:90-119）** — reviewer-claude R2 INFO-1（lead Q1 同识）

瞬时 issuesGet reject 后 loadError 永驻至 remount，仅「关闭」出口。修法: loadError 视图加「重试」按钮（`fetchNonce` state 递增触发 mount effect 重跑）。

### ✅ 双方 / 单方 LOW + INFO（已 fix）

- **LOW a11y label 未关联控件（IssueDetail.Field / ResolveDialog 6 处）** — codex LOW + claude INFO（双方）→ Field/DialogField helper 用 `useId` + `cloneElement` 注入 id 让 label htmlFor 关联；✕ close button 补 `aria-label="关闭"`。
- **LOW renderer 端缺必填校验（放大 HIGH）** — claude → validateEditing 纯函数（与 IPC zod + repo trim 1:1 对齐）。
- **INFO expectedIssueId guard 注释夸大为「第二道防线」** — codex → 注释改正为「兜底防 stale issue object」，明说不覆盖「editing 来自旧 issue、issue 已是新 issue」形态，主防线是 key remount。
- **INFO button 缺 type="button" / useMemo 选择器 / useMemo→惰性初始化** — claude → 全 button 补 type="button"（grep 0 漏）；selectFilteredIssues 签名收窄 `Pick<...,'issues'|'filters'>` + filteredList useMemo；ResolveDialog prompt useMemo→`useState(()=>buildDefaultPrompt(issue))` 惰性初始化。

### ❌ 不改 / 文档化（by-design）

- **INFO savingRef 抑制窗口内外部更新短暂丢失（IssueDetail.tsx:129-139）** — claude R2 INFO-2：save/delete IPC 往返期间到达的外部 event 因 savingRef 早返跳过，saving 翻 false 后 storeUpdatedAt 无新变化 effect 不重跑 → 漏一次外部更新直到下个 event 自愈。**pre-existing（非本轮引入）+ 窗口窄 + 并发编辑罕见 + 自愈** → 不修，document。

### ⚠️ Follow-up（真问题，scope 外）

**#15 [MED 已验证] same-ms updatedAt tie 的两条兄弟路径未闭合** — reviewer-codex R3 MED（lead 三态裁决 + 反向问询 → 双方 R3 共识转 Follow-up）

R2 的 equal-updatedAt 防御只覆盖 **mount fetch** 路径。codex R3 指出还有两条同根兄弟路径：
- (a) store-sync effect（IssueDetail.tsx:146 `===updatedAt` early-return）：同毫秒不同内容 event 不 rebase 到 detail（dep `[storeUpdatedAt]` 同值不 fire + 内部 `===` early-return）。
- (b) mergeIssuesFromList（issues-store.ts:81 `>` 保本地）：equal 时旧 list 快照覆盖 store 已到达的 event 版本。

lead 裁决（双方 R3 共识）: **真问题但定为 Follow-up 而非 H1 阻塞 fix**。
- 可达性: 三路径都需「两并发写者同毫秒写同一 issue」+（detail 开着 / list in-flight）。issue tracker 同一 issue 并发编辑罕见（claude R2 INFO-2 佐证）。worst-case = 一次 render 显示 stale content，**非数据丢失**（DB 正确），下个 event/refetch 自愈 → MED-leaning-LOW 瞬时 staleness。
- 根治在 repo 层: codex 自承「根治仍是 repo 层单调 revision」。issue-repo REVIEW_70 当天刚审 + 改 updatedAt 写单调 revision 触及 shared schema = 本 plan 授权边界外（不自主改协议/schema breaking change）。
- renderer seq band-aid 不成比例: store 加 seq + detail effect 改 deps 要动 HIGH-A/B/Round2/3 所在最高风险 editing 逻辑（rebase/draft 保留），为近乎不可达 + 自愈瞬时 staleness 改最易回归代码，风险 > 收益。
- 处置: IssueDetail.tsx mount fetch 注释**显式 acknowledge 这两条兄弟路径**（不静默 drop）+ 指向本 Follow-up；留用户决策是否在 repo 层加单调 revision 根治。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | IssueDetail.tsx | HIGH | error 拆 loadError/opError + 死代码消除 + handler catch 改 setOpError | 控制流 + 反驳轮 + IPC schema 交叉 |
| 2 | IssueDetail/IssuesPanel/ResolveDialog | MED | 3 处初始 fetch 补 .catch | 双方独立 + main.tsx 链追踪 |
| 3 | IssueDetail.tsx:105 + issues-store mergeIssuesFromList | MED | detail updatedAt guard + list merge 保新版本 | codex + lead Read |
| 4 | issues-store.ts mergeIssuesFromList | MED | keep-all 不剔除 snapshot 外 id | codex R2 + claude R2 + lead |
| 5 | IssueDetail.tsx equal-updatedAt 分支 | MED（部分） | mount fetch tie 只补 appendices 不覆 content | codex R2 + lead（兄弟路径转 Follow-up #15）|
| 6 | ResolveInNewSessionDialog.tsx | LOW | adaptersReady 守门拒提交 | codex R2 + lead |
| 7 | IssueDetail.tsx | LOW | loadError 视图加重试按钮 | claude R2 + lead Q1 |
| 8 | issue-detail-editing.ts validateEditing | LOW | renderer 端必填校验（IPC zod + repo trim 对齐）| claude + lead |
| 9 | IssueDetail.Field / ResolveDialog.DialogField | LOW | useId+cloneElement label 关联 + ✕ aria-label | 双方 + lead 13 调用点单控件实测 |
| 10 | issue-detail-editing.ts:117 注释 | INFO | expectedIssueId guard 注释改正 | codex |
| 11 | IssueDetail/ResolveDialog button | INFO | type="button" 全覆盖 + useMemo/惰性初始化 + 选择器签名收窄 | claude |

## 测试

- **issue-detail-editing.test.ts +7**：validateEditing 7 case（合法/空 title trim/空 desc/空 kind/labels>16/单项>64/边界 16 项 & 64 字符）。
- **issues-store.test.ts 新建 +6**：mergeIssuesFromList stale 保护 / list 胜出 / keep-all 保留 snapshot 外 id / appendices 保住 + selectFilteredIssues createdAt DESC / showDeleted 过滤。
- **temp-revert 验证**：validateEditing always-pass + mergeList drop-based → 7 FAIL（R1）；keep-all→drop + appendices 丢 → 2 FAIL（R2）。全非空。
- typecheck 双配置（tsconfig.node + tsconfig.web）绿；全项目 vitest **1249 passed / 210 skipped**（skipped = SQLite 真测需 Electron binding，本批 renderer 不碰 store binding 无需 rebuild）。

## 异构对抗复盘

- **R1 互补盲点**：claude 押 error-state 二义性 HIGH（UI 状态机视角）/ codex 押 stale-fetch race + IPC catch 缺口（时序 + 错误传播视角）。零重叠 → 异构强冗余。
- **反驳轮**：claude HIGH 单方独有 → 发 codex 独立反驳 → codex ✅ 同意 + 补 repo trim 佐证（同 catch 路径）。
- **R2 severity 争议收敛**：mergeList drop 两方都发现（codex MED / claude INFO-3）→ lead 判 keep-all strictly safer 一并解决。
- **R3 互补盲点 + 共识**：claude R3 验 mount fetch fix 但漏 same-ms 两条兄弟路径；codex R3 抓兄弟路径 → lead 三态裁决（真问题，根因 repo schema scope，renderer band-aid 不成比例）→ 反向问询 codex「认同 Follow-up vs 坚持强行 tie-break」→ codex 明确同意 conclude 转 Follow-up #15。双方 R3 共识可合。

## Batch H1 小结

renderer issue 组件子系统：**1 HIGH + 4 MED + 4 LOW + 2 INFO = 11 fix** + 13 回归 test + 1 反驳轮 + 1 Follow-up（#15 same-ms 根治）。共性主题：**异步边界处理不彻底**（error state 二义性 / IPC reject 无 catch / fetch×event 时序竞态 / adapter 未就绪可提交）+ a11y/文案补强。reviewer pair **dr-project-h-20260531**（claude 23fbf1ec / codex 019e7f4c）R1→R3 三轮共识 conclude。
