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
