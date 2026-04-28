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
