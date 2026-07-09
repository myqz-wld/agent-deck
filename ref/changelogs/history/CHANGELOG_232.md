# CHANGELOG_232: 项目组织清理

## 概要

本轮只做项目组织层面的低风险整理，不改变运行时行为。

## 变更内容

- `.gitignore` 补充 `dist/`，与项目组织规范中 `build/` / `dist/` 构建产物均不入库的要求对齐。
- 清理仓库本地空 `.claude/` 残留目录；目录内无文件、无 git 跟踪内容。

## 文件大小护栏

本轮未拆 `agent-deck` 现存 500 LOC 以上文件。该仓库已有多轮 review/changelog 记录大文件拆分与保护清单，当前超限文件涉及 MCP tool schema、SDK bridge、session manager 和大型集成测试，适合独立 plan 分批处理，避免和本次组织清理混在同一变更里扩大回归半径。

## 验证

- `git check-ignore -q dist/`
- `find .claude -type f`
