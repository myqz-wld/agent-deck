# Reviews 索引

> 周期性 / 触发性的 debug、code review、性能 audit、安全审查报告。功能变更去 [`changelog/`](../changelog/INDEX.md)，本目录专注**修问题与加固**。

## 命名

`review-NNN.md`（NNN 三位递增整数）。新建前 `ls reviews/` 找最大 NNN。

## 单文件结构

- 触发场景（用户主动 / 周期性 / 大重构前 ...）
- 方法（双对抗 Agent 配对、范围、工具）
- 三态裁决清单（✅ / ❌ / ⚠️）+ 证据（文件:行号 + 代码片段）
- 修复条目（按严重度）
- 关联 changelog（本轮修复落地的 CHANGELOG 编号）

## 索引表

| 文件 | 主题 | 严重度分布 | 关联 changelog |
|------|------|-----------|----------------|
| [review-001.md](review-001.md) | main 进程关键模块全审（双对抗 Claude + Codex xhigh） | 3 HIGH / 4 MED / 1 LOW | CHANGELOG_47 |
