# Changelog 索引

> **范围**：功能变更（新功能 / 行为修改 / API / 依赖升级）。
> Debug / 性能 / 安全 review 见 [`reviews/`](../reviews/INDEX.md)（CHANGELOG_16 起划分）。

| 文件 | 概要（≤80 字） |
|------|------|
| [CHANGELOG_1.md](CHANGELOG_1.md) | 项目初始化 M1-M9（Electron+React+TS+Tailwind 半透明窗 / Adapter+Diff 双插件 / SDK+Hook 双通道 / DB v3）+ 应用图标 |
| [CHANGELOG_2.md](CHANGELOG_2.md) | 工具适配 AskUserQuestion + ExitPlanMode：独立类型 + 独立 IPC + 专用 UI（option 按钮 / 批准计划 + markdown 反馈） |
| [CHANGELOG_3.md](CHANGELOG_3.md) | 对话气泡 + Markdown 渲染（user message + MD/TXT 切换从全局级联翻为单条独立）+ AskRow 实色提交 + 毛玻璃底色加深 + header 计数对齐 |
| [CHANGELOG_4.md](CHANGELOG_4.md) | 通知 / 提示音整套：去窗口闪屏 + sound.ts 异步回退 bug + SoundPicker 自定义 + Windows PowerShell MediaPlayer + 防叠播 + 真实 appName |
| [CHANGELOG_5.md](CHANGELOG_5.md) | README 三轮同步：首条消息必填 / settings env / Permission 内嵌 / resume / 466→264 重构 |
| [CHANGELOG_6.md](CHANGELOG_6.md) | 权限交互演进：permissionMode 写库 + bypassPermissions 配套 + 死锁四层兜底（pending 重建 / 警告 / 超时 abort / chip）+ slash 拦截 + cancelled 不再误报 |
| [CHANGELOG_7.md](CHANGELOG_7.md) | 命令行 `agent-deck new`：复用 single-instance + macOS shell wrapper + 默认 prompt"你好" |
| [CHANGELOG_8.md](CHANGELOG_8.md) | SessionList/Detail 行为修复：stickySelected 不闪 + archivedAt 过滤 + cwd 缺省 home + PendingTab 集中（抽 pending-rows + 批量按钮） |
| [CHANGELOG_9.md](CHANGELOG_9.md) | 打包 / 安装 5 步流程：mac.icon + extraResources bin + ad-hoc codesign + pkill 旧进程（chunk hash 错配 → monaco 源码露出） |
| [CHANGELOG_10.md](CHANGELOG_10.md) | Monaco / Diff 红屏修复：window.onerror 同步 + unhandledrejection async 双白名单 + ActivityFeed select-text 可复制 |
| [CHANGELOG_11.md](CHANGELOG_11.md) | 主进程稳定性：safeSend 守 isDestroyed + pin 残影根因升级（`::before mix-blend-mode` 治根 + invalidate 100ms + setBackgroundThrottling(false)） |
| [CHANGELOG_12.md](CHANGELOG_12.md) | 权限 tab 三层 → 四层（user / user-local / project / local）+ HistoryPanel 整行可点 + 已响应/已被 SDK 取消拆开显示 |
| [CHANGELOG_13.md](CHANGELOG_13.md) | 综合优化批次（haiku 模型 + 12 条 + 10 条）：Bearer 鉴权 / Summarizer 超时 / 写放大 / env 白名单 / 历史超期清理 / 死代码清理 |
| [CHANGELOG_14.md](CHANGELOG_14.md) | Adapter 扩展：自带 CLAUDE.md+skill 注入 / Codex CLI adapter / MCP 图片工具 / vision 文生图图生图 / thinking 单独识别 / pin one-shot 强刷 / codex spawn ENOTDIR 修 |
| [CHANGELOG_15.md](CHANGELOG_15.md) | SDK runtime 主线：0.1.x PATH 找不到 node 用 process.execPath 兜 / 升级 0.2.118 修 Task 工具会话死 / 0.2.x native binary spawn ENOTDIR + summarizer 兜底三 bug |
| [CHANGELOG_16.md](CHANGELOG_16.md) | 引入 reviews/ 双轨机制 + CLAUDE.md 简化对齐 + 反馈升级加 Agent 踩坑双对抗三态裁决 + REVIEW_1 八处修复落地 |
| [CHANGELOG_17.md](CHANGELOG_17.md) | 通用 CLAUDE.md 骨架优化（节序重排 / 合并冗余 / 模板瘦身）+ 新增 CHANGELOG/REVIEW 模板（按本项目实际范式抽取） |
| [CHANGELOG_18.md](CHANGELOG_18.md) | REVIEW_2 二十处修复 + 用户报 2 BUG 修 + 已审文件过期机制 + REVIEW_X 模板加 frontmatter + CLAUDE.md 注入 toggle + codex 拆批跑约定 |
