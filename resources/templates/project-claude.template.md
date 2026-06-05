# CLAUDE.md

> 给 Claude Code 在本仓库工作时的硬性约定，也是 Claude / Codex 共享仓库规则的 SSOT。
> Agent Deck 应用环境通用约定（输出 / 运行时 / review 对抗 / 工程地基）会随 SDK 会话自动注入；本文件只放**项目专属**。
> Codex 对偶入口是 `AGENTS.md`（薄指针 → 本文件，只补 Codex 入口差异）；共享仓库规则以本文件为准，避免双写漂移。

## 仓库基础

- OS / 包管理器：<例：macOS / pnpm 或 Linux / cargo 或 Windows / pip>
- 语言版本：<例：Node ≥ 18 / Go 1.22 / Python 3.11>
- 其他特殊环境约束：<可空，如必须用 docker compose up 起依赖>

## 项目特定触发

应用环境「新项目工程地基」节定义了通用「改动后必做」流程（README 三问 / changelog / reviews / 反馈升级），本文件只补**项目特定**触发：

- <例：改 main / preload 后必须重启 dev>
- <例：改 DB schema 必须新增 migration 文件 + bump user_version>
- <例：改 IPC channel 后 preload facade 必须同步>

## 项目特定约定（设计要点速查）

> 反复出现过的设计决定，改动前注意。**新升级走 `ref/conventions/<X>-<topic>.md`**（详应用环境 §反复反馈 / 反复踩坑 → 升级约定 节）；本节仅保留 `ref/conventions/` 目录建立**之前**的历史升级，新项目初始为空。

<!-- 模式（每个主题一节）：

### <主题（鉴权 / 状态机 / 数据迁移 / IPC 边界 / 事件去重 / CSS 陷阱 ...）>

- 一句话要点 + 为什么（避免后续推翻）
- 反例 / 已知踩坑 / 关联 CHANGELOG 编号
-->

## 验证流程

```bash
<typecheck 命令>
<build 命令>
<test 命令>
```

修改 <main / preload / native module / config ...> 后必须 <重启 dev / 重新加载 / 重新编译>。

## 部署 / 打包（如有）

<可空。每个步骤带 `#` 注释解释根因，便于将来 review 不退化。打包配置已踩的坑列清单，每条带 CHANGELOG 编号。>
