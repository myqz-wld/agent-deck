# CHANGELOG_156：提示词放宽 build/ 或 dist/ 二选一 + .gitignore 双 defensive 加 dist/

## 概要

应用打包 `resources/claude-config/CLAUDE.md` §新项目工程地基 §src/build 标准目录结构 节放宽 build 产物根出口约定：从原本的「统一 `<project-root>/build/`」放宽为「`<project-root>/build/` 或 `<project-root>/dist/` 二选一（项目内统一）」。同步更新 §.gitignore 必备条目 节，`build/` 与 `dist/` 都作为 defensive 必备条目（项目实际用其一，另一个无害保留为防御性条目，避免临时工具链产生未追踪产物意外入 git）。

## 变更内容

### `resources/claude-config/CLAUDE.md` §src/build 标准目录结构 节

- **目录骨架**：`├── build/` → `├── build/ 或 dist/`（说明二选一）
- **build 产物**：放宽到 `<project-root>/build/` 或 `<project-root>/dist/` 二选一；项目内统一用一个；任何工具链输出（`out/` `release/` `target/` `.next/` `.turbo/` `node_modules/.cache/` 等历史命名）一律收敛到所选根出口的子目录
- **新增 §选 build/ 还是 dist/**：跟工具链默认走（Vite / Webpack / Cargo / tsup / TypeScript 默认 `dist/`；Go / electron-builder / make 默认 `build/`），减少配置摩擦；同项目内不混用（典型陷阱：Vite 默认 `dist/` + electron-builder 默认 `build/dist` → 选一个 root 把另一类产物拍到子目录）
- **多入口项目**：`src/<entry>/` ↔ `build/<entry>/` 或 `dist/<entry>/`
- **顶层资产归位**：原文 "不归 src/ 也不归 build/" → "不归 src/ 也不归所选根出口"
- **.gitignore 必备**：`build/` 与 `dist/` 都加（防御性双条目）
- **落地姿势** 各工具链 outDir / distDir 示例同步给出 `build/` 或 `dist/` 两种写法

### `resources/claude-config/CLAUDE.md` §.gitignore 必备条目 节

```diff
- # build 产物（详 §src/build 标准目录结构 节）
- build/
+ # build 产物（详 §src/build 标准目录结构 节；build/ 与 dist/ 都加，项目实际用其一，另一个无害保留为防御性条目）
+ build/
+ dist/
```

### 同期跨项目执行

按新约定推进 personal/ 下 6 个工程项目对齐（详 commit log）：

| 项目 | 改动 |
|---|---|
| agent-deck-image-mcp | 新增项目级 CLAUDE.md + .gitignore 加 dist/ defensive |
| angry-birds | 新增项目级 CLAUDE.md + .gitignore 加 dist/ defensive |
| vocabmaster | 新增项目级 CLAUDE.md + .gitignore 加 dist/ defensive |
| desk-assistant | .gitignore 加 dist/ + out/（dist/ defensive，out/ 是 electron-vite 默认产物残留位置，本项目已 migrate 到 build/ 但历史 dev 会产生 out/） |
| dev-config-hub | .gitignore 加 `/dist/`（项目实际产物在 dist/，老 `/build/` 是历史遗留 ignore） |
| daily-brief | .gitignore 加 build/ + dist/ defensive；ref/plans/ 目录补建 |

同时给 personal/ 下 2 个非工程项目加非工程标识 CLAUDE.md：

- algorithm-learning（C++ 算法学习项目）
- literary-appreciation（诗歌 / sonnet 文学赏析项目）

两份 CLAUDE.md 显式声明「不走通用 §新项目工程地基」，避免 agent 主动套用 ref/changelogs/ ref/reviews/ ref/conventions/ 等工程目录骨架到非工程项目。

## 验证

各工程项目验证通过：

- agent-deck `pnpm typecheck` exit 0
- agent-deck-image-mcp `pnpm typecheck` exit 0
- angry-birds `bun run build` exit 0（13 modules / 43.0 KB）
- vocabmaster `make build` exit 0
- desk-assistant `pnpm typecheck` exit 0（node + web 双段）
- dev-config-hub `bun run build:fe` exit 0（650 modules / 102ms）
