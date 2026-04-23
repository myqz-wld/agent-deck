# Changelog 索引

> **范围**：功能变更（新功能 / 行为修改 / API / 依赖升级）。
> Debug / 性能 / 安全 review 见 [`reviews/`](../reviews/INDEX.md)（CHANGELOG_47 起划分）。

| 文件 | 概要（≤80 字） |
|------|------|
| [CHANGELOG_1.md](CHANGELOG_1.md) | 项目初始化 M1-M9：Electron+React+TS+Tailwind 半透明窗 / Adapter+Diff 双插件 / SDK+Hook 双通道 / 状态机 / 列表+详情+总结 / 权限 UI / DB v3 |
| [CHANGELOG_2.md](CHANGELOG_2.md) | 应用图标：Wakaba_Mutsumi 头像 1024×1024 写入 resources/icon.png |
| [CHANGELOG_3.md](CHANGELOG_3.md) | AskUserQuestion 工具适配：SDK canUseTool 拦截 → 独立 UI（选项按钮+其他文本）→ 答案塞 deny.message 反馈 |
| [CHANGELOG_4.md](CHANGELOG_4.md) | 内部会话能看完整对话：sendMessage emit user message + ActivityFeed 改对话气泡渲染 |
| [CHANGELOG_5.md](CHANGELOG_5.md) | 提醒整顿：去掉窗口闪屏 + 修 sound.ts 异步回退 bug + 系统声音 Sosumi→Glass/Tink |
| [CHANGELOG_6.md](CHANGELOG_6.md) | 自定义提示音：waiting/finished 各一个 + SoundPicker UI + 试听 + 重置 |
| [CHANGELOG_7.md](CHANGELOG_7.md) | 提示音播放健壮化：Windows 用 PowerShell MediaPlayer 支持 mp3 + 防叠播 + 5s 时长上限 |
| [CHANGELOG_8.md](CHANGELOG_8.md) | README 与代码现状同步（首条消息必填 / settings env / DB v4 / 测试通知按钮） |
| [CHANGELOG_9.md](CHANGELOG_9.md) | 新建会话权限模式修复 + bypassPermissions 配套 allowDangerouslySkipPermissions + 输入键 Cmd+Enter→Enter |
| [CHANGELOG_10.md](CHANGELOG_10.md) | 权限请求死锁四层兜底：listPending 重建 + sendMessage 警告 + permissionTimeoutMs + header chip 跳转 |
| [CHANGELOG_11.md](CHANGELOG_11.md) | AskRow 提交按钮显眼化 + 毛玻璃默认底色加深 |
| [CHANGELOG_12.md](CHANGELOG_12.md) | README 与代码再次同步：Permission/AskRow 内嵌活动流 / 会话恢复 resume / SDK vs Hook session-end 差异 |
| [CHANGELOG_13.md](CHANGELOG_13.md) | 命令行新建会话 `agent-deck new --cwd ... --prompt ...`：复用 single-instance 通路 + macOS shell wrapper |
| [CHANGELOG_14.md](CHANGELOG_14.md) | SessionDetail 不被「刷新跳转」回 SessionList：App.tsx 加 stickySelected 缓存 |
| [CHANGELOG_15.md](CHANGELOG_15.md) | 间歇总结优先用 haiku：summariseViaLlm 加 ANTHROPIC_DEFAULT_HAIKU_MODEL 三层优先级 |
| [CHANGELOG_16.md](CHANGELOG_16.md) | 打包配置修复 + 安装流程文档化：mac.icon + extraResources bin + CLAUDE.md 安装节 |
| [CHANGELOG_17.md](CHANGELOG_17.md) | 修归档会话仍出现在「实时」面板：SessionList 过滤补 archivedAt === null |
| [CHANGELOG_18.md](CHANGELOG_18.md) | 测试通知按真实 appName 显示（dev='Electron' / prod='Agent Deck'） |
| [CHANGELOG_19.md](CHANGELOG_19.md) | 抑制 Monaco 卸载 race 弹红屏：window.onerror 兜底白名单加 TextModel disposed |
| [CHANGELOG_20.md](CHANGELOG_20.md) | 修打包后 LLM 总结全降级：sdk-runtime.ts 用 process.execPath + ELECTRON_RUN_AS_NODE 复用 Electron Node |
| [CHANGELOG_21.md](CHANGELOG_21.md) | 安装流程加 ad-hoc codesign：修通知中心归到 Electron 而非 Agent Deck |
| [CHANGELOG_22.md](CHANGELOG_22.md) | 修 webContents.send 撞已销毁窗口：抽 safeSend isDestroyed 守卫 |
| [CHANGELOG_23.md](CHANGELOG_23.md) | 新建会话 cwd 缺省回落用户主目录：Dialog/IPC/CLI/wrapper 全链兜底 |
| [CHANGELOG_24.md](CHANGELOG_24.md) | 修 pin 模式主界面残影（早期方案）：FloatingWindow 加 invalidateTimer 200ms（CHANGELOG_35 升级根因） |
| [CHANGELOG_25.md](CHANGELOG_25.md) | 修 monaco unhandledrejection 红屏 + 活动流可复制（select-text 覆盖 user-select: none） |
| [CHANGELOG_26.md](CHANGELOG_26.md) | 安装流程加 pkill 旧进程：修复装新版后 chunk hash 错配导致 monaco 源码露出 |
| [CHANGELOG_27.md](CHANGELOG_27.md) | header 会话计数对齐（抽 selectLiveSessions）+ MessageBubble MD/TXT 切换按钮 |
| [CHANGELOG_28.md](CHANGELOG_28.md) | ExitPlanMode 工具适配：独立 UI（绿色 header + 批准/继续规划按钮 + 反馈输入框） |
| [CHANGELOG_29.md](CHANGELOG_29.md) | 会话详情新增「权限」tab：三层 settings.json 合并展示 + 「打开」按钮 shell.openPath |
| [CHANGELOG_30.md](CHANGELOG_30.md) | ComposerSdk 拦截 `/` 开头 slash 命令（SDK streaming 不支持）+ 本地红条提示 |
| [CHANGELOG_31.md](CHANGELOG_31.md) | 修「等待你的输入」误报：cancelled 事件按 payload.type 区分，不再切 activity / 不再 notify |
| [CHANGELOG_32.md](CHANGELOG_32.md) | 权限 tab 补 user-local 层（`~/.claude/settings.local.json`）扩到四层 |
| [CHANGELOG_33.md](CHANGELOG_33.md) | 综合优化批次 12 条：HookServer Bearer 鉴权 + Summarizer LLM 超时 + writeSettings 原子写 + 死代码清理 |
| [CHANGELOG_34.md](CHANGELOG_34.md) | MessageBubble MD/TXT 切换改为单条独立（推翻 CHANGELOG_27 全局切换） |
| [CHANGELOG_35.md](CHANGELOG_35.md) | pin 残影根因升级：`.frosted-frame::before` mix-blend-mode 治根 + invalidate 100ms + render-mode.ts 删除 |
| [CHANGELOG_36.md](CHANGELOG_36.md) | Agent Deck 自带 CLAUDE.md + skill 注入：resources/claude-config 通过 SDK systemPrompt append + plugins |
| [CHANGELOG_37.md](CHANGELOG_37.md) | 优化批次 10 条：历史超期清理 + removeSession 三 Map 清理 + Bearer timingSafeEqual + batchSetLifecycle |
| [CHANGELOG_38.md](CHANGELOG_38.md) | MCP 图片工具支持（ImageRead/Write/Edit/MultiEdit）：识别 mcp__*__Image* + ImageDiffRenderer 三视图 |
| [CHANGELOG_39.md](CHANGELOG_39.md) | 图片工具语义修正（vision 描述 / 文生图 / 图生图 / 链式编辑）+ ToolEndRow 缩略图+描述并排 |
| [CHANGELOG_40.md](CHANGELOG_40.md) | 集中「待处理」Tab：三 section 平铺 + 全部允许/拒绝批量 + 抽 pending-rows |
| [CHANGELOG_41.md](CHANGELOG_41.md) | Codex CLI adapter（@openai/codex-sdk）：完整实装 + 诚实 capabilities + 设置面板 codex 二进制路径 |
| [CHANGELOG_42.md](CHANGELOG_42.md) | 应用约定 UI 编辑（ClaudeMdEditor）+ 对抗 Agent 异构升级 + codex CLI 调用模板 + 修 PendingTab 点击无反应 + Codex 30s 误导文案 |
| [CHANGELOG_43.md](CHANGELOG_43.md) | thinking 单独识别（ThinkingBubble dashed 边框 / Claude+Codex 共用）+ pin 残影 one-shot kickRepaintAfterPin + 修打包后 codex spawn ENOTDIR |
| [CHANGELOG_44.md](CHANGELOG_44.md) | 升级 claude-agent-sdk 0.1.77→0.2.118 修 Task 工具完成后会话死 + README 重构 |
| [CHANGELOG_45.md](CHANGELOG_45.md) | README 重构 466→264 行：递进式结构 / 一级 11→8 / 三级 30+→14 |
| [CHANGELOG_46.md](CHANGELOG_46.md) | 修打包后 summary 全降级（claude binary asar 路径 ENOTDIR）+ summarizer 3 个兜底 bug |
| [CHANGELOG_47.md](CHANGELOG_47.md) | 双对抗 review 8 处修复（HIGH 3 / MED 4 / LOW 1）+ 文档机制重构（reviews 目录引入 / 反馈升级加 agent-pitfall + 双对抗 / 三份 CLAUDE.md 简化与对齐） |
