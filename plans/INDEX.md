# Plans 索引

> **范围**：跨多会话的复杂工程 plan（按全局 `~/.claude/CLAUDE.md`「复杂 plan：worktree 隔离 + 跨会话 hand off」节流程产出）。本目录是 plan 的 **git 归档目的地**（与 `changelog/` `reviews/` 平级）—— in_progress 工作中可放此或 `.claude/plans/`（local 临时草稿）；completed 必须归档到此入 git。

## 命名

`<topic>-<YYYYMMDD>.md`（与全局约定的 `plan_id` 严格一致；字符集限 `[A-Za-z0-9._-]`、单 segment ≤ 64 字符）。新建前 `ls plans/` 看是否已有同 topic plan 在跑。

## 单文件结构

详见 `~/.claude/CLAUDE.md` 「复杂 plan：worktree 隔离 + 跨会话 hand off → §Step 2 Plan 文件 hand off」节。frontmatter 必含：`plan_id` / `created_at` / `worktree_path` / `status: in_progress|completed|abandoned` / `base_commit`。

## 索引

| 文件 | 状态 | 关联 changelog | 概要（≤80 字） |
|------|------|---------------|---------------|
| [deep-review-flow-fix-20260512.md](deep-review-flow-fix-20260512.md) | completed | [75](../changelog/CHANGELOG_75.md) / [76](../changelog/CHANGELOG_76.md) / [77](../changelog/CHANGELOG_77.md) | deep-code-review 流程顺畅化（Phase A reviewer-codex `$TMPDIR` + SKILL Step 0.6/1/2.5 + 双 Bash 兜底；T1 `Cmd+Alt+T` 透明快捷键；B-D1+D3 spawn_session `agent_name` + lead teamName 反查；C SessionList 树形折叠 + lead/teammate badge）|
| [team-cohesion-fix-20260513.md](team-cohesion-fix-20260513.md) | completed | [78](../changelog/CHANGELOG_78.md) | 团队凝聚力修复 6 Phase 全：A v014 drop sessions.team_name 走 universal team backend；B send/reply/wait_reply 三 tool（messages.reply_to_message_id 对话链）；B5+B7 spawn placeholder + wire format `[msg <id>]` 让 teammate 能 reply_message；C TeamDetail 重写 6 sections「团队工作面板」；D PendingTab teammate chip + role badge；F D6 close 自动 leaveTeam + D7 TeamLifecycleScheduler 5min/30min grace + IPC ShutdownAllTeammates + Header 按钮 |
| [deep-review-and-split-20260513.md](deep-review-and-split-20260513.md) | completed | [80](../changelog/CHANGELOG_80.md) / [81](../changelog/CHANGELOG_81.md) / [82](../changelog/CHANGELOG_82.md) / [83](../changelog/CHANGELOG_83.md) / [84](../changelog/CHANGELOG_84.md) / [85](../changelog/CHANGELOG_85.md) / [86](../changelog/CHANGELOG_86.md) | H1 bug 修 lead 归档→team auto-archive（archive_reason 持久化 + unarchive 反向只复活 `last-lead-archived`，migration v016）+ REVIEW_32 50 commits 异构对抗 review 9 修（HIGH 1-6 + MED 7 + 用户加 HIGH 9）+ Phase 2-4 6 大文件全拆 ≤500（H2 Tier 1 tools/team-repo/session-repo 目录化、H3 Tier 2 pty-bridge 拆 + sdk-bridge 瘦身 816→495、H4 Tier 3 manager.ts 重组 5 sibling + ingest pipeline IngestContext facade，sub-plan SKILL R1 22 finding 异构对抗）|
| [mcp-bug-and-feature-batch-20260513.md](mcp-bug-and-feature-batch-20260513.md) | completed | [87](../changelog/CHANGELOG_87.md) / [88](../changelog/CHANGELOG_88.md) / [89](../changelog/CHANGELOG_89.md) / [90](../changelog/CHANGELOG_90.md) / [91](../changelog/CHANGELOG_91.md) / [92](../changelog/CHANGELOG_92.md) / [93](../changelog/CHANGELOG_93.md) / [94](../changelog/CHANGELOG_94.md) | J bug 修（watcher.deliver 跳过 reply inject 防 lead detail 重复）+ B check_reply mcp tool；Phase 2 C/E/G/H 4 项 main 端 cleanup；Phase 3 SessionManager `#sdkOwned` 真私有；Phase 1.5 N bug 续聊归档会话自动 unarchive；Phase 4a/4b K1+K2 plan-driven mcp tool（archive_plan + start_next_session）；Phase 4c K3 UI hand off 按钮 + LLM 历史总结；Phase 5 A cross-session UI 渲染区分（wire prefix chip + Cross-session messages tab）+ L SessionCard 多行 + 多 tool 增强 + M 透明/置顶解耦 |
| [mcp-handoff-fix-and-skill-timer-20260514.md](mcp-handoff-fix-and-skill-timer-20260514.md) | completed | [98](../changelog/CHANGELOG_98.md) | mcp tool 5 份核心文档 R1 deep review 25 finding + R2 反馈 9 项 + R3 收口 + B14 dormant 反直觉踩坑沉淀（4 atomic commit：A `438a613` src 7 项 / B `0cc4f79` 文档 13 项 / B14 `58a5db9` dormant 沉淀 / E+F `4d48ef0` R2 反馈 1 HIGH + 4 MED + 3 LOW + 8 case test + final `4723fe5` changelog）。R3 双 reviewer 一致裁决「fix 对症 + 0 引新 bug + 可合 (R3 收口)」。新发现 K2 baton spawn_depth 误判 (E1 三改) + dormant 反直觉踩坑 (B14)。tally P34 + U7 候选 +1。 |
| [cwd-resilience-fix-20260514.md](cwd-resilience-fix-20260514.md) | cwd-resilience-fix-20260514 |
| [mcp-tool-simplify-20260514.md](mcp-tool-simplify-20260514.md) | mcp-tool-simplify-20260514 |
| [review-33-high-fix-20260513.md](review-33-high-fix-20260513.md) | review-33-high-fix-20260513 |
| [deep-review-and-refactor-20260514.md](deep-review-and-refactor-20260514.md) | deep-review-and-refactor-20260514 |
| [review-35-followup-p1-p2-20260514.md](review-35-followup-p1-p2-20260514.md) | review-35-followup-p1-p2-20260514 |
| [summarizer-split-20260514.md](summarizer-split-20260514.md) | summarizer-split-20260514 |
| [universal-message-watcher-split-20260514.md](universal-message-watcher-split-20260514.md) | universal-message-watcher-split-20260514 |
| [llm-handoff-summary-fallback-20260514.md](llm-handoff-summary-fallback-20260514.md) | llm-handoff-summary-fallback-20260514 |
| [model-wiring-and-handoff-20260514.md](model-wiring-and-handoff-20260514.md) | model-wiring-and-handoff-20260514 |
| [deep-review-and-refactor-r37-20260515.md](deep-review-and-refactor-r37-20260515.md) | deep-review-and-refactor-r37-20260515 |
| [worktree-stale-base-bug-20260515.md](worktree-stale-base-bug-20260515.md) | worktree-stale-base-bug-20260515 |
| [hand-off-mcp-teammate-bug-20260515.md](hand-off-mcp-teammate-bug-20260515.md) | hand-off-mcp-teammate-bug-20260515 |
| [codex-claude-adapter-symmetry-20260515.md](codex-claude-adapter-symmetry-20260515.md) | codex-claude-adapter-symmetry-20260515 |
| [hand-off-mcp-archive-opt-20260515.md](hand-off-mcp-archive-opt-20260515.md) | hand-off-mcp-archive-opt-20260515 |
| [codex-sdk-bridge-tests-20260515.md](codex-sdk-bridge-tests-20260515.md) | codex-sdk-bridge-tests-20260515 |
| [cross-adapter-parity-20260515.md](cross-adapter-parity-20260515.md) | cross-adapter-parity-20260515 |
| [archive-failure-ux-upthrow-20260515.md](archive-failure-ux-upthrow-20260515.md) | archive-failure-ux-upthrow-20260515 |
| [archive-toctou-fix-20260515.md](archive-toctou-fix-20260515.md) | archive-toctou-fix-20260515 |
| [adapter-architecture-design-20260515.md](adapter-architecture-design-20260515.md) | adapter-architecture-design-20260515 |
| [p4-baseadapter-d2-implement-20260515.md](p4-baseadapter-d2-implement-20260515.md) | completed | [121](../changelog/CHANGELOG_121.md) | RFC §1 Option D2 落地(CreateSessionOptions 拆 4 union arm + buildCreateSessionOptions builder + typed registry binding + 5 处 SSOT 守门链);3 轮异构对抗 review × fix 收口(R1 fix 8a15a6f / R2 fix ad221de / 双方 R3 均 Y);6 处 caller migration(含 RFC §1.5 漏列 sessions-hand-off-helper 第 6 处) |
| [cross-adapter-sandbox-inherit-20260515.md](cross-adapter-sandbox-inherit-20260515.md) | in_progress | — | RFC §2 Option D 重写 + E 重写实施 stub(inherit_sandbox 'restrictions-only' string enum 仅安全方向映射 + warnings 字段;~+175 行;Chapter 1 plan 收口后串行)|
| [archive-plan-content-overwritten-fix-20260515.md](archive-plan-content-overwritten-fix-20260515.md) | in_progress | — | archive_plan tool 写 frontmatter 时覆盖 plan 正文 bug fix(p4-d2 plan 实测撞 + 已 manual fix commit 30467f6);root cause 已实证 archive-plan-impl.ts:228 在 ff merge 前 read planContent;修法拆两次 read |
