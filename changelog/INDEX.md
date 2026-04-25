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
| [CHANGELOG_19.md](CHANGELOG_19.md) | ActivityFeed 695 行拆 8 文件 + 顺手补初始化 race + 6 候选对抗评估（仅候选 4 落地，5 个不做附触发条件） |
| [CHANGELOG_20.md](CHANGELOG_20.md) | 双对抗架构评审 Phase 0：N1 payload 截断（256KB + shrink 大字段）+ N2 删会话同步关 SDK live Query（adapter capabilities 加 canCloseSession） |
| [CHANGELOG_21.md](CHANGELOG_21.md) | 双对抗架构评审 Phase 1-3：SettingsDialog 720→338 行渐进拆分 + 引入 vitest（14 单测）+ ingest 拆 5 段 + SettingsSet 拆 8 函数 + N6 事务保护 + N8 token 分支 + notify event-router + summarizer 错误诊断聚合到设置面板 |
| [CHANGELOG_22.md](CHANGELOG_22.md) | 双对抗架构评审 Phase 4：N4 migrations 单轨化（vite ?raw inline）+ N5 FTS5 历史搜索（trigram + external content + 触发器同步）+ Opus 实跑 SQL 抓出 alias MATCH 致命 broken + EXISTS→IN+DISTINCT 200×加速 + UPDATE WHEN 防御 + case_sensitive=1 维持原行为 + verify-fts5.sh 12 项集成校验 |
| [CHANGELOG_23.md](CHANGELOG_23.md) | REVIEW_4 修复落地（4 HIGH + 17 MED + 2 LOW，跨 19 文件）：H1 删除会话竞态（intentionallyClosed + 黑名单双保险）+ H2 SettingsSet 运行时 rollback + H3 字节预算改 utf-8 安全切 + KNOWN_LARGE 递归 + H4 RECENT_LIMIT 与 listEvents 对齐 + IPC 边界校验 helper + 双 finished 屏蔽 + event-router try/catch + ClaudeMd save 返回真实写盘内容 + NumberInput integer + ActivityRow memo + thinking/message 折叠 |
| [CHANGELOG_24.md](CHANGELOG_24.md) | REVIEW_5 修复落地：resume 路径两条 active 重复会话根治（H4 sdk-bridge 入口预占 claim + fallback 复用 OLD_ID）+ H1 manager dedupOrClaim 双保险（cwd 命中即便 existing 也 claim）+ payload-truncate 单字段 8KB→64KB（修「展开后仍带 [truncated] marker」） |
| [CHANGELOG_25.md](CHANGELOG_25.md) | 应用内会话「断连自动续」：ComposerSdk 删恢复按钮，sendMessage 抛 not found 直接走 SDK resume；App.tsx history detail 跟 sessions Map 取最新（修 closed→active 复活看不到）+ U2 候选 count=3 走双对抗升级，新建「会话恢复 / 断连 UX（resume 优先）」节进 CLAUDE.md |
| [CHANGELOG_26.md](CHANGELOG_26.md) | 断连自愈下沉到 sdk-bridge.recoverAndSend（B 方案，双对抗推荐）：单飞锁 + 30s UX 占位 message + 从 sessionRepo 补回 cwd/permissionMode + sdk-bridge.test.ts 4 case 覆盖；renderer 删字符串匹配，约定改主语下沉到 owner 层 |
| [CHANGELOG_27.md](CHANGELOG_27.md) | CLI streaming + resume 隐式 fork 兜底：sdk-bridge.consume 内 first realId ≠ opts.resume → renameSdkSession(OLD_ID, NEW_ID) 把 DB record + 子表整体迁；App.tsx historySession 跟随 session-renamed 切 ID；REVIEW_6 双对抗 + 最小复现脚本铁证根因在 CLI native binary，文档与实测不符；新增 sdk-bridge.test.ts 2 case (44/44) |
| [CHANGELOG_28.md](CHANGELOG_28.md) | 第二种 fork 边界兜底（jsonl 不在）：recoverAndSend 预检 ~/.claude/projects/<encoded-cwd>/<sid>.jsonl 是否存在 → 不在则走不带 resume 的 createSession + 事后手工 renameSdkSession(OLD_ID, newRealId)；CLI 历史失但应用层 events DB 保留 + sessionId 切换链路一致；vitest 加 1 case (45/45)；CLAUDE.md fork 边界扩成两类 |
| [CHANGELOG_29.md](CHANGELOG_29.md) | HistoryPanel 周边微调（事后补）：rename 后自动切 live view + 内/外标签 + 监听 rename/upsert 自动 reload + recoverAndSend archived 自动 unarchive |
| [CHANGELOG_30.md](CHANGELOG_30.md) | REVIEW_7 落地修复（1 HIGH + 4 MED + 4 LOW + 1 新 vitest case）：sdk-bridge post-fallback 用 createSession 返回值 + renameSdkSession 内聚 claim 转移 + HistoryPanel listener stale closure + renderer renameSession defensive + App.tsx updater 副作用挑出 + 标签 tooltip + ipc apply 列表统一来源 + 注释精确化（46/46） |
