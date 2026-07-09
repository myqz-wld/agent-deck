# CHANGELOG_219 — resources 配置说明入口归位

## 变更类型
文档维护

## 背景
`resources/claude-config/README.md` 原本同时解释 Claude / Codex 两端资源，并且把 `resources/claude-config` 与 `resources/codex-config` 的打包目标写成同一个 `claude-config` 目录。双端资源说明放在 Claude 子目录下会误导维护者。

## 实现
- 新增 `resources/README.md` 作为打包资源总入口：
  - 明确 `resources/bin` / `resources/claude-config` / `resources/codex-config` / `resources/sounds` 的 `extraResources` 打包目标。
  - 集中说明 Claude / Codex 两端应用约定、agent body、skills 的维护边界。
  - 把双端独立 SSOT 规则上移到共享位置。
- 删除 `resources/claude-config/README.md`，避免同一套维护规则有两个入口。
- 更新维护说明引用：
  - `resources/claude-config/CLAUDE.md`
  - `resources/codex-config/CODEX_AGENTS.md`
  - `src/main/codex-config/skills-installer.ts`

## 验证
- `rg` 检查旧维护说明引用、被删除 README 的活引用和 `README.md §设计 SSOT` 悬空引用。
- `rg` 检查新增 / 修改 README 未命中提示词资产维护自检关键项。
