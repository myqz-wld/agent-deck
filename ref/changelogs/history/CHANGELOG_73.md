# CHANGELOG_73: 清理 experiments/ 过期归档 + docs ADR 关联字段断链处理

## 概要

`experiments/` 目录两份文件（`r1-handoff.md` R1 阶段 hand off 接力文档 + `spikes/SPIKE_REPORT.md` plan v3 前置 spike 报告）所有结论早已落地到 R1-R4 实施（CHANGELOG_61/62 R1.A/D、R2 MCP server、R3 universal team backend、R4 generic-pty 全部 ship 并多轮 follow-up），归档无回看价值。删整个目录 + 处理 active 协议文档对其的引用断链。

## 变更内容

### experiments/

- `git rm -r experiments/` —— 删 `r1-handoff.md`（13K，R1 接力 hand off）+ `spikes/SPIKE_REPORT.md`（13K，5 spike 假设全 ✅ 报告）

### docs/agent-deck-mcp-protocol.md

- 删第 7 行整行「**关联**：plan v3 R2 节 / `experiments/spikes/SPIKE_REPORT.md`（B'-wire / B'-caller-id）」字段，避免 ADR 顶部引用指向已删文件造成断链；plan v3 路径是私有 `~/.claude/plans/...`，跨用户读不到，去掉对 ADR 协议规范本身无任何信息损失（ADR 内容自洽）

### 不动

- `changelog/CHANGELOG_61.md` 2 处 `experiments/spikes/SPIKE_REPORT.md` 引用 —— 历史 changelog，按项目 CLAUDE.md「过期日志不回头改」精神保留断链
- `docs/agent-deck-team-protocol.md` —— 与 mcp-protocol 互引但未引 experiments/，不动

## 备注

- 触发：用户主动询问「experiments/docs/ 目录是否可以删」→ 调研结论 docs/ 是 active 协议规范（src 注释 8 处 + README + 5 changelog/review 引用，必须保留）；experiments/ 是已落地的过期归档，可删
- docs/ **不能删**的判定证据见 grep 结果：`src/shared/types/{settings,team,agent-deck-team,permission}.ts` + `src/main/{cli,event-bus,ipc/teams}.ts` 共 8 处「详 docs/agent-deck-{mcp,team}-protocol.md §X.Y」章节级链接，是当前 active 设计依据
