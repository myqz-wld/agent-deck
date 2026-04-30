# Reviews 索引

> 周期性 / 触发性的 debug、code review、性能 audit、安全审查报告。功能变更去 [`changelog/`](../changelog/INDEX.md)，本目录专注**修问题与加固**。

## 命名

`REVIEW_X.md`（X 递增整数，跟 `CHANGELOG_X.md` 对齐）。新建前 `ls reviews/` 找最大 X。

## 单文件结构

- 触发场景（用户主动 / 周期性 / 大重构前 ...）
- 方法（双对抗 Agent 配对、范围、工具）
- 三态裁决清单（✅ / ❌ / ⚠️）+ 证据（文件:行号 + 代码片段）
- 修复条目（按严重度）
- 关联 changelog（本轮修复落地的 CHANGELOG 编号）

## 索引表

| 文件 | 主题 | 严重度分布 | 关联 changelog |
|------|------|-----------|----------------|
| [REVIEW_1.md](REVIEW_1.md) | main 进程关键模块全审（双对抗 Claude Opus 4.7 xhigh + Codex gpt-5.4 xhigh） | 3 HIGH / 4 MED / 1 LOW | CHANGELOG_16 |
| [REVIEW_2.md](REVIEW_2.md) | renderer + preload + shared + main 周边全审（双对抗 + 用户报项三方裁决） | 4 HIGH / 10 MED / 6 LOW | CHANGELOG_18 |
| [REVIEW_3.md](REVIEW_3.md) | Phase 4 N5 FTS5 落地后双对抗（Opus 4.7 xhigh 现场跑 sqlite3 CLI 实测 + EXPLAIN QUERY PLAN，外部 codex CLI 16+ 分钟卡 prefetch 中止） | 1 CRITICAL / 2 HIGH / 1 MED / 2 LOW | CHANGELOG_22 |
| [REVIEW_4.md](REVIEW_4.md) | origin/main..HEAD 双对抗（CHANGELOG_19/20/21 落地 19 文件，Opus 4.7 xhigh subagent ×3 + Codex gpt-5.4 xhigh ×3 并发 6 任务） | 4 HIGH / 17 MED / 9 LOW | CHANGELOG_23 |
| [REVIEW_5.md](REVIEW_5.md) | 用户报项「历史会话继续聊天 → 实时面板出现两条 active 重复会话」根因调研（双对抗：Plan subagent Opus 4.7 xhigh + Codex CLI gpt-5.4 xhigh） | 1 HIGH / 1 MED | CHANGELOG_24 |
| [REVIEW_6.md](REVIEW_6.md) | 用户报项「点恢复后表现像新开会话」根因调研：CLI streaming + resume 隐式 fork（最小复现脚本铁证）+ 双对抗 Opus 4.7 xhigh subagent + Codex gpt-5.4 xhigh | 1 HIGH / 2 MED / 2 LOW | CHANGELOG_27 |
| [REVIEW_7.md](REVIEW_7.md) | CHANGELOG_24-29 断连自愈 + fork 兜底 + HistoryPanel 周边周期复审（3 文件 churn/commits 触发过期，4 批 ×2 路 Opus + Codex 并发 background） | 1 HIGH / 4 MED / 4 LOW | CHANGELOG_30（待落地） |
| [REVIEW_8.md](REVIEW_8.md) | ExitPlanMode 4 档目标权限 + bypass 冷切方案对抗审视（双异构：Claude general-purpose Opus 4.7 xhigh + Codex gpt-5.5 xhigh，针对 7 个关键设计点逐条 ✅/❌/⚠️） | 2 HIGH / 2 MED / 3 LOW | CHANGELOG_33 |
| [REVIEW_9.md](REVIEW_9.md) | ExitPlanMode 批准 bypass 双根因对抗（红字 emit ede_diagnostic + cli 孤儿会话）：双异构 Claude general-purpose Opus 4.7 xhigh + Codex gpt-5.5 xhigh；D' (expectedClose 双保险) + 1B (rename 加 recentlyDeleted) 双方一致采纳 | 1 HIGH / 1 MED | CHANGELOG_34 |
| [REVIEW_10.md](REVIEW_10.md) | 打包安装流程验证暴露 main 进程 stdout EPIPE → uncaughtException 把 .app 整个挂掉（trivial 例外未走双对抗，src/main/index.ts 加 stdout/stderr 'error' listener 6 行修复） | 1 HIGH | 无（review 内直接落地） |
| [REVIEW_11.md](REVIEW_11.md) | ExitPlanMode + permissionMode 周边四 bug 双异构对抗（Opus 4.7 xhigh subagent + Codex CLI gpt-5.5 xhigh）：① ede_diagnostic 红字 D' 漏第二条通道（result frame 通道） ② 详情面板 permissionMode 显示器卡旧值（system msg 全丢） ③「保持 Plan」实变 default（approve+plan 走 allow 协议级语义错） ④ default 下 Read 被拦审核（canUseTool 缺 read-only 白名单） | 4 HIGH / 2 MED | 无（review 内直接落地） |
| [REVIEW_12.md](REVIEW_12.md) | approve-bypass 冷切后仍出孤儿「外」会话（REVIEW_9 1B 防护破洞）双异构对抗（Opus 4.7 xhigh subagent + Codex gpt-5.5 xhigh）：根因双根（closeSession 不加黑名单 + OLD CLI fork 出新 sessionId 飞迟到 hook 带 cwd=home dir 兜底）；裁决采纳 Codex origin tag 协议为主修法（env AGENT_DECK_ORIGIN=sdk + curl 转发 X-Agent-Deck-Origin header + ingest 看 origin=sdk skip 不创建 source='cli' 孤儿，零误伤外部 CLI），Opus closeSession 加黑名单作双保险（覆盖老 hook 命令未升级路径） | 2 HIGH | 无（review 内直接落地） |
| [REVIEW_13.md](REVIEW_13.md) | approve-bypass 后弹「Agent 出错」mac 系统通知（REVIEW_11 Bug 1 范围补全 / P17 双通道防护陷阱再撞）：result frame 分支 REVIEW_11 D'2 只 gate 了红字 message emit，漏 gate 同分支 finished emit → routeEventToNotification 看 ok=false 推 mac 通知。修法 1 行：`if (internal.expectedClose) return` 提到分支顶部，三通道（红字 / finished UI / 系统通知）一起 skip；OLD record 后续会被 renameSdkSession 整体迁到 NEW_ID，零副作用。同源补丁未走对抗 | 1 HIGH | 无（review 内直接落地） |
| [REVIEW_14.md](REVIEW_14.md) | Agent 会话沙盒接入可行性调研（feasibility study，非 fix）：双异构 Explore agent + 现场读 sdk.d.ts 实证裁决；铁证 SDK 0.2.118 已含完整 OS 级 sandbox（filesystem/network/autoAllowBashIfSandboxed/excludedCommands）+ hooks API + 桌面应用专用 managedSettings 字段，Agent Deck 100% 没用且 Codex 已默认 workspace-write 反而 Claude Code 最裸；推荐方案 A（settings 加 claudeCodeSandbox 三档默认 off + spike + 渐进默认 on）；候选「调研 SDK 能力强制查 d.ts」沉淀 tally | 2 HIGH / 2 MED / 1 LOW + 4 ❓ 待 spike 验证项 | 无（feasibility study 不引入功能变更） |
| [REVIEW_15.md](REVIEW_15.md) | Sandbox 三档实施 + 多轮实测纠错：实施过程连续 4 次假设错误（managedSettings.sandbox 装载整套 / 不传 network 走工具回路代替 HTTP_PROXY / canUseTool 分支是死代码 / 是某字段触发 SDK 切模式）全被实测证伪；真相 = SDK 沙盒走双层并行（SandboxNetworkAccess 工具回路 + 本地 HTTP_PROXY 注入），canUseTool auto-deny 分支一直稳定生效，model 100% 按 message 指引 fallback 仅 1 弹框（不是概率性 reasoning）；候选「调研 SDK 行为机制凭直觉/局部观察 → 误判」沉淀 tally（与 P20 互补） | 7 ✅（3 HIGH + 2 MED + 2 LOW）+ 4 ❌（plan/调查阶段假设证伪）+ 4 ❓ 阶段 3 候选 | CHANGELOG_41 |
| [REVIEW_16.md](REVIEW_16.md) | fs watcher symlink path mismatch — chokidar 在 macOS fsevents 下回 handle 函数的 filepath 是 realpath 化路径，与代码里 raw symlink path（`getInboxPath` / `getTeamsRoot` 拼出）严格相等比较永远 false → 3 处 fs 通道（inbox-watcher PendingTab teammate 审批 / team-coordinator fs sync / team-watcher team config + task-list 内部 emit）**全静默失效**。用户 ~/.claude → .claude-default symlink 触发；修复 = subscribe 入口 realpathSync 缓存比较基线（最小侵入 ~30 行 diff）。debug 过程 4 个假设全被实测证伪（seenRequestIds dedup / leadSession 找不到 / ingest 吞 / awaitWriteFinish 时序）；候选「fs watcher 路径比较必须假设 path 被 realpath 化」沉淀 tally | 1 ✅ HIGH（3 处同根因）+ 4 ❌（debug 阶段假设证伪）+ 3 ❓ 不动选项 | 暂无（待 CHANGELOG_47） |
| [REVIEW_17.md](REVIEW_17.md) | Agent Teams + SDK Task Manager + Inbox Watcher 三大新模块全审（最近 +8980 行 / 81 文件首次完整 review）。teammate 模式异构对抗 3 轮 + 2 反驳轮（reviewer-claude Opus 4.7 + reviewer-codex wrapper 外部 codex gpt-5.5 xhigh）：Round 1 浅层 + 修复正确性 → Round 2 lifecycle/race/边界 → Round 3 架构/安全/性能。共 13 ✅ 真问题（含 2 HIGH 后被反驳轮降 MED 但 finding 成立 + 2 真 HIGH 必修：cascade 跨 team 删除 / sessionRepo.rename toExists=true team_name 丢失）+ 6 ❌ 反驳证伪 + 多个 ❓ 不修；codex 反驳轮实测 POSIX rename 不跟随 symlink 证伪 claude 主攻击路径但 writeFile dangling symlink 路径仍真实成立 + convention 不对称值得修。8 个 atomic commit 落地，每个独立可 revert | 2 HIGH（H1 cascade 跨 team / H1-R2 rename 丢 team_name）+ 9 MED（H2 listSeen / M3 deps / M5 mock / M6 双重 unset / M7 lazy / H2-R2 prewarm / M1-R2 cascade emit / MED-R2-1 emit try-catch / M2-R2 trim + 3 R3 MED：H1-R3 ensureWithinRoot 降 / M1-R3 prompt-injection / M2-R3 单遍 / M3-R3 placeholder dedup）+ 5 LOW（M4/L8/L10/LOW-1/LOW-2 + L1-R2）+ INFO 不修 | 8 commit (6abbb57 / 360f606 / 9401372 / 48f3c01 / 703b00a / 43ac8c5 / cac8217 / c5f2a41) — 无独立 CHANGELOG，atomic commit message 自携详细 |
