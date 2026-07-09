# CHANGELOG_167

settings 面板 flex 单行布局挤压批量修复(CHANGELOG_161+162 同 pattern follow-up):ExperimentalSection 两个沙盒 select + AgentDeckMcpSection Token 复制按钮。

## 概要

User 截图反馈两处同款 bug:

1. **Codex 沙盒(系统级隔离)** 标签被竖向压缩成单字符宽 — select 内最长 option `"⚠️ 完全开放（可改任意文件 / 联网 / 运行任意命令）"` 27 字撑爆容器把 span 挤死
2. **MCP Bearer Token「复制」按钮** 被竖向压缩成单字符宽 — input `w-full` 撑爆容器把按钮挤死

**共同根因**:`SettingsDialog` 容器 `w-[340px]` - `p-4` = 308px 可用宽度。flex 容器内子元素默认 `min-width: auto`(按内容最小宽度),长 input / select / option 子元素 intrinsic 宽度撑爆容器时,flex 不能将它们 shrink → 把兄弟元素(span / 短 button)挤成竖向单字符宽。

**修法**:对齐 `SummarySection.tsx` ModelRow follow-up(CHANGELOG_161+162)同 pattern:
- 长 input / select 加 `min-w-0` 允许 flex shrink
- 固定宽度兄弟元素(button / span)加 `shrink-0` 锁定不被压缩
- 长 select option label 缩短,详细说明保留 `title` 属性 + hint bullet

## 变更内容

### `src/renderer/components/settings/sections/ExperimentalSection.tsx`

**Claude Code 沙盒 div**(L32-47):
- 外层 className 从 `flex items-center justify-between text-[11px]` 改为 `flex flex-col gap-1 text-[11px]`
- `<span>` 改为 `<div>` 占第 1 行
- `<select>` 加 `w-full` 占满第 2 行

**Codex 沙盒 div**(L70-85):
- 外层同款 2 行布局改造(保留 `mt-3` section 间距)
- `<select>` 同款 `w-full`
- `<option value="danger-full-access">` 文字缩短:`"⚠️ 完全开放（可改任意文件 / 联网 / 运行任意命令）"` → `"⚠️ 完全开放（无限制）"`,详细说明保留在 `title` 属性(鼠标悬停)

**Codex 沙盒 hint div**(L86-90):
- 补三档 bullet 说明对齐 Claude Code 沙盒详细程度(L48-69)
- 新加三档说明同 title 属性内容,让 hint 与 select 共同描述清楚每档行为

### `src/renderer/components/settings/sections/AgentDeckMcpSection.tsx`

**MCP Bearer Token input + 复制按钮**(L133-152):
- `<input>` className 从 `w-full` 改为 `min-w-0 flex-1` — 允许 flex shrink + 占剩余空间
- `<button>` 加 `shrink-0` — 锁定按钮不被压缩

## 不影响

- 字段 schema(`claudeCodeSandbox` / `codexSandbox` / `mcpServerToken`)不动
- 默认值 / option value 枚举不动
- IPC dispatch 不动
- 仅 2 个 renderer 文件改动,HMR 自动推送

## 验证

- `pnpm typecheck` GREEN
- UI 手测:dev 模式下打开「设置 → 通用 → 集成与运行环境 → 实验功能」展开,确认两个沙盒控件 label / select / hint 三行清晰布局,Codex select 不再溢出挤压 label;「设置 → 通用 → 跨工具协作(MCP)」展开,确认 Token 输入框 + 「复制」按钮单行清晰布局,按钮不再被挤压成竖向

