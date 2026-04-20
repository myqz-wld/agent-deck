# CLAUDE.md

> 给 Claude Code 在本仓库工作时的硬性约定。

## 通用约定

- 始终用中文回复
- 不要主动创建 `.md` 文件，除非用户明确要求
- macOS 环境，包管理器用 pnpm
- Node.js 由 nvm 管理；项目要求 Node ≥ 18

## 改动后必做

### 1. 判断是否要更新 README.md

**README.md 是这个项目的「功能总览」**，列出所有用户可见的能力（半透明窗、列表、状态机、SDK 通道、hook 通道、权限请求、SessionDetail、间歇总结、Diff 架构、Adapter 架构、持久化、设置面板、快捷键……）。

每次完成功能改动后，问自己 3 个问题：

1. **新增/修改了用户可见行为吗？**（UI 控件、设置项、快捷键、状态显示、提醒方式）
  - 是 → 更新 README.md 对应章节
2. **改动了文件结构 / 新建了模块吗？**
  - 是 → 更新 README.md 「项目结构」节
3. **改动了启动方式 / 端口 / 依赖 / 验证步骤吗？**
  - 是 → 更新 README.md 「开发与运行」节

纯 bug 修复 / 内部重构（不改用户感知）→ 不动 README.md，只写 changelog。

### 2. 写 changelog（**必做**）

`changelog/` 文件夹存所有变更记录。规则：

- 文件名格式：`CHANGELOG_X.md`，X 是从 1 开始的递增整数。新建之前先 `ls changelog/` 找最大 X
- **小改动**（一两个文件、几十行）→ 追加到最新一条 `CHANGELOG_X.md`
- **大改动**（多模块、上百行、新功能）→ 新建 `CHANGELOG_X+1.md`
- **每次改 changelog/ 都要同步更新 `changelog/INDEX.md`**（表格形式：`[CHANGELOG_X.md](CHANGELOG_X.md) | 概要`）

每条 CHANGELOG_X.md 的结构：

```markdown
# CHANGELOG_X: <一句话标题>

## 概要

<2-3 行说明这次改了什么、为什么>

## 变更内容

### <模块/层 1>（路径）
- <要点 1>
- <要点 2>

### <模块/层 2>（路径）
- ...
```

INDEX.md 的「概要」列要简短（一行），让人扫一眼就能定位历史改动。

### 3. 改功能前先读 changelog

修改任何模块前，**先 `ls changelog/` + 浏览最近几条相关的 CHANGELOG**，了解历史决策、避免推翻已有约定 / 重复踩坑。设计取舍（比如「为什么 lifecycle 和 archived 是正交的」「为什么 settingSources 不是用户配置项」）通常能在 changelog 里找到。

---

## 项目特定约定（设计要点速查）

这些是反复出现过的设计决定，改动前注意：

### 鉴权

- 应用**不读不写**任何 API Key。所有 SDK 调用（应用内会话 + 间歇总结）走本地 `~/.claude/.credentials.json`（OAuth）
- 间歇总结的 SDK oneshot 设 `settingSources: []`，避免 hook 回环到自己
- 应用内会话的 SDK 设 `settingSources: ['user', 'project', 'local']`，等价于在该 cwd 跑 `claude`

### 事件去重

- `AgentEvent.source = 'sdk' | 'hook'`
- SDK 通道接管的 sessionId 加入 `SessionManager.sdkOwned`，hook 通道同 id 事件被丢弃
- 翻译时 hook-routes.ts 用 `taggedEmit` 统一打 `source: 'hook'`，SDK bridge emit 时打 `source: 'sdk'`

### 生命周期与归档

- `lifecycle: 'active' | 'dormant' | 'closed'` 和 `archived_at: number | null` **正交**
- 归档 = 仅打 `archived_at` 标记，不动 lifecycle
- 取消归档 = 清 `archived_at`，会话回到原 lifecycle（不是粗暴重置成 dormant）
- LifecycleScheduler 跳过 `archived_at IS NOT NULL` 的会话，归档不参与时间衰减

### 总结调度（summarizer）

- 三层降级：LLM oneshot → 最近一条 assistant 文字 → 事件 kind 统计
- `eventsSince === 0` 时跳过（不要反复跑出一模一样的总结）
- 全局 `summaryMaxConcurrent` 上限（默认 2），超出退出本轮等下次扫描；`inFlight` 单独保证同会话不并发

### 主进程模块通信

- 模块单例通过 `setX` / `getX` 暴露（如 `getLifecycleScheduler()`），不要在 ipc.ts 里直接 import 实例对象（会循环依赖 / 时序问题）
- 跨进程事件统一走 `event-bus.ts`，不要直接调 `webContents.send`

### 设置变更的运行时同步

- `ipc.ts` 的 `SettingsSet` handler 是「即改即生效」的中转点：检查 patch 包含哪些字段，分别调对应模块的 update 方法（scheduler / window / login item ...）
- 加新设置项后，记得在这里加分发逻辑，否则会出现「设置面板能改但实际不生效」

### renderer 与 main 的边界

- `shared/types.ts` 只允许标准库类型，不准 import Electron / Node API
- preload 里 `window.api` 是强类型 facade；动态 channel 用 `window.electronIpc.invoke()` 兜底
- HMR 只动 renderer；改 main 必须重启 dev

### 弃用字段清理

- `settings-store.ts` 的 `REMOVED_KEYS` 数组：删字段后把名字加进来，每次启动会自动 `delete` 掉历史持久化里的孤儿字段

### 毛玻璃 CSS 陷阱

- `.frosted-frame > *:not(.absolute):not(.fixed)` 强加 `position: relative` —— 不要去掉这条，但要排除 absolute/fixed，否则 dialog 会被拍回文档流被裁掉

---

## 反复反馈 → 升级约定（自维护机制）

为了避免用户重复给同样的反馈，引入轻量计数：候选放在 [.claude/conventions-tally.md](.claude/conventions-tally.md)，count ≥ 3 后升级到本文件。

**触发条件**（满足才计数，避免污染）：

- 用户给出「纠正性 / 偏好性」反馈，典型信号：「不要…」「应该…」「我已经说过…」「以后…」「记住…」「每次…」
- 内容是**工程偏好 / 设计取舍 / 工作流偏好**，不是一次性的"帮我改这个 bug"

**操作流程**（每次接到符合条件的反馈时）：

1. 读 `.claude/conventions-tally.md`，找语义相近的已有条目
  - 找到 → `count` +1，更新 `last_at` 为今天
  - 没找到 → 新增条目，`count: 1`
2. **count 到 3** → 主动提议："这条偏好累计 3 次了，建议升级到 CLAUDE.md 项目约定，要做吗？" 用户确认后：
  - 把条目改写成正式约定，写入本文件「项目特定约定」最贴合的小节
  - 从 tally 删除该条目
3. count < 3 → 静默更新 tally，不打扰用户

> 不要手工管理 tally —— 它是 Claude Code 的内部状态。如果某条很久没再触发，下次扫描可以主动清理（>30 天未更新且 count < 3）。

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

每次想体验"装好的版本"或者验证 wrapper 能不能从 .app 找到 → 完整跑一遍：

```bash
# 1. 出 dmg + .app（约 1 分钟）
rm -rf release && pnpm dist

# 2. 覆盖安装到 /Applications（已有同名 .app 时必须先 rm，cp -R 不会清残留）
rm -rf "/Applications/Agent Deck.app"
cp -R "release/mac-arm64/Agent Deck.app" /Applications/

# 3. ad-hoc 重签名：给整个 .app 一个 stable 签名 identifier (com.agentdeck.app)。
#    不签 → codesign Identifier 是 'Electron'（来自 Electron 二进制 linker 签名），
#    与 Info.plist 的 CFBundleIdentifier 不一致，macOS 通知中心 / Gatekeeper 部分场景
#    会按 'Electron' 这个 identifier 注册而不是 'com.agentdeck.app'，导致通知 / 权限
#    设置错位。`-` 表示 ad-hoc 无证书自签。
codesign --force --deep --sign - "/Applications/Agent Deck.app"

# 4. 清掉 quarantine 属性，否则未签名 .app 首次开会被 Gatekeeper 拦
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 5. 软链 wrapper 到 PATH（一次性）
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck
```

### 打包配置已踩的坑（别再回退）

写 `package.json` 的 `build` 字段时注意：

- **`mac.icon: "resources/icon.png"` 必须有**。`directories.buildResources: "resources"` 让 electron-builder 默认查 `resources/icons/` 下多分辨率 png 集；我们只有单文件 `resources/icon.png`，不指定就报 `icon directory ... doesn't contain icons`，dmg 打不出来
- **`extraResources` 必须把 `resources/bin` 显式 copy 到 `bin`**。`buildResources` 目录本身不会被打进 .app，wrapper 需要靠这个段落才能出现在 `Agent Deck.app/Contents/Resources/bin/agent-deck`
- 没配 `Developer ID Application` 证书 → electron-builder 跳过签名，正常；但首次开 .app 必须 `xattr -dr com.apple.quarantine` 才能跑
- **ad-hoc 重签必须做（dist 后第 3 步）**：electron-builder 跳过签名后，`codesign -dvv` 看到的 Identifier 是 `Electron`（Electron 二进制 linker 阶段就 ad-hoc 签了，identifier 是 'Electron'），与 Info.plist 里 `com.agentdeck.app` 不一致。macOS 通知中心 / Gatekeeper / 部分系统服务 会按 codesign Identifier 注册，不重签会导致通知归在「Electron」名下而不是「Agent Deck」。`codesign --force --deep --sign - .app` 用 ad-hoc identity 重签整个 bundle，把 Identifier 拉回 `com.agentdeck.app`

### 验证

```bash
"/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt "ping"
# 应用拉起 / 已运行实例新建一条会话；wrapper 自动补 cwd 与 new 子命令
```