# CLAUDE.md

> 本文件保留 **agent-deck 项目专属 design invariant**（§项目特定约定 / §仓库基础 / §验证流程 / §打包与本地安装）+ 普通终端 Claude 跑本仓库时的最低入口规则。Codex 对偶入口是 `AGENTS.md`；共享仓库规则以本文件为准，`AGENTS.md` 只补 Codex 入口差异，避免双写漂移。
>
> **应用 SDK 会话内**额外加载 `resources/claude-config/CLAUDE.md` 获取 Agent Deck 协议约定。项目产物按本文件最小规则和 `ref/` 现有索引/模板相邻格式执行；Agent Deck 内置 baseline 必须自闭环。

## 仓库基础

- macOS 环境，包管理器用 pnpm
- Node.js ≥ 18（推荐用 nvm 管理）

---

## 改动后必做（最低操作指南）

> 本节保留本仓库的最低闭环执行流程。涉及 `ref/` 项目产物时，直接沿用 `ref/changelogs/`、`ref/reviews/`、`ref/conventions/`、`ref/flows/`、`ref/architecture/` 的现有 INDEX 和相邻文件格式。

1. **改用户可见行为 / 文件结构 / 启动方式**（UI / 设置项 / 快捷键 / 项目结构 / 端口 / 依赖 / 验证步骤）→ 改对应章节 `README.md`；纯 bug 修复 / 内部重构不动 README
2. 改功能前先读当前项目已有的约定、changelog、review 记录；优先从对应 `ref/*/INDEX.md` 进入，再读相关条目
3. 改长生命周期 prompt 资产前，按“内置资产自闭环原则”完成 inventory、备份、去重、对偶资产同步和 review；Agent Deck 必要行为必须保留在内置资产内

---

## 项目特定约定（设计要点速查）

反复出现过的设计决定，改动前注意：

### 鉴权与会话边界

- 应用**不读不写**任何 API Key。所有 SDK 调用走本地 `~/.claude/.credentials.json`（OAuth）
- 间歇总结的 SDK oneshot 设 `settingSources: []`，避免 hook 回环到自己
- 应用内会话的 SDK 设 `settingSources: ['user', 'project', 'local']`，等价于在该 cwd 跑 `claude`

### 跨会话协作 / MCP 边界

- 跨 adapter 协作走 Agent Deck Universal Team Backend + Agent Deck MCP tools；不要恢复旧 inbox-based Agent Teams backend。
- Teammate 调工具走 teammate 自己会话的 permission / sandbox 边界；lead 不代批权限，不把 lead 的 `permissionMode` / allowlist 套到 teammate。
- Agent Deck MCP server 默认开启；关闭 `enableAgentDeckMcp` 时，新建 SDK 会话不挂 agent-deck MCP tools，Codex 自动注入的 `mcp_servers.agent-deck` 段也会移除。
- Claude / Codex 应用提示词资产必须成对审计：`resources/claude-config/CLAUDE.md` ↔ `resources/codex-config/CODEX_AGENTS.md`，skills 目录同名文件也要检查对偶。adapter 工具差异允许措辞不同，但协议语义不能单边漂移。

### 内置资产自闭环原则（重要）

Agent Deck 内部资产必须在 Agent Deck bundle 内自闭环；这是本项目的核心设计原则之一，不是实现细节。`resources/claude-config/`、`resources/codex-config/`、内置 `agent-deck-plugin` agents/skills、注入 SDK 的 MCP tool description 都必须在 Agent Deck baseline 内自洽生效。Agent Deck 内置行为必须不依赖额外安装内容，仍必须完整可用。

根 `README.md`、`CLAUDE.md`、`AGENTS.md`、`resources/README.md` 也是长期 prompt 资产；修改时按同一原则审计自闭环、触发条件、边界和本地链接。通用 prompt-asset inventory、备份、去重和 review 流程由维护 workflow 承担，不写进 Agent Deck runtime baseline。

外部扩展只可增强本仓库工作流，不能承载 Agent Deck 内置行为。把弱相关内容拆出去时，只能从内置资产中删除，或保留一份自闭环的最小规则；**不得**把必要行为替换成外部资产指针。Agent Deck 自带并随应用打包的 internal agents / skills / resources 可以互相引用作为内部闭环，但引用方仍要保留触发条件、边界和失败动作等执行所需的最小信息。

### 主进程模块通信 / IPC 边界

- 模块单例通过 `setX` / `getX` 暴露（如 `getLifecycleScheduler()`），不要在 `ipc.ts` 直接 import 实例对象（循环依赖 / 时序问题）
- 跨进程事件统一走 `event-bus.ts` + `safeSend` 兜底 `isDestroyed`，不要直接调 `webContents.send`
- `ipc.ts` 的 `SettingsSet` handler 是**即改即生效**中转点：每加一个新设置项，必须在这里加分发逻辑，否则「能改但不生效」
- `shared/types.ts` 只允许标准库类型，不准 import Electron / Node API
- preload `window.api` 是强类型 facade；动态 channel 用 `window.electronIpc.invoke()` 兜底
- HMR 只动 renderer；改 main / preload **必须重启 dev**

## 反复反馈 / 同类问题 → 升级约定（最低操作指南）

用户给出纠正性 / 偏好性反馈，或 Coding Agent 在 review / 修 bug 时发现同类工程问题，记录到 `ref/conventions/` 的现有索引/相邻格式；到达升级门槛时，把证据、候选规则和建议裁决（采用 / 放弃 / 继续观察）交给 user 确认。一次性请求和 trivial 观察不升级。

---

## 验证流程

改完代码：

```bash
pnpm typecheck       # 必跑
pnpm build           # 大改动跑
```

改 main / preload → **重启 dev**：

```bash
# kill 干净
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9
pkill -f "electron-vite dev" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null

# 重启（在仓库根目录跑）
pnpm dev
```

改 renderer → 等 HMR 自动推送，无需重启。

---

## 打包与本地安装（macOS）

每次想体验「装好的版本」或者验证 wrapper 能不能从 .app 找到 → 完整跑一遍：

```bash
# 0. 杀掉所有旧实例（必做；见下面规则清单）
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "Agent Deck Helper" 2>/dev/null

# 1. 出 dmg + .app（约 1 分钟）
rm -rf build/dist && pnpm dist

# 2. 覆盖安装到 /Applications（已有同名 .app 时必须先 rm，cp -R 不会清残留）
rm -rf "/Applications/Agent Deck.app"
cp -R "build/dist/mac-arm64/Agent Deck.app" /Applications/

# 3. ad-hoc 重签名（见下面规则清单）
codesign --force --deep --sign - "/Applications/Agent Deck.app"

# 4. 清掉 quarantine 属性
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 5. 软链 wrapper 到 PATH（一次性）
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck
```

### 打包配置规则

- `mac.icon: "resources/icon.png"` 必须显式配置；`extraResources` 必须把 `resources/bin` copy 到 .app 的 `bin`。
- ad-hoc 重签、重装前 pkill 旧进程、SDK / codex native binary unpack 都是必需项；缺任一项先修配置，不要绕到业务代码。
- 验证 wrapper 前必须 `unset ELECTRON_RUN_AS_NODE`；若二进制表现成 Node 或把 `new` 当脚本解析，这是验证环境污染，不要改 wrapper / 打包配置。
- 跑 vitest SQLite 真测前后必须保护 better-sqlite3 binding（证据：CHANGELOG_42）。若 Electron 报 `NODE_MODULE_VERSION 115 vs 130`，清 npm prebuild cache 和 binding build 目录后强制 rebuild：
  ```bash
  rm -f ~/.npm/_prebuilds/*better-sqlite3*
  rm -rf node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build
  zsh -i -l -c "pnpm postinstall"
  ```
  默认走 task-repo.test.ts 顶部的 binding 自检 skip 守门；真要本地实测，收尾必须跑上面三行。

### 验证

```bash
unset ELECTRON_RUN_AS_NODE  # 必做：避免 Electron 二进制被切到 Node 伪装模式（详见上面规则清单）
"/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt "ping"
# 应用拉起 / 已运行实例新建一条会话；wrapper 自动补 cwd 与 new 子命令
```
