# History Plans

## Scope

This bucket contains only plans that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `Completed At` or `completed_at` is within the last 3 days, inclusive |
| `recent-week` | `Completed At` or `completed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `Completed At` or `completed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `Completed At` or `completed_at` is older than 30 days, or missing a parseable date |

Legacy topic-and-date plan names and nonterminal snapshots remain stable. Missing completion dates are `unknown`; archived support directories stay beside their related plan.

## Index Table

| Completed At | Plan | Status | Summary | Related Final Record |
|---|---|---|---|---|
| 2026-05-15 | `adapter-architecture-design-20260515.md` | completed | adapter-architecture-design-20260515 — adapter 架构层 design RFC(P4 BaseAdapter + … | None |
| 2026-05-20 | `add-claude-cli-path-override-and-bump-sdks-20260520.md` | completed | 加 `claudeCliPath` 设置项(对齐 codex)+ bump 应用内置 SDK 版本 | CHANGELOG_133 |
| 2026-05-15 | `archive-failure-ux-upthrow-20260515.md` | completed | archive-failure-ux-upthrow-20260515 — archive caller 失败 UX 上抛 follow-up | None |
| 2026-05-15 | `archive-plan-content-overwritten-fix-20260515.md` | completed | archive-plan-content-overwritten-fix-20260515 — archive_plan tool 写 frontmatter… | CHANGELOG_122 |
| 2026-05-15 | `archive-plan-tool-ux-followup-20260515.md` | completed | archive-plan-tool-ux-followup-20260515 — archive_plan tool UX 完善 4 项一并 followup | CHANGELOG_123 |
| 2026-05-15 | `archive-toctou-fix-20260515.md` | completed | archive-toctou-fix-20260515 — K3/baton archive helper TOCTOU race + reasonKind … | None |
| unknown | `ask-user-question-notes-20260615.md` | completed | Goal | CHANGELOG_265 |
| 2026-05-21 | `assets-codex-user-and-ui-unify-20260521.md` | completed | 资产页 codex 端 user 自定义补齐 + claude/codex 展示统一优化 | CHANGELOG_141 |
| 2026-05-26 | `build-dir-migration-20260526.md` | completed | Plan: agent-deck 项目 build 产物全面迁移到 build/ 统一根出口 | CHANGELOG_154 |
| unknown | `claude-compaction-thinking-copy-20260618.md` | completed | Claude Compaction Event Display And Thinking Copy | CHANGELOG_291 / REVIEW_125 |
| unknown | `claude-exit-plan-jsonl-precheck-20260623.md` | completed | Goal | CHANGELOG_317 / REVIEW_137 |
| unknown | `claude-restart-jsonl-drain-20260622.md` | completed | Goal | CHANGELOG_314 / REVIEW_134 |
| unknown | `claude-session-create-lag-20260622.md` | completed | Claude Session Create Lag Investigation | CHANGELOG_316 / REVIEW_136 |
| unknown | `codex-app-server-unification-20260610.md` | completed | Codex App-Server Unification | CHANGELOG_239 |
| 2026-05-15 | `codex-claude-adapter-symmetry-20260515.md` | completed | codex-claude-adapter-symmetry-20260515 — codex/claude adapter 架构对称性 audit + fix | None |
| unknown | `codex-create-session-latency-20260619.md` | completed | Goal | CHANGELOG_310 / CHANGELOG_311 / CHANGELOG_312 / REVIEW_130 / REVIEW_131 / REVIEW_132 / REVIEW_133 |
| unknown | `codex-file-change-accuracy-20260618.md` | completed | Codex File Change Accuracy | CHANGELOG_285 / REVIEW_122 |
| 2026-05-19 | `codex-handoff-team-alignment-20260518.md` | completed | Plan: codex-handoff-team-alignment-20260518 (v4.1 post-P6-light-review) | CHANGELOG_125 / CHANGELOG_126 |
| unknown | `codex-mid-turn-steering-20260610.md` | completed | Codex Mid-Turn Steering | CHANGELOG_236 |
| unknown | `codex-native-agents-skills-20260612.md` | completed | Codex Native Agents And Skills | CHANGELOG_249 / CHANGELOG_250 |
| 2026-06-02 | `codex-recover-network-dirs-parity-20260602.md` | completed | codex recover 重建 thread 丢失 reviewer spawn-time 的 networkAccessEnabled + additio… | CHANGELOG_198 |
| 2026-05-15 | `codex-sdk-bridge-tests-20260515.md` | completed | codex-sdk-bridge-tests-20260515 — codex sdk-bridge 单测套件 + double rename owner c… | None |
| 2026-05-21 | `codex-stream-error-classify-20260521.md` | completed | Codex 流级错误三态识别 — translate.ts 修法 | CHANGELOG_140 |
| unknown | `commit-build-metadata-20260624.md` | completed (legacy index) | Commit Build Metadata Plan | CHANGELOG_323 |
| 2026-05-15 | `cross-adapter-parity-20260515.md` | completed | cross-adapter-parity-20260515 — extraAllowWrite 持久化 + recoverer waiter Promise<… | None |
| unknown | `cross-adapter-sandbox-inherit-20260515.md` | in_progress (legacy snapshot) | cross-adapter-sandbox-inherit-20260515 — RFC §2 Option D 重写 + Option E 重写实施(跨 a… | None |
| unknown | `cursor-cli-acp-investigation-20260617.md` | completed | Cursor CLI ACP Investigation | None |
| 2026-05-14 | `cwd-resilience-fix-20260514.md` | completed | cwd 失效根治:K2 default 改 mainRepo + archive_plan 归档 caller + recoverer 启发式 fallback | None |
| 2026-05-26 | `deep-code-review-main-3m-20260525.md` | completed | Deep code review — main 进程最近 3 个月 churn 文件汇总 | None |
| 2026-05-29 | `deep-project-review-comprehensive-20260528.md` | completed | 全项目 deep review + 4 维优化 plan | CHANGELOG_174 / CHANGELOG_175 |
| 2026-05-30 | `deep-review-and-asset-polish-20260530.md` | completed | Plan: 近期大改动 deep review + 提示词/MCP/文档/图表资产优化 | CHANGELOG_181 / CHANGELOG_182 / CHANGELOG_183 / CHANGELOG_184 / CHANGELOG_185 |
| 2026-05-14 | `deep-review-and-refactor-20260514.md` | completed | Deep code review × 重构机会扫描（agent-deck 全项目热点综合） | None |
| 2026-05-15 | `deep-review-and-refactor-r37-20260515.md` | completed | deep-review-and-refactor-r37-20260515 — REVIEW_37 P1+P2+P3 落地 | None |
| unknown | `deep-review-and-split-20260513.md` | completed | Plan: Deep code review + 6 大文件拆分 + bug 修复（lead 归档→team 联动） | CHANGELOG_80 / CHANGELOG_81 / CHANGELOG_82 / CHANGELOG_83 / CHANGELOG_84 / CHANGELOG_85 / CHANGELOG_86 |
| 2026-05-19 | `deep-review-batch-a1-b-fixes-20260519.md` | completed | Deep-Review Batch A1 + B 收口修复 plan（2026-05-19） | CHANGELOG_128 |
| 2026-05-19 | `deep-review-batch-a1-b-followup-r3-20260519.md` | completed | Plan: R3 follow-up — 5 HIGH + 9 真 MED + F1/F2 用户反馈 | CHANGELOG_129 |
| 2026-05-12 | `deep-review-flow-fix-20260512.md` | completed | Plan: deep-code-review 流程顺畅化 + 透明化快捷键 | CHANGELOG_75 / CHANGELOG_76 / CHANGELOG_77 |
| 2026-06-01 | `deep-review-project-20260531.md` | completed | Deep Review 整个项目 — 多轮异构对抗 review × fix 收口 | CHANGELOG_190 |
| unknown | `deep-review-project-rolling-20260602.md` | completed (legacy index) | Deep-review-project (全项目 BUG 排查 + 优化) — 接力状态 | REVIEW_99..REVIEW_109 |
| 2026-06-08 | `deepseek-summary-handoff-sdk-prompt-20260608.md` | completed | Deepseek Summary/Handoff Provider, SDK Upgrade, Prompt Assets | CHANGELOG_230 |
| unknown | `diff-panel-sdk-upgrade-20260629.md` | completed | Diff Panel Bottom Padding and SDK Upgrade | CHANGELOG_332 / REVIEW_141 |
| unknown | `diff-present-tool-and-walkthrough-skill-20260622.md` | completed | Diff Presentation Tool And Walkthrough Skill | CHANGELOG_313 |
| unknown | `diff-walkthrough-presentation-contract-20260623.md` | completed | Diff Walkthrough Presentation Contract | CHANGELOG_320 / REVIEW_138 |
| 2026-06-01 | `followup-cleanup-20260601.md` | completed | Follow-up 清理 plan（deep-review-project 遗留 11 条） | REVIEW_96 |
| 2026-05-15 | `hand-off-mcp-archive-opt-20260515.md` | completed | hand-off-mcp-archive-opt-20260515 — hand_off_session mcp tool 加 archive_caller … | None |
| 2026-05-15 | `hand-off-mcp-teammate-bug-20260515.md` | completed | hand-off-mcp-teammate-bug-20260515 — hand_off_session mcp tool 把新 session 挂成 te… | None |
| 2026-05-20 | `hand-off-session-adopt-teammates-20260520.md` | completed | `hand_off_session` adopt 语义 + spawn-link bug 双修 | CHANGELOG_135 |
| unknown | `handoff-active-team-membership-api-20260618.md` | completed | Active Team Membership API Optimization | CHANGELOG_284 / REVIEW_121 |
| unknown | `handoff-archived-team-transfer-20260618.md` | completed | hand_off_session Archived Team Transfer Fix | CHANGELOG_282 / REVIEW_120 |
| 2026-05-26 | `handoff-no-spawn-guards-20260526.md` | completed | Plan: hand-off 完全独立于 spawn-guards / 永不写 spawn-link | CHANGELOG_151 |
| 2026-05-24 | `handoff-render-and-image-batch-20260521.md` | completed | Plan: hand off 实时渲染 / cold-start prompt 特殊渲染 / create session 图片不显示 / 图片放大 | CHANGELOG_145 |
| 2026-05-30 | `issue-tracker-mcp-20260529.md` | completed | issue-tracker-mcp-20260529 — agent 执行问题追踪机制（report_issue + append_issue_context… | CHANGELOG_180 |
| unknown | `large-file-split-round-20260624.md` | completed | Large File Split Round | CHANGELOG_326 / REVIEW_140 |
| unknown | `list-sessions-related-default-20260619.md` | completed | Goal | CHANGELOG_303 |
| 2026-05-14 | `llm-handoff-summary-fallback-20260514.md` | completed | LLM 摘要 fallback 自动注入(手段 2) | None |
| 2026-06-03 | `log-noise-and-disposed-20260603.md` | completed | 日志降噪 + webFrameMain disposed 静默化 | CHANGELOG_205 |
| 2026-05-13 | `mcp-bug-and-feature-batch-20260513.md` | completed | Plan: mcp J bug + 10 项 backlog / feature 批量 (lead 归档→team 联动 plan 之后续) | CHANGELOG_87 / CHANGELOG_88 / CHANGELOG_89 / CHANGELOG_90 / CHANGELOG_91 / CHANGELOG_92 / CHANGELOG_93 / CHANGELOG_94 |
| 2026-05-14 | `mcp-handoff-fix-and-skill-timer-20260514.md` | completed | mcp hand-off fix + SKILL timer + 文档大整理（R1 deep review 4 HIGH + 8 MED + 用户 3 件事） | CHANGELOG_98 |
| unknown | `mcp-handoff-worktree-redesign-20260609.md` | in_progress (legacy snapshot) | Plan: MCP handoff and worktree redesign | None |
| unknown | `mcp-server-hot-reload-investigation-20260515.md` | in_progress (legacy snapshot) | mcp-server-hot-reload-investigation-20260515 — in-process MCP server 不 hot relo… | None |
| 2026-05-29 | `mcp-tool-camelcase-migration-20260529.md` | completed | mcp tool 命名统一 camelCase plan (breaking change) | CHANGELOG_177 |
| 2026-05-14 | `mcp-tool-simplify-20260514.md` | completed | Agent Deck MCP 协议大简化:删 reply_message + wait_reply + check_reply + J fix(10→7 to… | None |
| 2026-06-02 | `message-retention-and-index-20260602.md` | completed | message retention GC + listBySession 索引/查询重写 | CHANGELOG_201 |
| 2026-06-02 | `model-token-stats-and-dashboard-20260602.md` | completed | Plan: 模型 Token 统计 + Header Top3 token/s + 数据 Tab | CHANGELOG_197 |
| 2026-05-14 | `model-wiring-and-handoff-20260514.md` | completed | Context | None |
| 2026-05-15 | `p4-baseadapter-d2-implement-20260515.md` | completed | p4-baseadapter-d2-implement-20260515 — RFC §1 Option D2 实施(CreateSessionOptions… | CHANGELOG_121 |
| 2026-06-02 | `pending-tab-resume-and-new-session-default-20260602.md` | completed | pending tab resume 可见性 + 新建会话选项记忆 | CHANGELOG_200 |
| 2026-05-27 | `prompt-asset-review-optimize-20260527.md` | completed | Plan: 提示词资产对抗 review 优化 | CHANGELOG_155 |
| unknown | `prompt-assets-broad-optimize-20260610.md` | completed | Plan: Broad In-App Prompt Asset Optimization | None |
| unknown | `provider-usage-cache-refresh-20260615.md` | completed | Provider Usage Cache And Background Refresh | CHANGELOG_261 |
| 2026-05-26 | `ref-layout-full-migration-20260526.md` | completed | Plan: agent-deck 全面迁移到 ref/ 统一目录布局 | CHANGELOG_153 |
| 2026-05-20 | `remove-aider-generic-pty-adapters-20260520.md` | completed | 删除 aider + generic-pty adapter,同时删 ComposerSdk slash 拦截 | CHANGELOG_131 |
| 2026-05-21 | `restart-controller-jsonl-precheck-20260521.md` | completed | Plan: restart-controller jsonl 预检与 recoverAndSend 路径对称 | CHANGELOG_143 |
| 2026-06-01 | `resume-inject-raw-messages-20260601.md` | completed | Plan: resume/fallback 注入 DB 真实历史消息（总结 + 最近 N 条原始对话） | CHANGELOG_195 |
| 2026-05-21 | `reverse-rename-sid-stability-20260520.md` | completed | 反向 rename：sessions.id 对外稳定 / 引入 cli_session_id 列 | CHANGELOG_136 |
| 2026-05-14 | `review-33-high-fix-20260513.md` | completed | Plan: REVIEW_33 9 条 HIGH 修复 | None |
| 2026-05-14 | `review-35-followup-p1-p2-20260514.md` | completed | REVIEW_35 follow-up 优先级 1+2 实施 | None |
| 2026-05-26 | `review-56-followups-20260526.md` | completed | REVIEW_56 follow-up tracking 19 条逐条收口 | None |
| unknown | `review-latest-and-summary-session-filter-20260618.md` | completed | Goal | CHANGELOG_298 / REVIEW_127 |
| 2026-05-20 | `reviewer-codex-cross-adapter-20260519.md` | completed | reviewer-codex 跨 adapter 直起 + codex 端 deep-review 落地 | CHANGELOG_130 |
| unknown | `reviewer-model-selection-20260629.md` | completed | Reviewer Model Selection | CHANGELOG_329 |
| 2026-05-30 | `runtime-logging-electron-log-20260529.md` | completed | runtime-logging-electron-log-20260529 — 引入 electron-log 让生产 .app console.* 落盘 | CHANGELOG_178 |
| 2026-05-29 | `sdk-spawn-shell-path-20260529.md` | completed | SDK Spawn Shell PATH 修复 plan | CHANGELOG_176 |
| unknown | `send-message-session-not-found-20260629.md` | completed | send_message Session Not Found Fix | CHANGELOG_334 / REVIEW_142 |
| 2026-05-26 | `session-list-handoff-role-badge-20260526.md` | completed | Plan: SessionList hand_off lead/teammate badge 显示修复 (v4) | CHANGELOG_152 |
| unknown | `spawn-session-custom-model-20260625.md` | completed | spawn_session Custom Model Names | CHANGELOG_327 |
| unknown | `spawn-session-model-thinking-20260611.md` | in_progress (legacy snapshot) | spawn_session Model And Thinking Parameters | None |
| 2026-06-01 | `sqlite-tests-no-skip-20260601.md` | completed | 让 SQLite 单测「真跑不 skip」+ 修 4 个真失败文件 | None |
| 2026-05-14 | `summarizer-split-20260514.md` | completed | summarizer.ts 625 LOC 拆分（档位 1：抽 module-level 纯函数） | None |
| 2026-05-24 | `task-mcp-merge-into-agent-deck-mcp-20260521.md` | completed | Plan: task mcp 物理合并到 agent-deck-mcp，让 codex 也能用 | CHANGELOG_146 |
| 2026-05-21 | `task-mcp-owner-session-id-rewrite-20260521.md` | completed | Plan: task mcp 从 team_id 模型重设计为 owner_session_id 纯模型 | CHANGELOG_144 |
| 2026-05-25 | `task-team-id-restore-20260525.md` | completed | Plan: task 表恢复 team_id 字段(nullable),消灭 lead 多 team task 串流 + hand_off ownership… | CHANGELOG_149 |
| unknown | `team-cohesion-fix-20260513.md` | completed | Plan: 团队凝聚力修复（lead 数据源 / TeamDetail / send_message 内嵌 wait / Pending teammate 标… | CHANGELOG_78 |
| 2026-06-01 | `teamless-dm-20260601.md` | completed | Teamless DM — 解除 send_message 的 shared-team 限制 | CHANGELOG_194 |
| 2026-06-03 | `tok-rate-realtime-streaming-20260603.md` | completed | header 实时 tok/s（流式估算·末尾校准）+ GC wiring + DataPanel 文案 + MiniMax fixture 清理 | CHANGELOG_206 |
| 2026-05-14 | `universal-message-watcher-split-20260514.md` | completed | 全仓库 ≤ 500 LOC 护栏达标拆分（CHANGELOG_103 follow-up 优先级 3 拆分护栏批量收口） | None |
| 2026-05-15 | `worktree-stale-base-bug-20260515.md` | completed | worktree-stale-base-bug-20260515 — EnterWorktree CLI 工具创 worktree 用 stale base … | None |
| unknown | `adapter-specific-permissions-view-20260618/PLAN.md` | complete | Adapter-Specific Permissions View | None |

## Legacy Support Material

- `sdk-upgrade-thinking-fix-20260530/`: archived SDK spike reports without a standalone final plan record.
