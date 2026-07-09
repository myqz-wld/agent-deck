# REVIEW_67 — Issues 面板 UI token 失效 + GVM cd override 报错污染

- 日期: 2026-05-30
- 类型: Debug / UI 样式修复 + 用户环境 shell 配置修复
- 触发: 用户报告「问题页面搜索框没有线、状态/类型按钮没有选中态、设置面板日志按钮很怪」+「GVM 初始化报错，顺手修复」

## 方法

根因均为**单方现场实证**（确定性强，未走双对抗）：
- UI：grep `globals.css` `@theme` 实际注册的 color token 清单，比对三个 issue 组件用到的 token。
- GVM：在 Claude Code Bash 工具环境直接复现 `cd` 报错（`type cd` + `GVM_ROOT` + 实跑 cd）。

## 三态裁决 / 根因

### ✅ 1. Issues 三组件使用未注册 Tailwind token（HIGH）

`src/renderer/styles/globals.css` 的 `@theme` 仅注册：
- `deck-bg` / `deck-bg-strong` / `deck-border` / `deck-text` / `deck-muted`
- `status-idle` / `status-working` / `status-waiting` / `status-finished` / `status-dormant` / `status-closed`

但 `IssuesPanel.tsx` / `IssueDetail.tsx` / `ResolveInNewSessionDialog.tsx` 用了 **7 个未注册 token**：`deck-accent` / `deck-bg-elevated` / `deck-text-muted` / `status-active` / `status-danger` / `status-warning` / `status-muted`。

**机制**：Tailwind v4 对未在 `@theme` 注册的 color token **不生成任何 CSS**（静默丢弃，非任意值语法 `[...]` 不报错）。所以这些 class 全部失效：
- 搜索框 `bg-deck-bg-elevated` + `focus:ring-deck-accent` 全失效 → 无背景无边框 = 用户看到的「没有线」
- `FilterChip` active(`bg-deck-accent/30`) 与 inactive(`bg-deck-bg-elevated`) 背景都失效 → 选中/未选中都是裸文字 = 用户看到的「没有选中态」
- 状态/严重度颜色（`status-active/danger/warning/muted`）失效 → 退化成继承色

证据：`grep -rE 'deck-accent|deck-bg-elevated|deck-text-muted|status-active|status-danger|status-warning|status-muted' src/renderer` 命中且仅命中这 3 个文件（issue-tracker-mcp plan 新增组件，作者沿用了别处不存在的命名）。

**修复映射**（语义对齐 `@theme` 实际色值）：

| 失效 token | 替换为 | 依据 |
|---|---|---|
| `text-deck-text-muted` | `text-deck-muted` | 项目唯一 muted 文字色 |
| `bg-deck-bg-elevated`（输入控件） | `border border-deck-border bg-white/[0.04]` | 对齐 `controls.tsx` 输入控件惯例（补回 border = 修「没有线」） |
| `bg-deck-bg-elevated`（badge/块） | `bg-white/[0.06]` / `bg-white/[0.03]` | 半透明白分层 |
| `focus:ring-1 focus:ring-deck-accent` | `focus:border-white/20` | 项目无 accent 色，对齐 select focus 惯例 |
| `bg-deck-accent/30`（选中/主按钮） | `bg-white/15`（chip 加 `ring-1 ring-white/20` 强化选中） | SettingsDialog tab 选中惯例 |
| `status-active`(绿，进行中) | `status-working` rgb(80,200,120) | App.tsx working=进行中 |
| `status-danger`(红,危险/删除) | `status-waiting` rgb(255,80,80) | 全项目 waiting=红=错误/危险 |
| `status-warning`(黄,open/恢复) | `status-finished` rgb(240,200,60) | finished=黄 |
| `status-muted`(灰,resolved/low) | `status-idle` rgb(140,140,150) | idle=灰 |

severity 三档原本 high/medium 都落在红色系（无区分度），借机改成 high=红 / medium=黄 / low=灰，三档有区分。

### ✅ 2. 日志按钮风格不一致（LOW）

`LogsSection.tsx` 三个按钮用 `border border-deck-border bg-white/[0.04]`，而项目其他设置按钮（`controls.tsx` 的 SoundPicker / ExecutablePicker / NotificationTestRow）一律是无 border 的 `bg-white/10` pill → 有 border + flex-wrap 换行 = 用户看到的「很怪」。

修复：「打开日志目录」「在 Finder 中显示当前日志」对齐中性 pill（`bg-white/10 hover:bg-white/20`）；破坏性的「清空今天日志」改红系警示（`bg-status-waiting/15 text-status-waiting`）避免误点。

### ✅ 3. GVM cd override 报错污染所有含 cd 的命令（HIGH，用户环境）

`~/.zshrc:1` `source ~/.gvm/scripts/gvm` → `gvm-default:22` `. "$GVM_ROOT/scripts/env/cd"` 把 `cd` 重定义为「按 `.go-version` 自动切 go 版本」的函数。该函数 `scripts/env/cd:57-60` 在 `GVM_ROOT==""` 时 `display_error "GVM_ROOT not set"` + 非零返回。

**触发链**（实测复现）：Claude Code / Agent Deck SDK 的 Bash 工具用 **shell snapshot**（`~/.claude/shell-snapshots/snapshot-*.sh`）还原环境，该 snapshot 捕获了 gvm 定义的 `cd` 函数（line 401），但 Agent Deck 从 GUI 启动、进程环境**不加载 `.zshrc`** 故无 `GVM_ROOT` → 每个 Bash 命令里 `cd` 都命中空分支报错退出。

证据：
```
$ type cd  → cd is a shell function from .../snapshot-zsh-*.sh
$ echo $GVM_ROOT  → []
$ cd /tmp  → ERROR: GVM_ROOT not set. Please source $GVM_ROOT/scripts/gvm  (exit 1)
```

**修复**：`~/.zshrc` 加载 gvm 后 `unfunction cd 2>/dev/null` 根治——保留 gvm 核心（`GVM_ROOT`/`GOROOT`/`PATH`/`gvm use` 全部正常，go1.19 可用），仅去掉脆弱的 cd override（自动切版本特性失效 + 每次 cd fork 子进程的性能负担一并消除）。snapshot 重建后由新 `.zshrc` 接管；当前会话在旧 snapshot 末尾临时 append `unfunction cd` 立即生效。

验证：`zsh -i -c 'type cd; cd /tmp'` → `cd is a shell builtin` + 成功；当前会话直接 `cd ~/Library/Application Support`（最初报错命令）→ OK。

## 修复文件

- `src/renderer/components/IssuesPanel.tsx`
- `src/renderer/components/IssueDetail.tsx`
- `src/renderer/components/ResolveInNewSessionDialog.tsx`
- `src/renderer/components/settings/sections/LogsSection.tsx`
- `~/.zshrc`（用户环境，非项目代码）+ 当前 shell snapshot（临时还原）

## 验证

- `pnpm typecheck` 通过（renderer className 改动不影响类型，确认 JSX 未破坏）
- GVM cd 实测修复（含最初触发报错的命令）
- UI 样式需用户在应用内目视确认（HMR 自动推送 renderer，无需重启）

## 关联

- 与 [REVIEW_66](./REVIEW_66.md) 同在 Issues 页面表现但**不同层**：66 = 数据层（`app.setName` 改 userData 目录致 Issues 空 + 历史会话消失）；67 = UI 层（token 失效致样式失效）。两者正交，互不影响。
- 预防建议：`globals.css` `@theme` 顶部注释列出可用 token 清单，或加 Tailwind token lint，避免后续组件再用未注册 token（Tailwind v4 静默丢弃无编译报错，纯靠目视极易漏）。
- 关联 changelog: 无（review 内直接落地）
