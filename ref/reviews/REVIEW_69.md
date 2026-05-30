# REVIEW_69 — codex-sdk 0.135 升级回归 + Issue UI 草稿同步深度 review

- 日期: 2026-05-30
- 类型: Debug / 升级回归 + UI 状态同步缺陷
- 触发: 多区 deep review（用户「deep review 下项目，一路推进」），Area 4 代码 bug review + Area 5 SDK 升级回归
- 关联: CHANGELOG_188（codex-sdk 升级 + Issue UI 修复）+ commit b5fcf9a / cf049ae
- 方法: 异构对抗（reviewer-codex 实证 + 主 agent 现场验证）。**reviewer-claude 本轮环境性不可用**（外部 `claude -p` 带工具的 review 调用在 background-Bash sandbox 内系统性 hang，trivial PONG 探针可通过 → CLI 本身可用但 review 规模调用挂；codex reviewer 正常）。按 §决策对抗 reviewer 失败兜底：不降级同源双 Claude，靠 codex reviewer + 主 agent 现场验证下三态裁决。

## 范围

- src/main/adapters/codex-cli/sdk-bridge/codex-binary.ts（SDK 升级回归）
- src/renderer/components/IssueDetail.tsx（Issue 状态刷新 + 草稿同步）
- src/renderer/components/ResolveInNewSessionDialog.tsx（沙盒选项）
- src/main/store/issue-repo.ts / issue-lifecycle-scheduler.ts（issue 子系统广度扫）
- src/main/codex-config/skills-installer.ts（注释漂移）

## 三态裁决

### ✅ HIGH-1 codex 二进制 vendor 布局回归（双重验证：主 agent find 实证 + reviewer-codex 独立复现）

`codex-sdk` 0.131→0.135 把 vendored 二进制从 `vendor/<triple>/codex/codex` 挪到 `vendor/<triple>/bin/codex`（同时 `path/`→`codex-path/` + 新增 `codex-package.json`）。`resolveBundledCodexBinary()` 原硬编码旧 `codex/codex` → 打包 .app 找不到二进制，codex 整条链失效。typecheck 抓不到（纯 path 字符串）。

验证手段：
- 主 agent `find node_modules/.pnpm/@openai+codex@{0.131,0.135}.0-darwin-arm64 -name codex -type f` 对比两版路径实证。
- reviewer-codex 独立读 `node_modules/@openai/codex-sdk/dist/index.js:451` resolveNativePackage + `find -L` 确认 0.135 包结构 → 同一结论。
- 双方独立提出 = ✅。

修复：`codex-binary.ts:72` 先探 `bin/<binName>` 后 fallback `codex/<binName>`，与 SDK 内部 resolveNativePackage 同序。回归测试 `__tests__/codex-binary-layout.test.ts` 5 case。

### ✅ MED-1 save 后未归一化 editing → 永久误判有草稿（reviewer-codex 提出 + 主 agent 现场验证）

`IssueDetail.handleSave` 原只 `setIssue(updated)` 不 `setEditing`。labels `"a,b"`（无空格）存成 `["a","b"]` 后 canonical `toEditing(updated).labels="a, b"`（有空格）≠ `editing.labels="a,b"` → 新增的 store-sync effect `hasDraft = !editingMatches(...)` 永久 true → 后续外部更新（起新会话改 status / teammate append）再也同步不进 editing buffer。

验证手段：reviewer-codex grep handleSave 成功路径无 setEditing + 主 agent 字符串 trace（join(', ') 必引入空格差异）。这是 Bug#2 修复（store-sync effect）引入的二阶缺陷。
修复：`handleSave` 成功后 `setEditing(toEditing(updated))` 归一化。

### ✅ MED-2 初始 issuesGet 慢 fetch 吞快速输入（reviewer-codex 提出 + 主 agent 验证）

Bug#2 把 `editing` 初值从 `null` 改成 store 快照同步 seed → 用户可在 `issuesGet()` resolve 前编辑。原 fetch callback 无条件 `setEditing(toEditing(fetched))` 覆盖 → 慢 fetch 吞掉已输入草稿。StrictMode 双调放大窗口。

验证手段：reviewer-codex 读 git diff 确认 editing 初值改动 + callback 无草稿守护；主 agent 确认 seed 时序。
修复：用 `issueRef`/`editingRef` 读 fetch resolve 那刻最新值判 hasDraft，有草稿则只更 issue 不动 editing。两个 effect 统一改 ref 镜像读最新 issue/editing/saving。

### ✅ MED-3 codex 打包版 pathDirs 丢失（reviewer-codex 提出 → 核为 pre-existing，转 issue 跟踪）

`new Codex({ codexPathOverride })` 时 SDK 把 `pathDirs=[]`（CodexExec 构造），bundled ripgrep（`codex-path/rg`）不进子进程 PATH。

验证手段：reviewer-codex 读 dist/index.js:451 + find -L。主 agent 核对 0.131 时代 legacy `path/rg` 同样未注入 → **pre-existing**，本次升级未引入未加重。
处置：未实测「PATH 缺 rg 时 codex 是否真退化」，标 MED 不 HIGH；超本次升级 scope → `report_issue`（id 8c116860）单独跟踪，不纳入本提交。

### ✅ LOW-1 skills-installer 注释漂移（主 agent 单方 + 现场验证）

`src/main/codex-config/skills-installer.ts:116` 注释「mtime 对比避免每次都写」与循环内 124-128 行「No mtime skip optimization ... Always overwrite」明确矛盾（CHANGELOG_169 改为总覆盖后遗留的 stale 注释）。
验证手段：主 agent 读两处注释直接对照。修复：116 行注释改为「每次覆盖写，不做 mtime skip — 理由见循环内注释」。

### ❓ INFO issue update resolved_at 再解决保留旧值（主 agent 单方，未实践验证影响）

`issue-repo.ts:347` update 状态机：`resolved→non→resolved` 保留原 `resolved_at`（注释明示设计）。GC（`listForGc` line 412）按 `status='resolved' AND resolved_at < threshold` 删 → 再解决的 issue 用旧 resolved_at 可能被提前 GC。需 resolve→reopen→resolve 循环 + 旧 resolve 已过保留期才触发，极边角。
处置：标 INFO *未验证*（未实测触发概率），不在本轮改（可能是有意设计 — 「首次 resolve 起算保留期」也是一种合理语义）。留待产品决策，不擅改状态机。

## 验证

- `pnpm typecheck` 通过 / `pnpm build` 通过（dynamic-import warning 为 pre-existing 无关）。
- `pnpm test` 1094 passed / 197 skipped（skip 为 SQLite binding ABI 门控，pre-existing）。
- 新增 codex-binary-layout 5 case + issues IPC 32 case 全绿。

## 收口判定

reviewer-claude 环境性缺席（非漏审，CLI 系统性 hang）→ 单 reviewer（codex）+ 主 agent 现场验证下，0 未决 HIGH/MED（MED-3 转 issue / INFO 留产品决策）。本轮可合。LOW/INFO 已处理或转跟踪。
