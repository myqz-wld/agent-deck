# REVIEW_98 — simple-review log+asset：日志查看器 path-based TOCTOU + Monaco ErrorBoundary 加固

## 范围

对 commit `ee0fbd8`（组 B 日志查看，[CHANGELOG_191](../../changelogs/history/CHANGELOG_191.md)）+ `e1ba3e5`（组 A 提示词资产重构，[CHANGELOG_192](../../changelogs/history/CHANGELOG_192.md)）跑 `agent-deck:simple-review` 单次异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5）+ 三态裁决 + 一轮确认。

**结论**：0 HIGH；组 B 2 MED + 2 INFO/LOW 全 fix；组 A 双方一致可合（纯文档重构，0 dangling，两端 SSOT 对称）。双方 reviewer 确认轮均「可合」。

## Finding 与裁决

### [MED ✅] logs.ts — path-based TOCTOU（symlink 防护 + 2MB cap 双旁路）

- **来源**：reviewer-codex 判 MED（带 /tmp repro）/ reviewer-claude 判 INFO（同 LogsTruncateToday pattern，威胁弱）。**lead 裁决**：威胁模型上单用户本地 app 确实弱（要 swap 文件已需用户级写权限），但 codex 的核心 insight 成立——旧实现的 symlink 防护 + cap **是 path-based，等于没防**。既然留防护就让它真生效。
- **问题**：`refuseSymlink(filePath)`(lstat) → `statSync(filePath)` → `readFileSync|openSync(filePath)` 全按 path 分多次 syscall。lstat 判非 symlink 后、真正 read 前文件可被换成 symlink → 后续 follow 到任意同权限文件；小文件分支按旧 size 进 `≤CAP` 但 `readFileSync` 读当前内容 → 击穿 2MB cap。
- **lead 独立验证**：读 `logs.ts:71-98` 源码确认机制；`O_NOFOLLOW` 在 macOS Node 实测可用（256）+ 拒 symlink（ELOOP）；/tmp Node repro 4 case 全过（见下「验证铁证」）。
- **修复**（`logs.ts:71-117`）：收敛成「开一次 fd，基于同一 fd 决策 + 读取」——`openSync(filePath, O_RDONLY | O_NOFOLLOW)`（末段 symlink 直接抛 ELOOP，消除 lstat→open 窗口）→ `fstatSync(fd).size`（同 fd，消除 stat→read 窗口）→ 去掉 `readFileSync(path)` 小文件分支，一律 `min(size, CAP)` 从 fd 读 → `finally closeSync`。删原 `refuseSymlink()` helper（已无调用点的 dead code）。

### [MED ✅] LogViewerModal.tsx — Monaco lazy import 无 local ErrorBoundary → 整 app 持久崩

- **来源**：reviewer-claude 单方提出（codex 未覆盖 renderer 架构维度）。**lead 裁决**：✅ 真问题（用户可见崩溃面），采纳 fix 而非仅登记 tradeoff。
- **问题**：`<Suspense>` 只接 pending promise，**不接 rejection**（React 语义）。`import('@monaco-editor/react')` 失败（chunk 404 / hash 对不上 / 网络）时 lazy 组件 render 期 re-throw → 冒泡到 main.tsx 唯一的 `RootErrorBoundary` → 整 app 渲染持久「Renderer crashed」全屏（无 auto-dismiss）。一个日志查看小功能的 chunk 失败打死整 app。
- **lead 独立验证**：读 `main.tsx:176` 确认全 app 仅 1 个 RootErrorBoundary 包 `<App/>`；`RootErrorBoundary.render` L25-47 确认 state.error set 后持久全屏（8s auto-dismiss 只在 showFatal banner / window.onerror 路径）；`TextDiffRenderer.tsx:5` 确认 sibling 同款无 boundary（claude mitigation 属实）。
- **修复**（`LogViewerModal.tsx`）：新增轻量 `class MonacoErrorBoundary`（`getDerivedStateFromError → failed:true`，fallback 显 localized「日志视图加载失败，请改用『打开日志目录』」），包在 `<Suspense><Editor/></Suspense>` 外层（ErrorBoundary-outside-Suspense 推荐摆法，reviewer-claude 确认摆对）。

### [LOW ✅] MonacoErrorBoundary 无 componentDidCatch → chunk 失败静默吞掉

- **来源**：reviewer-claude 确认轮提出（**本 fix 的直接副作用**，正交于修对性）。**lead 裁决**：✅ 采纳（成本一行，且本功能初衷就是「可观测性」，讽刺的是日志查看器自己的失败反而查不到）。
- **问题**：改前 import reject 冒泡到 `RootErrorBoundary.componentDidCatch → logger.error` 落日志；改后 local boundary 抢先接住但只有 `getDerivedStateFromError` 无 `componentDidCatch` → render 错误静默消失，logger 无记录。
- **修复**：boundary 补 `componentDidCatch(error){ logger.error('monaco editor lazy load failed', error); }` + `import log from '@renderer/utils/logger'`（复用既有 renderer logger 范式）。

### [INFO ✅] logs.ts — 2MB tail cap 在 UTF-8 多字节边界产生 U+FFFD

- **来源**：双方都提（codex INFO / claude LOW）。**lead 裁决**：✅ 顺手修（fd 重构同处）。
- **问题**：tail 从 `size - CAP` 字节偏移读起，偏移落在多字节 UTF-8 序列（日志含大量 CJK 3 字节）中间 → `toString('utf-8')` 开头产生 `�`。仅影响截断视图最开头 1-2 字符。
- **修复**（`logs.ts:34-43`）：新增 `trimLeadingPartialUtf8(buf)` 跳过开头 continuation byte（`0b10xxxxxx`，最多 3 个）定位下一完整 code point，仅在 `truncated` 分支调。

### [INFO 留 follow-up] LogViewerModal a11y

reviewer-claude 提：容器无 `role="dialog"`/`aria-modal`、无 focus-trap、无 Escape 关闭、backdrop 点击不关闭。与 sibling `ContentViewerModal.tsx` 一致，属既有 modal 范式。本次不改，留 follow-up。

### 组 A — 提示词资产重构（双方一致可合）

reviewer-codex + reviewer-claude 均确认：`rg` 无活 dangling（`reviewer-*.sh.tmpl` / `codex-cli-stuck-lessons` / 已删 convention 在 resources/+src/ 0 命中；src/ 仅剩 `plan §决策对抗 Round N` 历史锚点，正确保留）；simple-review SKILL 6 步执行模板可执行 + 三态裁决/Finding 契约 inline 自洽 + 失败兜底完整；两端 SSOT 对称（仅 adapter 视角措辞差异）；章节归位无内容丢失。reviewer-claude 提 1 INFO：user 级 `~/.claude/CLAUDE.md` 不在 repo 无法验证——lead 已 `cat` 自查确认清到 12 行（仅输出+运行时）。

## 验证铁证

`/tmp` Node repro（fd-based 逻辑复刻 + helper 单测，均实跑）：
- **symlink swap** → `openSync(O_NOFOLLOW)` 返 `ELOOP` 拒（旧版会 follow 到 SECRET-TARGET）
- **小文件 cap 旁路** → open fd 后 swap 成 `CAP+123` bytes，`fstatSize=5`/`read=5`/`capBypassed=false`（read 锁定已开 fd）
- **大文件** → `truncated:true` 且 `bytes==2097152`（精确 CAP）
- **缺失** → `existed:false`
- **UTF-8 trim** → 腰斩 `你`：未 trim `��好world`（首字符 U+FFFD）；trim 后 `好world` 无 replacement char；ASCII / 完整多字节开头不动
- reviewer-codex 确认轮自跑 repro 复核同结论

`pnpm typecheck` 双配置绿 / `pnpm build` 通过（main + renderer）。

## 备注

异构对抗见效：reviewer-codex 抓 main 进程 fs syscall 维度（path-based TOCTOU），reviewer-claude 抓 renderer 架构维度（Monaco ErrorBoundary）+ 自纠出 fix 副作用（componentDidCatch 可观测性回归），互补无重叠。两处 MED 都是单方独有 + lead 现场验证成立 → 过三态裁决 ✅。
