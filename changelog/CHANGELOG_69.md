# CHANGELOG_69: 设置面板信息架构重组 + 资产 toggle 集中 + TeamHub 兼容文案清理

## 概要

设置面板从平铺 13 个折叠 section 重组为 4 主题分组（**会话** / **提醒与外观** / **集成与运行环境** / **跨工具协作（MCP）**），剩 10 个 section 按主题归位、扫描效率提升。同时把分散的 5 个「资产注入」toggle（CLAUDE.md / agent-deck plugin / Codex AGENTS.md / Codex skills 同步）从 SettingsDialog 三个 section 整体迁到 AssetsLibraryDialog 三 tab 顶部，实现「资产编辑 + 注入开关」单一真源；删 3 个老 section 文件 + 移除 SettingsDialog↔AssetsLibrary 跨 dialog 跳转链路。顺手把 CHANGELOG_68 已下线的「老 Claude Code Agent Teams」TeamHub 空状态兼容文案也清掉。

## 变更内容

### 设置面板（信息架构重组）

- `src/renderer/components/settings/controls.tsx` — 新增 `<SectionGroup title>` 轻量包装组件（仅视觉 label + 上分隔线，无折叠交互；`first:*` 类避免顶部多一道空线）
- `src/renderer/components/SettingsDialog.tsx` — 整体重写编排：
  - 删 3 个资产 section 的 import + JSX：`ClaudeMdSection` / `PluginAssetsSection` / `CodexInjectionSection`
  - 剩 10 个 section 按 4 组重排：「会话」(Lifecycle / Summary) / 「提醒与外观」(Notify / Window) / 「集成与运行环境」(Hook / HookServer / ExternalTools / Experimental) / 「跨工具协作（MCP）」(AgentDeckMcp / CodexMcpServers)
  - 移除 `onOpenAssetsLibrary` prop（设置面板与资产库完全解耦，唯一访问点是 Header「📚 资产库」按钮）
- `src/renderer/components/settings/sections/LifecycleSection.tsx` — `defaultOpen` 改 `true`（接 HookSection 原"打开设置第一眼看到"位置）
- `src/renderer/components/settings/sections/HookSection.tsx` — `defaultOpen` 改 `false`（首装引导早已结束，多数用户已安装）

### 资产库（5 toggle 整体迁入 + 拆 sub-component）

- `src/renderer/components/assets/InjectionToggleBar.tsx` — **新建**：三 tab 维度分发 toggle 渲染（skills tab：plugin + codex skills；agents tab：plugin 同款；claude-md tab：claude system prompt + codex AGENTS.md）。settings null 时显示 placeholder 不报错
- `src/renderer/components/assets/ContentViewerModal.tsx` — **新建**：抽出原 AssetsLibraryDialog 内 ContentViewerModal（54 行纯展示组件），把主文件回压到 ≤500 阈值
- `src/renderer/components/AssetsLibraryDialog.tsx`：
  - 加 settings 状态自管：`useEffect` mount fetch（与资产 list 一起 `Promise.allSettled`）+ `updateSettings(patch)` 包装（dedup seq 防慢响应回写，仿 SettingsDialog REVIEW_4 M9 套路）
  - `updateError` 与 `loadError` 分两 slot 避免互相覆盖
  - 三处 tab JSX 各加 `<InjectionToggleBar>` 顶部渲染
  - `ViewerState` rename 为 `ContentViewerState`（从 ContentViewerModal 文件 import）
  - 文件头注释更新（CHANGELOG_69 历史脉络补全）

### 删除

- `src/renderer/components/settings/sections/ClaudeMdSection.tsx`（48 行）
- `src/renderer/components/settings/sections/PluginAssetsSection.tsx`（50 行）
- `src/renderer/components/settings/sections/CodexInjectionSection.tsx`（58 行）

### App.tsx

- `src/renderer/App.tsx` — 删 `<SettingsDialog onOpenAssetsLibrary={...}>` 跳转 prop（设置面板不再需要这个 callback）；保留 `<AssetsLibraryDialog open={...}>` 与 Header「📚 资产库」按钮链路

### TeamHub 老兼容文案清理

- `src/renderer/components/TeamHub.tsx` — 「暂无团队」空状态删掉「老 Claude Code Agent Teams 数据已不再被读取，详见 README。」整行 + 上面 `<br />`。CHANGELOG_68 已彻底下线 R3 legacy team data 通道，老用户备份窗口结束，提示文字无意义

### 文档同步

- `README.md`「设置」节按 4 组重写 bullet 结构 + 「📚 资产库」节增补 tab 顶部「注入开关」横条说明
- 0 个 main / preload / shared 文件改动；5 个 settings key（`injectAgentDeckClaudeMd` / `injectAgentDeckPlugin` / `injectAgentDeckCodexAgentsMd` / `injectAgentDeckCodexSkills` / `enableAgentDeckMcp` 等）保持稳定，sdk-bridge / sdk-injection / skills-installer / agents-md-installer 不动

## 备注

- **单文件 ≤ 500 行护栏触发拆分**：AssetsLibraryDialog 加 settings + 5 toggle 后达 510 行，按风险升序抽 `ContentViewerModal`（纯展示，零业务依赖）独立文件，主文件回压到 447 行
- **plugin 注入开关在 Skills/Agents 双 tab 同步原理**：两 tab 顶部渲染同一 `injectAgentDeckPlugin` settings key 的两个入口，settings 是单一 React state，update 后 setState → 两 tab 重渲染即一致，无需额外同步代码
- **dirty 拦截契约保持**：原 `claudeMdDirtyRef` 仅拦截 ClaudeMdEditor 草稿（CLAUDE.md 文本未保存关闭时二次确认）。InjectionToggleBar 是即改即生效（点击即写 settings），无 dirty 概念，不新增拦截
- **验证**：`pnpm typecheck` ✅；手动验证清单见 plan §验证（10 项含 toggle 跨 tab 同步、wrapper 新建会话验证注入态等）
- **关联**：plan 文件 `/Users/apple/.claude/plans/modular-booping-valley.md`（用户对齐结论：加分组分隔标题 + 资产 toggle 全部删除只在资产库）；上游 CHANGELOG_57 / 58 把资产编辑 / CLAUDE.md 编辑器搬到资产库，本轮 CHANGELOG_69 完成「设置 / 资产」彻底解耦的最后一步
