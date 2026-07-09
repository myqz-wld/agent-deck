# History Changelogs

## Scope

This bucket contains only changelogs that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `changed_at` is within the last 3 days, inclusive |
| `recent-week` | `changed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `changed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `changed_at` is older than 30 days, or missing a parseable date |

Legacy records without a parseable `changed_at` are listed as `unknown`; their content is not backfilled from ambiguous body text or filesystem metadata.

## Index Table

| changed_at | File | Summary (<= 80 chars) |
|---|---|---|
| unknown | `CHANGELOG_1.md` | 项目初始化（M1-M9）+ 应用图标 |
| unknown | `CHANGELOG_2.md` | 工具适配（AskUserQuestion + ExitPlanMode 独立 UI） |
| unknown | `CHANGELOG_3.md` | 对话气泡 / 内部会话演进（user message + Markdown + AskRow 优化） |
| unknown | `CHANGELOG_4.md` | 通知 / 提示音整套（去闪屏 + SoundPicker + Windows 健壮化 + appName） |
| unknown | `CHANGELOG_5.md` | README 三轮同步（含 466→264 重构） |
| unknown | `CHANGELOG_6.md` | 权限交互演进（mode 修复 / 死锁四层兜底 / Slash 拦截 / cancelled 误报） |
| unknown | `CHANGELOG_7.md` | 命令行新建会话 `agent-deck new` |
| unknown | `CHANGELOG_8.md` | SessionList/Detail 行为修复（sticky / 归档过滤 / cwd 缺省 / 集中 PendingTab） |
| unknown | `CHANGELOG_9.md` | 打包 / 安装（dmg + codesign + pkill 三连） |
| unknown | `CHANGELOG_10.md` | Monaco / Diff 红屏修复（同步 throw + async unhandledrejection） |
| unknown | `CHANGELOG_11.md` | 主进程稳定性（safeSend + pin 残影治根） |
| unknown | `CHANGELOG_12.md` | 权限 tab（三层 → 四层 settings） |
| unknown | `CHANGELOG_13.md` | 综合优化批次（haiku 模型 + 12 条 + 10 条） |
| unknown | `CHANGELOG_14.md` | Adapter / 自带 CLAUDE.md / Codex / 图片工具 |
| unknown | `CHANGELOG_15.md` | SDK runtime + 升级 + ENOTDIR 系列主线 |
| unknown | `CHANGELOG_16.md` | 引入 reviews/ 双轨机制 + CLAUDE.md 简化对齐 + 反馈升级加 Agent 踩坑 |
| unknown | `CHANGELOG_17.md` | ~/.claude/CLAUDE.md + 应用注入 CLAUDE.md 骨架优化（节序重排 / 模板瘦身 / 加 CHANGELOG+REVIEW 模板） |
| unknown | `CHANGELOG_18.md` | REVIEW_2 二十处修复 + 用户报告 2 BUG 修复 + REVIEW_X 模板加 frontmatter + agent-deck CLAUDE.m… |
| unknown | `CHANGELOG_19.md` | ActivityFeed 拆模块 + 顺手补初始化 race（含 6 候选对抗评估附录） |
| unknown | `CHANGELOG_20.md` | 双对抗架构评审 Phase 0 — 两个 H 级隐患修复 |
| unknown | `CHANGELOG_21.md` | 双对抗架构评审 Phase 1-3 — 渐进拆分 + 测试基建 + 多模块解耦 |
| unknown | `CHANGELOG_22.md` | 双对抗架构评审 Phase 4 — N4 migrations 单轨化 + N5 FTS5 历史搜索（Opus 实跑 SQL 抓出 broken SQL 致命… |
| unknown | `CHANGELOG_23.md` | REVIEW_4 修复落地（4 HIGH + 17 MED + 2 LOW，跨 19 文件） |
| unknown | `CHANGELOG_24.md` | REVIEW_5 修复落地（resume 路径两条 active 重复会话 + 单字段截断阈值放宽） |
| unknown | `CHANGELOG_25.md` | 应用内会话「断连自动续」+ 历史 detail 跟随 sessions Map |
| unknown | `CHANGELOG_26.md` | 断连自愈下沉到 sdk-bridge（B 方案）+ 30s UX 占位 + 单飞锁 |
| unknown | `CHANGELOG_27.md` | CLI streaming + resume 隐式 fork 兜底（consume 内 OLD_ID → NEW_ID rename） |
| unknown | `CHANGELOG_28.md` | 第二种 fork 边界兜底（jsonl 不在 → 预检 + 不带 resume 新建 + 手工 rename） |
| unknown | `CHANGELOG_29.md` | HistoryPanel 周边微调（rename / unarchive 体验闭环） |
| unknown | `CHANGELOG_30.md` | REVIEW_7 落地修复（1 HIGH + 4 MED + 4 LOW + 1 新 vitest case） |
| unknown | `CHANGELOG_31.md` | 设置面板加「置顶时透明」开关 |
| unknown | `CHANGELOG_32.md` | 设置面板 hook 状态读取 + 透明玻璃关闭后 pin/非 pin 同色 |
| unknown | `CHANGELOG_33.md` | ExitPlanMode 4 档目标权限 + bypass 冷切 |
| unknown | `CHANGELOG_34.md` | ExitPlanMode 批准 bypass 不再弹红字 + 不再多出 cli source 孤儿会话 |
| unknown | `CHANGELOG_35.md` | Agent Teams 接入 M1（基础设施 + 创建入口） |
| unknown | `CHANGELOG_36.md` | agent-deck-plugin 注入对抗 reviewer agents + 决策对抗解耦 |
| unknown | `CHANGELOG_37.md` | NewSessionDialog teamName → prompt 模板自动回填（M1+） |
| unknown | `CHANGELOG_38.md` | ActivityFeed Task 工具专门渲染（subagent_type / 折叠 prompt） |
| unknown | `CHANGELOG_39.md` | Agent Teams M2 — Team 视图（fs 监听 + Team Hub / Team Detail） |
| unknown | `CHANGELOG_40.md` | Agent Teams M3 — 实时 hook 事件 + 操控面板 |
| unknown | `CHANGELOG_41.md` | Sandbox 三档接入正式上线 + Settings Section 折叠 + 双弹框 UX 自动收口 |
| unknown | `CHANGELOG_42.md` | SDK Task Manager — 5 个 in-process MCP 工具 + tasks 表 + team_name 适配 |
| unknown | `CHANGELOG_43.md` | SDK Task Manager 接入运行时 — sdk-bridge 挂载 + closure team_name + 实时事件 |
| unknown | `CHANGELOG_44.md` | deep-code-review skill 改 teammate 主流程 + subagent fallback |
| unknown | `CHANGELOG_45.md` | Inbox Watcher — teammate 权限审批通路（Part A）+ Part D 待 spike |
| unknown | `CHANGELOG_46.md` | Team 名一致性 — 三层反向同步（fs SSOT，应用 DB 跟随） |
| unknown | `CHANGELOG_47.md` | 活动流工具行展示增强 + toolName 双通道漏传 bug 修复 |
| unknown | `CHANGELOG_48.md` | fs watcher symlink path mismatch fix + Agent Teams 权限审批 UX 三件套 |
| unknown | `CHANGELOG_49.md` | deep-code-review skill 接入 milestone task 跟踪 |
| unknown | `CHANGELOG_50.md` | 大文件拆分（types barrel / ipc per-domain / sdk-bridge formatAskAnswers extract） |
| unknown | `CHANGELOG_51.md` | 第二轮大文件拆分（pending-rows / SessionDetail / TeamDetail / session/manager pure helpe… |
| unknown | `CHANGELOG_52.md` | 第三轮大文件拆分（claude sdk-bridge / codex sdk-bridge / session-store / manager.test）激进… |
| unknown | `CHANGELOG_53.md` | deep-code-review skill 引导 lead 走 teammate 通路（修 PendingTab 拿不到 reviewer-codex Ba… |
| unknown | `CHANGELOG_54.md` | 沙盒机制小步加固（A-1 + A-2 + B-4） |
| unknown | `CHANGELOG_55.md` | 跨平台兼容性 — Windows 支持基础设施 |
| unknown | `CHANGELOG_56.md` | TeamDetail 结构化 tasks UI + Teammate 权限 auto-approve |
| unknown | `CHANGELOG_57.md` | 设置面板文案统一与平台分流；Header 新增「📚 资产库」 |
| unknown | `CHANGELOG_58.md` | CLAUDE.md 编辑器迁到资产库 + 设置面板「在资产库中查看」文案统一 |
| unknown | `CHANGELOG_59.md` | NewSessionDialog 删模型下拉 + Codex 新增 per-session 沙盒下拉 |
| unknown | `CHANGELOG_60.md` | 输入框图片附件支持（粘贴 / 拖放 / 上传 三件套） |
| unknown | `CHANGELOG_61.md` | R1.A 阶段 — Codex adapter 能力对齐 Claude（plan v3 落地，6 commit + spike 验证） |
| unknown | `CHANGELOG_62.md` | R1.D 阶段 — Codex 配置生态对齐 Claude（plan v3 落地，4 commit） |
| unknown | `CHANGELOG_63.md` | R2 阶段 — Agent Deck MCP server（plan v3 落地，8 commit） |
| unknown | `CHANGELOG_64.md` | deep-code-review skill 流程重构 + 复杂 plan hand off 约定（双对抗 review 收口） |
| unknown | `CHANGELOG_65.md` | R3 Universal Team Backend 硬切（plan v3 ACCEPTED + PR-A/PR-B 落地） |
| unknown | `CHANGELOG_66.md` | R4 Generic-PTY adapter + aider PTY 接入 + universal team backend cross-adapter 收口 |
| unknown | `CHANGELOG_67.md` | REVIEW_24 落地修复（HIGH-1 + HIGH-2 + 8 MED + 2 LOW） |
| unknown | `CHANGELOG_68.md` | R3.E12 一次性「即将硬切」弹窗 + LegacyTeamExportSection 整体下线 |
| unknown | `CHANGELOG_69.md` | 设置面板信息架构重组 + 资产 toggle 集中 + TeamHub 兼容文案清理 |
| unknown | `CHANGELOG_70.md` | 修 bootstrap mount MCP HTTP transport 失败 (FST_ERR_INSTANCE_ALREADY_LISTENING) |
| unknown | `CHANGELOG_71.md` | REVIEW_28 落地 — 移除 spawn-guards §6.2 cwd cycle + 加 spawned_by_filter / get_sessi… |
| unknown | `CHANGELOG_72.md` | 决策对抗节统一姿势 + 大图自动压缩 + Bug 3 bypass 短路修复 |
| unknown | `CHANGELOG_73.md` | 清理 experiments/ 过期归档 + docs ADR 关联字段断链处理 |
| unknown | `CHANGELOG_74.md` | claudeCodeSandbox per-session 覆盖 + 运行时切档（与 codex 对称三件套）+ 抽 restart-controller s… |
| unknown | `CHANGELOG_75.md` | Cmd+Alt+T 透明化快捷键（toggle transparentWhenPinned） |
| unknown | `CHANGELOG_76.md` | spawn_session 加 agent_name 自动注入 + projectSession 反查 lead teamName |
| unknown | `CHANGELOG_77.md` | SessionList 按 spawnedBy 树形折叠 + lead/teammate badge |
| unknown | `CHANGELOG_78.md` | 团队凝聚力修复 6 Phase 全（plan team-cohesion-fix-20260513） |
| unknown | `CHANGELOG_79.md` | deep-code-review SKILL + 两份 CLAUDE.md 大规模文档减肥 |
| unknown | `CHANGELOG_80.md` | bug 修：lead 归档→team auto-archive 联动 + REVIEW_32 R1 fix 8 条 |
| unknown | `CHANGELOG_81.md` |  |
| unknown | `CHANGELOG_82.md` |  |
| unknown | `CHANGELOG_83.md` |  |
| unknown | `CHANGELOG_84.md` |  |
| unknown | `CHANGELOG_85.md` |  |
| unknown | `CHANGELOG_86.md` | 拆 src/main/session/manager.ts 734 → 5 sibling 文件 |
| unknown | `CHANGELOG_87.md` | J bug fix（lead detail 重复显示 reply）+ check_reply mcp tool |
| unknown | `CHANGELOG_88.md` | main 端 backlog cleanup C/E/G/H 4 项 |
| unknown | `CHANGELOG_89.md` | SessionManager `#sdkOwned` 升级 ECMAScript 真私有 + 公开 hasSdkClaim API |
| unknown | `CHANGELOG_90.md` | N bug fix — 用户「续聊」归档会话自动 unarchive（用户报告新 bug） |
| unknown | `CHANGELOG_91.md` | archive_plan tool 用法文档同步（user CLAUDE.md + resources/claude-config） |
| unknown | `CHANGELOG_92.md` | start_next_session mcp tool 实现 + 文档同步（K2 hand-off 自动化） |
| unknown | `CHANGELOG_93.md` | K3 hand-off UI 按钮 + LLM 历史总结 + modal preview（plan mcp-bug-and-feature-batch-202… |
| unknown | `CHANGELOG_94.md` | Phase 5 — A cross-session UI 渲染区分 + L SessionCard 增强 + M 透明 / 置顶解耦（plan mcp-bug… |
| unknown | `CHANGELOG_95.md` | UX 微调六项 — hand-off 显式触发 + detail header 风格统一 + 接力按钮挪到 Composer 右下 + ActivityFee… |
| unknown | `CHANGELOG_96.md` | session rename / delete 撞 FK constraint 收口（v017 schema CASCADE + rename 显式迁 tea… |
| unknown | `CHANGELOG_97.md` | K2 接力 baton 语义改造（default 不加 team + default 归档 caller） |
| unknown | `CHANGELOG_98.md` |  |
| unknown | `CHANGELOG_99.md` | cwd 失效根治:K2 default mainRepo + 双模式 + archive caller + recoverer 启发式 fallback + … |
| unknown | `CHANGELOG_100.md` | Agent Deck MCP 协议大简化(10 → 7 tool)+ wire format 双锚点 + 文档去冗余 |
| unknown | `CHANGELOG_101.md` |  |
| unknown | `CHANGELOG_102.md` |  |
| unknown | `CHANGELOG_103.md` |  |
| unknown | `CHANGELOG_104.md` |  |
| unknown | `CHANGELOG_105.md` |  |
| unknown | `CHANGELOG_106.md` |  |
| unknown | `CHANGELOG_107.md` |  |
| unknown | `CHANGELOG_108.md` |  |
| unknown | `CHANGELOG_109.md` |  |
| unknown | `CHANGELOG_110.md` |  |
| unknown | `CHANGELOG_111.md` |  |
| unknown | `CHANGELOG_112.md` | hand_off_session 不写 baton spawn-link + UI ↳ teammate badge bug 方案 1 修 |
| unknown | `CHANGELOG_113.md` |  |
| unknown | `CHANGELOG_114.md` |  |
| unknown | `CHANGELOG_115.md` |  |
| unknown | `CHANGELOG_116.md` |  |
| unknown | `CHANGELOG_117.md` |  |
| unknown | `CHANGELOG_118.md` |  |
| unknown | `CHANGELOG_119.md` |  |
| unknown | `CHANGELOG_120.md` | adapter-architecture-design RFC × R1+R1.5 异构对抗 × 三章 ✅ accepted（plan adapter-arc… |
| unknown | `CHANGELOG_121.md` | RFC §1 Option D2 落地：CreateSessionOptions 拆判别联合 + typed registry binding |
| unknown | `CHANGELOG_122.md` | archive_plan tool step 8b post-ff-merge invariant carry-forward + cleanup hint … |
| unknown | `CHANGELOG_123.md` | archive_plan tool UX 完善 4 项 followup (a)+(b)+(c)+(d) |
| unknown | `CHANGELOG_124.md` | 全局快捷键加「一键最大 / 一键回默认」窗口尺寸切换（4 轮异构对抗 review × fix 收口） |
| unknown | `CHANGELOG_125.md` | codex-cli adapter 全面接入 hand_off / archive_plan / team mcp 编排（plan codex-handoff… |
| unknown | `CHANGELOG_126.md` | 复杂 plan 流程 v2 升级（RFC + spike + Deep-Review 前置 / SKILL 改名 + sandbox cp / 4 revie… |
| unknown | `CHANGELOG_127.md` | Prompt 资产按 §提示词资产维护 6 条硬约束清理 + deep-code-review SKILL stub 物理删 |
| unknown | `CHANGELOG_128.md` | deep-review-batch-a1-b-fixes-20260519 plan 收口:6 HIGH + 11 MED 落地 |
| unknown | `CHANGELOG_129.md` | deep-review-batch-a1-b-followup-r3-20260519 plan 收口: 5 HIGH + 9 真 MED + F1/F2 +… |
| unknown | `CHANGELOG_130.md` | reviewer-codex-cross-adapter-20260519 plan 收口: cross-adapter native pair + 5 处 … |
| unknown | `CHANGELOG_131.md` | remove-aider-generic-pty-adapters-20260520 plan 收口: 删 aider + generic-pty adapt… |
| unknown | `CHANGELOG_132.md` | Plan `remove-aider-generic-pty-adapters-20260520` Follow-up F2: 防递归阈值默认值上调 |
| unknown | `CHANGELOG_133.md` | Plan `add-claude-cli-path-override-and-bump-sdks-20260520`: 加 `claudeCliPath` 设… |
| unknown | `CHANGELOG_134.md` | Plan `add-claude-cli-path-override-and-bump-sdks-20260520` Follow-up F1+F2+F3 实施 |
| unknown | `CHANGELOG_135.md` | `hand_off_session` adopt 语义 + spawn-link bug 双修 |
| unknown | `CHANGELOG_136.md` | sessions.id 稳定化（反向 rename 设计） |
| unknown | `CHANGELOG_137.md` | 资产库「应用约定」tab 加 codex 视角编辑器 |
| unknown | `CHANGELOG_138.md` | 图片附件「随便粘一张图就报超 30MB」误报修复 |
| unknown | `CHANGELOG_139.md` | codex spawn 主路径 applicationSid 漏切修复(spawn-link 静默漏写收口) |
| unknown | `CHANGELOG_140.md` | codex 流级错误三态识别(Reconnecting 中间态修复) |
| unknown | `CHANGELOG_141.md` | 资产页 codex 端 user 自定义补齐 + claude/codex 展示统一优化 |
| unknown | `CHANGELOG_142.md` | prompt 资产精简 + 对抗 review fix 闭环 |
| unknown | `CHANGELOG_143.md` | restart-controller jsonl 预检 + helper 共享 fallback 路径 |
| unknown | `CHANGELOG_144.md` | task mcp 数据模型 owner_session_id 重设计 + hand_off 自动过继 |
| unknown | `CHANGELOG_145.md` | hand-off cold-start 特殊渲染 / create session 图片显示 / 图片放大查看 |
| unknown | `CHANGELOG_146.md` | task mcp 合并入 agent-deck-mcp namespace + 删 enableTaskManager toggle |
| unknown | `CHANGELOG_147.md` | 实时 / 历史空态布局居中对齐待处理 / 团队 |
| unknown | `CHANGELOG_148.md` | archive_plan + task_delete ok return 字段统一 camelCase |
| unknown | `CHANGELOG_149.md` | v024 task 表恢复 team_id 字段（NULLABLE）+ hand_off team_task_policy 三态 + task_get tea… |
| unknown | `CHANGELOG_150.md` | SessionList 树形分组递归改造支持 3 层（修 L3 整层消失 bug） |
| unknown | `CHANGELOG_151.md` | `handoff-no-spawn-guards-20260526` plan 收口:hand-off 完全独立于 spawn-guards / 永不写 sp… |
| unknown | `CHANGELOG_152.md` | SessionList hand_off teammate role badge + 视觉缩进显示修复 |
| unknown | `CHANGELOG_153.md` | ref-layout-full-migration-20260526 plan 收口 |
| unknown | `CHANGELOG_154.md` | build-dir-migration-20260526 plan 收口 |
| unknown | `CHANGELOG_155.md` | prompt-asset-review-optimize-20260527 plan 收口 |
| unknown | `CHANGELOG_156.md` | 提示词放宽 build/ 或 dist/ 二选一 + .gitignore 双 defensive 加 dist/ |
| unknown | `CHANGELOG_157.md` |  |
| unknown | `CHANGELOG_158.md` |  |
| unknown | `CHANGELOG_159.md` |  |
| unknown | `CHANGELOG_160.md` |  |
| unknown | `CHANGELOG_161.md` |  |
| unknown | `CHANGELOG_162.md` |  |
| unknown | `CHANGELOG_163.md` | UI 文案精简 + 通俗化(异构对抗 review) |
| unknown | `CHANGELOG_164.md` | UI 文案 Round 2 异构对抗 review × fix(深层一致性 + a11y + corner case) |
| unknown | `CHANGELOG_165.md` | personal task 不再 ingest team-task-* event + ActivityFeed 渲染补全 + dedupOrClaim 早返… |
| unknown | `CHANGELOG_166.md` | UI 文案 review Round 3-5 + SKILL.md Step 5/6 invariant 修订 |
| unknown | `CHANGELOG_167.md` |  |
| unknown | `CHANGELOG_168.md` |  |
| unknown | `CHANGELOG_169.md` | Deep-Review 批 A fix (mcp tools handler) |
| unknown | `CHANGELOG_170.md` | Deep-Review 批 B fix（sdk-bridge 双端断连自愈 + cross-adapter parity + UI 噪声过滤） |
| unknown | `CHANGELOG_171.md` | Deep-Review 批 B R4 split refactor (sdk-bridge 双端单文件大小护栏 + cross-adapter parity) |
| unknown | `CHANGELOG_172.md` | Deep-Review 批 C R1+R2+R3 收口 (6 处必修 fix + 2 regression test) |
| unknown | `CHANGELOG_173.md` | 提示词资产 review R1+R2 收口 (17 处必修 fix) |
| unknown | `CHANGELOG_174.md` | plan deep-project-review-comprehensive-20260528 Phase 2 完整归档 (B 维提示词资产精简) |
| unknown | `CHANGELOG_175.md` | plan deep-project-review-comprehensive-20260528 Phase 3+4+5+6 完整归档 (C/A/D 三维 + … |
| unknown | `CHANGELOG_176.md` | plan sdk-spawn-shell-path-20260529 完整归档 (X1 user shell PATH 注入修 macOS .app laun… |
| unknown | `CHANGELOG_177.md` | plan mcp-tool-camelcase-migration-20260529 完整归档 (32 字段 snake_case → camelCase *… |
| unknown | `CHANGELOG_178.md` | plan runtime-logging-electron-log-20260529 完整归档 (electron-log v5 引入 + 354 处 con… |
| unknown | `CHANGELOG_179.md` | plan runtime-logging-electron-log-20260529 §Step 3.2.6 follow-up: preload fatal… |
| unknown | `CHANGELOG_180.md` | plan issue-tracker-mcp-20260529 完整归档（agent 执行问题追踪机制 mcp tool + UI Issues tab + … |
| unknown | `CHANGELOG_181.md` | Phase C: MCP tool description 优化（防 LLM 传错参 / 意图偏差） |
| unknown | `CHANGELOG_182.md` | Phase D 方案 C：删 sync-codex-skills + claude/codex skills 两端独立 SSOT |
| unknown | `CHANGELOG_183.md` | Phase E 核心：提示词资产分层（删 codebase 内部引用）+ §Issue 上报 章节 |
| unknown | `CHANGELOG_184.md` | Phase E 续：codex 契约节 α（CODEX_AGENTS.md 补 §决策对抗/§三态裁决/§Finding 输出契约） |
| unknown | `CHANGELOG_185.md` | Phase F 架构/流程图：issue-tracker (4) + runtime-logging (2) + 复审 |
| unknown | `CHANGELOG_186.md` | SDK 升级 0.3.144 → 0.3.158（应对 app 内 malformed 工具调用） |
| unknown | `CHANGELOG_187.md` | Phase E F5 follow-up：提示词资产残留 codebase 内部名清理 + 2 处 pre-existing 文档 bug |
| unknown | `CHANGELOG_188.md` | codex-sdk 0.135 升级 + Issue UI 沙盒/刷新修复（deep-review-multi-area-20260530） |
| unknown | `CHANGELOG_189.md` | Issue Tracker 体验与协议改进（状态同步 / 活跃-已解决 tab / kind 收敛 / update_issue_status） |
| unknown | `CHANGELOG_190.md` | 全项目 deep review plan 收口（A-H 25 子批 / REVIEW_71-95） |
| unknown | `CHANGELOG_191.md` | 设置面板「日志」改造:「在 Finder 中显示」→ 应用内 Monaco 只读查看 modal |
| unknown | `CHANGELOG_192.md` | 删「决策对抗」节 + 新建 simple-review SKILL 替代 + 提示词资产维护章节归位 |
| unknown | `CHANGELOG_193.md` | 提示词资产瘦身：CLAUDE.md / CODEX_AGENTS.md / issue tool 描述 + schema 精简 |
| unknown | `CHANGELOG_194.md` | teamless DM：解除 send_message 的 shared-team 限制 |
| unknown | `CHANGELOG_195.md` | resume/fallback 注入 DB 真实历史消息（总结 + 最近 N 条原始对话） |
| unknown | `CHANGELOG_196.md` | 修复日志查看器 modal 被设置面板裁切（createPortal 脱离 backdrop-filter 祖先链） |
| unknown | `CHANGELOG_197.md` | 模型 Token 统计：Header Top3 token/s + 数据 Tab |
| unknown | `CHANGELOG_198.md` | codex recover/restart 还原 reviewer spawn-time networkAccessEnabled + additionalD… |
| unknown | `CHANGELOG_199.md` | PendingTab 批量行收紧：plan / ask 不再被批量、删除 select 下拉 |
| unknown | `CHANGELOG_200.md` | pending tab resume 可见性 + 新建会话选项记忆 |
| unknown | `CHANGELOG_201.md` | agent_deck_messages retention GC + listBySession 索引/查询重写 |
| unknown | `CHANGELOG_202.md` | useImageAttachments 三条图片边界 committed test（REVIEW_111 follow-up issue a28d008f 收… |
| unknown | `CHANGELOG_203.md` |  |
| unknown | `CHANGELOG_204.md` |  |
| unknown | `CHANGELOG_205.md` |  |
| unknown | `CHANGELOG_206.md` |  |
| unknown | `CHANGELOG_207.md` |  |
| unknown | `CHANGELOG_208.md` |  |
| unknown | `CHANGELOG_209.md` |  |
| unknown | `CHANGELOG_210.md` |  |
| unknown | `CHANGELOG_211.md` |  |
| unknown | `CHANGELOG_212.md` |  |
| unknown | `CHANGELOG_213.md` |  |
| unknown | `CHANGELOG_214.md` |  |
| unknown | `CHANGELOG_215.md` |  |
| unknown | `CHANGELOG_216.md` | Codex 侧生成中 tok/s 实时估算 |
| unknown | `CHANGELOG_217.md` | Codex tok/s 完成态校准 |
| unknown | `CHANGELOG_218.md` | Deepseek（Claude Code）会话 profile + 资产页切换防闪烁 |
| unknown | `CHANGELOG_219.md` | resources 配置说明入口归位 |
| unknown | `CHANGELOG_220.md` | spawn_session 跨 adapter 权限默认值 |
| unknown | `CHANGELOG_221.md` | 沙盒/权限重启恢复上下文 |
| unknown | `CHANGELOG_222.md` | reviewer 模型名文案泛化 |
| unknown | `CHANGELOG_223.md` | jsonl 在的 restart resume 不再注入 DB 历史 |
| unknown | `CHANGELOG_224.md` | 幻影 fork 自愈：runtime id 不再污染 cli_session_id |
| unknown | `CHANGELOG_225.md` | CLI wrapper payload 修复权限 flag 再次丢失 |
| unknown | `CHANGELOG_226.md` | 新项目工程地基补 Codex 入口模板（CLAUDE.md + AGENTS.md 成对落地） |
| unknown | `CHANGELOG_227.md` | spawn_session 同 adapter 继承 extraAllowWrite |
| unknown | `CHANGELOG_228.md` | 拆出弱相关提示词并保持 Agent Deck 内置资产自闭环 |
| unknown | `CHANGELOG_229.md` | 修正 Codex deep-review 提示词工具名 |
| unknown | `CHANGELOG_230.md` | Summary / Hand-off 支持 Deepseek + SDK 升级 |
| unknown | `CHANGELOG_231.md` | Codex 默认模型占位不再传给 SDK |
| unknown | `CHANGELOG_232.md` | 项目组织清理 |
| unknown | `CHANGELOG_233.md` | MCP handoff / worktree contract redesign |
| unknown | `CHANGELOG_234.md` | hand_off_session failure cleanup and diagnostics |
| unknown | `CHANGELOG_235.md` | Claude and Codex SDK version bump |
| unknown | `CHANGELOG_236.md` | Codex app-server mid-turn steering |
| unknown | `CHANGELOG_237.md` | Codex steer 收敛到主输入框 |
| unknown | `CHANGELOG_238.md` | Codex 新建会话沙盒档位 upsert 同步 |
| unknown | `CHANGELOG_239.md` | Codex runtime 全量切到 app-server |
| unknown | `CHANGELOG_240.md` | 业务日志打印补强 |
| unknown | `CHANGELOG_241.md` |  |
| unknown | `CHANGELOG_242.md` |  |
| unknown | `CHANGELOG_243.md` |  |
| unknown | `CHANGELOG_244.md` |  |
| unknown | `CHANGELOG_245.md` |  |
| unknown | `CHANGELOG_246.md` |  |
| unknown | `CHANGELOG_247.md` | foundation 模板对齐（目录架构 / 记录编号 / review 过期 / 500 行护栏） |
| unknown | `CHANGELOG_248.md` | 入口 prompt 资产去重与路径修正 |
| unknown | `CHANGELOG_249.md` | 设置面板 MCP 介绍补齐与 Claude Agent SDK 升级 |
| unknown | `CHANGELOG_250.md` | Claude/Codex native agents 与 Codex 会话级注入 |
| unknown | `CHANGELOG_251.md` | reviewer 双侧 thinking 升至 xhigh 与 Claude agent effort 支持 |
| unknown | `CHANGELOG_252.md` | 改动页展示 Codex unified diff 与文件最终 diff |
| unknown | `CHANGELOG_253.md` | 基础目录架构补 `scripts/` 规则 |
| unknown | `CHANGELOG_254.md` | Codex unified diff 复用 Monaco 展示 |
| unknown | `CHANGELOG_255.md` | 最终 diff 改用会话记录文件快照 |
| unknown | `CHANGELOG_256.md` | spawn_session 权限 / 沙盒 override 字段说明收紧 |
| unknown | `CHANGELOG_257.md` | reviewer-claude 消息 MCP 工具与 issue adapter 记忆 |
| unknown | `CHANGELOG_258.md` | 会话详情工具入参可点击展开 |
| unknown | `CHANGELOG_259.md` | 数据 tab 显示 provider 额度窗口 |
| unknown | `CHANGELOG_260.md` | 资产库 Agents 开关补齐与 Claude Skills/Agents 分离 |
| unknown | `CHANGELOG_261.md` | 额度窗口缓存与 Claude 后台查询 |
| unknown | `CHANGELOG_262.md` | 数据 tab 额度窗口不再启动隐藏 provider 子进程 |
| unknown | `CHANGELOG_263.md` | 工具行点击展开入参和出参 |
| unknown | `CHANGELOG_264.md` | 升级 Claude Agent SDK 到 0.3.177 |
| unknown | `CHANGELOG_265.md` | AskUserQuestion 支持用户备注 |
| unknown | `CHANGELOG_266.md` | UI 文案用户化 + Codex reasoning summary |
| unknown | `CHANGELOG_267.md` | Claude/Codex 依赖升级 |
| unknown | `CHANGELOG_268.md` | 总结模型默认提示收敛 |
| unknown | `CHANGELOG_269.md` | 下拉框样式与会话详情横向滚动 |
| unknown | `CHANGELOG_270.md` | 自绘下拉列表与生命周期数字框 |
| unknown | `CHANGELOG_271.md` | 下拉列表向上展开位置修复 |
| unknown | `CHANGELOG_272.md` | 下拉列表贴合触发框 |
| unknown | `CHANGELOG_273.md` |  |
| unknown | `CHANGELOG_274.md` |  |
| unknown | `CHANGELOG_275.md` |  |
| unknown | `CHANGELOG_276.md` |  |
| unknown | `CHANGELOG_277.md` |  |
| unknown | `CHANGELOG_278.md` |  |
| unknown | `CHANGELOG_279.md` |  |
| unknown | `CHANGELOG_280.md` |  |
| unknown | `CHANGELOG_281.md` |  |
| unknown | `CHANGELOG_282.md` | hand_off_session skips archived teams during transfer |
| unknown | `CHANGELOG_283.md` | Foundation prompt asset wording cleanup |
| unknown | `CHANGELOG_284.md` | split active-team membership query semantics |
| unknown | `CHANGELOG_285.md` | filter no-op Codex file changes |
| unknown | `CHANGELOG_286.md` | show adapter-specific permissions views |
| unknown | `CHANGELOG_287.md` | clean up pending question and plan actions |
| unknown | `CHANGELOG_288.md` | keep plan feedback controls stable |
| unknown | `CHANGELOG_289.md` | SDK sandbox/permission restart resume |
| unknown | `CHANGELOG_290.md` | Codex sandbox next-turn apply |
| unknown | `CHANGELOG_291.md` | Claude compaction events and adapter-aware thinking copy |
| unknown | `CHANGELOG_292.md` | Runtime log noise follow-up |
| unknown | `CHANGELOG_293.md` | Session metadata chips and diff navigation |
| unknown | `CHANGELOG_294.md` | Default model chip and branch refresh |
| unknown | `CHANGELOG_295.md` | Diff enlarge overlay portal |
| unknown | `CHANGELOG_296.md` | Codex external hooks |
| unknown | `CHANGELOG_297.md` | Issue branch snapshots and spawn prompt test fix |
| unknown | `CHANGELOG_298.md` | Codex hook origin filtering and lifecycle guard |
| unknown | `CHANGELOG_299.md` | Reuse the Codex quota background app-server |
| unknown | `CHANGELOG_300.md` | Quota percentages render as integers |
| unknown | `CHANGELOG_301.md` | Quota refresh is less aggressive and supports hard refresh |
| unknown | `CHANGELOG_302.md` |  |
| unknown | `CHANGELOG_303.md` | Related session listing and SessionDetail tasks |
| unknown | `CHANGELOG_304.md` | Preload quota snapshots before opening Data tab |
| unknown | `CHANGELOG_305.md` | Refresh quota snapshots outside the Data tab |
| unknown | `CHANGELOG_306.md` | Whole-file diff backgrounds |
| unknown | `CHANGELOG_307.md` | Final diff preserves whole-file create/delete state |
| unknown | `CHANGELOG_308.md` | Final diff matches relative and absolute file paths |
| unknown | `CHANGELOG_309.md` | Final diff repairs historical null-before additions |
| unknown | `CHANGELOG_310.md` | Reduce directory picker and Codex create-session waits |
| unknown | `CHANGELOG_311.md` | Reduce recent warning/error log noise |
| unknown | `CHANGELOG_312.md` | Set provider quota refresh cadence to 10 minutes |
| unknown | `CHANGELOG_313.md` | Add MCP plan/diff presentation tools |
| unknown | `CHANGELOG_314.md` | Wait for Claude stream drain before restart jsonl precheck |
| unknown | `CHANGELOG_315.md` | Prevent stale provider quota snapshots |
| unknown | `CHANGELOG_316.md` | Return Claude UI-created sessions before SDK first id |
| unknown | `CHANGELOG_317.md` | Claude restart phantom-jsonl self-heal uses message freshness |
| unknown | `CHANGELOG_318.md` | Diff walkthrough routing and diff presentation guidance |
| unknown | `CHANGELOG_319.md` | Claude and Codex dependency version bump |
| unknown | `CHANGELOG_320.md` | Diff walkthrough presentation defaults |
| unknown | `CHANGELOG_321.md` | Collapsed taller present_diff cards |
| unknown | `CHANGELOG_322.md` | Reduce Codex quota and SDK orphan-hook log noise |
| unknown | `CHANGELOG_323.md` | Package commit build metadata |
| unknown | `CHANGELOG_324.md` | Document packaged build metadata contract |
| unknown | `CHANGELOG_325.md` | Upgrade Claude Agent SDK to 0.3.187 |
| unknown | `CHANGELOG_326.md` | Split Large Production Files Into Focused Modules |
| unknown | `CHANGELOG_327.md` | `spawn_session` Accepts Custom Model IDs |
| unknown | `CHANGELOG_328.md` |  |
| unknown | `CHANGELOG_329.md` |  |
| unknown | `CHANGELOG_330.md` | `present_diff` annotation cards |
| unknown | `CHANGELOG_331.md` | Deepseek config home path |
| unknown | `CHANGELOG_332.md` | Diff panel bottom padding and Claude/Codex dependency bump |
| unknown | `CHANGELOG_333.md` | Deepseek reviewer max effort |
| unknown | `CHANGELOG_334.md` | send_message resolves target session aliases |
| unknown | `CHANGELOG_335.md` | Annotated present_diff keeps diff colors |
| unknown | `CHANGELOG_336.md` | Refresh Claude and Codex runtime packages |
| unknown | `CHANGELOG_337.md` | Restore red error theme token for diff deletion rows |
| unknown | `CHANGELOG_338.md` | Data tab reasoning token column |
| unknown | `CHANGELOG_339.md` | Refresh Claude and Codex dependencies |
| unknown | `CHANGELOG_340.md` | Clarify token accounting and Claude thinking details |
| unknown | `CHANGELOG_341.md` | Move token accounting under today's summary |
| unknown | `CHANGELOG_342.md` | Rewrite Deepseek token model aliases |
| unknown | `CHANGELOG_343.md` | Refresh Claude Agent SDK runtime dependency |
| unknown | `CHANGELOG_344.md` | Restore immediate Claude streaming input scheduling |
| unknown | `CHANGELOG_345.md` | Refresh Claude and Codex runtime dependencies |
| unknown | `CHANGELOG_346.md` | Refresh Claude/Codex dependencies and verify GPT-5.6 |
| unknown | `CHANGELOG_347.md` | Preserve model slugs and synchronize session reasoning metadata |
| unknown | `CHANGELOG_348.md` | Provider-scoped thinking for summaries and Hand-off briefs |
