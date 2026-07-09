# CHANGELOG_248: 入口 prompt 资产去重与路径修正

## 概要

prompt-asset 维护轮：根 `CLAUDE.md` / `README.md` 去重并修正过期路径；不改变运行时行为。独立 review 裁决 0 MUST-FIX。

## 变更内容

### `CLAUDE.md`

- 顶部引言删章节清单（TOC 性质双写）和 baseline 自闭环重复句，保留 SSOT 角色与对偶关系声明。
- §IPC 边界修正过期路径：`ipc.ts` → `src/main/ipc/` 各 handler 文件；SettingsSet 中转点 → `src/main/ipc/settings.ts`（实测确认，旧文件已不存在）。
- 删 §IPC 末「HMR 只动 renderer」行：与 §验证流程 重复，后者带重启命令为归属处。

### `README.md`

- 删 macOS 安装块后「不 kill 安装」整段：同一规则三写，agent 行为规则归 `CLAUDE.md` §打包配置规则。
- 「打包规则」kill bullet 收紧为维护者事实，agent 指令措辞指回 `CLAUDE.md`。
- 「进一步阅读」删 ref 阅读工作流指令（`CLAUDE.md` 改动后必做第 4 条拥有）。

### `AGENTS.md`

- 0 修改：已是最小 Codex 入口。

## 备注

- 观察项（未动）：README 项目结构树缺 `src/main/plan-review/` 等少量条目（树标注为按域示意）；CLAUDE.md 打包规则为 macOS 范围、Win 侧仅在 README，scope 划分当前自洽，扩 Win 工作流时再合并。
- 验证：死链检查 0 命中；`git diff --check` 通过；独立 reviewer 确认所有删除规则在同文件或对偶文件中保留。
