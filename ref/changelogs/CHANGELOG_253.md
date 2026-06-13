# CHANGELOG_253: 基础目录架构补 `scripts/` 规则

## 概要

同步 project-engineering-foundation v0.0.5 的目录架构规则：`scripts/` 是项目脚本和自动化辅助脚本的固定目录。Agent Deck 仓库已有 `scripts/` 目录和 README 树说明，本次补齐仓库级 SSOT `CLAUDE.md`。

## 变更内容

### `CLAUDE.md`

- §基础目录架构补 `scripts/` 条目，明确项目脚本和自动化辅助脚本归位到该目录。

### 不动

- `README.md` 项目结构已包含 `scripts/` 及现有脚本清单，无需重复改动。
- `AGENTS.md` 只引用 `CLAUDE.md` 的共享规则，不双写目录架构。

## 验证

- `git diff --check`
- 确认 `scripts/file-level-review-expiry.sh` 等脚本目录实际存在。
