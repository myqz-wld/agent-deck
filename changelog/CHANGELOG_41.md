# CHANGELOG_41: Sandbox 三档接入正式上线 + Settings Section 折叠 + 双弹框 UX 自动收口

## 概要

REVIEW_14 spike 阶段 1 通过后正式落地 Claude Code SDK 0.2.118 内置 OS 级 sandbox（macOS Seatbelt / Linux bubblewrap），新增 `settings.claudeCodeSandbox` 三档（`'off'` / `'workspace-write'` / `'strict'`），默认 `'off'` 用户主动开。Codex 子进程已默认 `workspace-write`，本设置补齐 Claude 一侧的隔离对称性（消除「主入口反而最裸」的不一致）。

应用层在 `canUseTool` 顶部加 `SandboxNetworkAccess` 自动 deny + 结构化 message 分支，让 model **100% 按指引** fallback 走 `dangerouslyDisableSandbox` 重试（不是概率性 reasoning），用户视角仅 1 次弹框（绕沙盒那次需用户审批是合理的）。实测 SDK 沙盒网络拦截是双层并行：`SandboxNetworkAccess` 工具回路（应用层 ask）+ 本地 HTTP CONNECT proxy 注入（OS 级 actually block，curl 拿 `403 + X-Proxy-Error: blocked-by-allowlist`），两层互补。

顺手做的 UX 改进：SettingsDialog 11 个 section 整体折叠化（localStorage 持久化 + 默认仅「Claude Code Hook」展开），缓解新加 sandbox 设置后内容过长压力。

详细背景见 `reviews/REVIEW_14.md`（feasibility study）+ `reviews/REVIEW_15.md`（实施过程多轮实测纠错）。

## 变更内容

### 共享类型 (`src/shared/types.ts`)

- `AppSettings` 加 `claudeCodeSandbox: 'off' | 'workspace-write' | 'strict'`，附 JSDoc 详述三档语义 + 「仅下次新建会话生效」+ 「summarizer 不被污染」（与 `agentTeamsEnabled` 同隔离模式）
- `DEFAULT_SETTINGS.claudeCodeSandbox = 'off'`

### 沙盒配置 (`src/main/adapters/claude-code/sandbox-config.ts` 新文件)

- 导出 `SandboxMode` / `SANDBOX_MODE_VALUES` / `SANDBOX_EXCLUDED_COMMANDS` 常量
- 导出 `buildSensitiveDenyReadPaths()`：默认拦读 `~/.ssh / ~/.aws / ~/.config / ~/.kube / ~/.gnupg / ~/.docker / ~/.npmrc / ~/.netrc / ~/.pypirc`
- 导出 `buildSandboxOptions(mode, cwd)`：把 settings 档位转成 SDK `query.options.sandbox` 顶层字段（plan 阶段尝试过 `managedSettings.sandbox` 包装路径被实测证伪——sandbox 没启 + curl 走 proxy 403——回滚到顶层字段）
- 三档语义：
  - `off`：返回 `{}`（不传 sandbox 字段，行为同现状）
  - `workspace-write`：`enabled + autoAllowBashIfSandboxed + allowUnsandboxedCommands: true`（保留 model 逃逸路径）+ excludedCommands 名单（git/pnpm/npm/yarn/bun/pip/cargo/go）+ filesystem.allowWrite（cwd + /tmp + ~/.cache/claude-code）+ filesystem.denyRead（敏感目录）
  - `strict`：`failIfUnavailable: true + allowUnsandboxedCommands: false`（封死逃逸）+ 不给 allowWrite（cwd 也只读）+ 同 denyRead
- 未知 mode 字符串静默兜底回 `'off'` + `console.warn`（防御性，settings store 入了脏数据时）
- **不传 `network` 子对象**：实测 SDK 默认走 SandboxNetworkAccess 工具回路（向 canUseTool 申请 host 授权）+ 本地 HTTP CONNECT proxy 双层并行；阶段 3 加 `network.allowedDomains` UI 可让 proxy 直接放行常用域名

### IPC (`src/main/ipc.ts`)

- 加 `parseSandboxMode(value)` helper（参考 `parsePermissionMode` 模式：白名单校验 + null/非法 throw IpcInputError），引用 `sandbox-config.ts` 的 `SANDBOX_MODE_VALUES` 单点真值
- `SettingsSet` handler 入口对 `claudeCodeSandbox` 字段做白名单校验（防 renderer 传非法字符串静默存入 store 后 sdk-bridge 时拿到「不属于三档」的值）；不需要 apply 函数（spawn-time 生效，无运行时副作用）

### Adapter (`src/main/adapters/claude-code/sdk-bridge.ts`)

- 删 spike 阶段 env gate（`process.env.AGENT_DECK_SANDBOX_SPIKE === '1'` 那 8 行 hack）
- createSession query options 装配中调 `buildSandboxOptions(settingsStore.get('claudeCodeSandbox') ?? 'off', opts.cwd)` + 一行 `[sandbox] mode=X → enabled (top-level) / disabled (no field)` log（每次会话启动可见性高、噪声低）
- `canUseTool` 顶部（READ_ONLY_TOOLS 之后、AskUserQuestion 之前）加 `SandboxNetworkAccess` 自动 deny + 结构化 message 分支：「网络访问被沙盒拦截（host: X）。如确实需要联网，请用 Bash + dangerouslyDisableSandbox: true 参数重试（会触发用户审批）。如档位为 strict 则逃逸已被禁用」+ 一行 `[sandbox-canusetool] SandboxNetworkAccess intercept host=X → auto-deny + fallback hint` log（实测每次 host 拦截一行，问题排查一目了然）

### 控件 (`src/renderer/components/settings/controls.tsx`)

- `Section` 组件加 `defaultOpen` + `storageKey` 两个可选 props 实现折叠：
  - 标题区域改成可点击 button + ▶/▼ 旋转动画图标
  - `storageKey` 走 `localStorage` 命名空间 `agent-deck:settings:section:<key>` 持久化用户折叠/展开偏好
  - 用户没主动改过时 → 走 `defaultOpen`（默认 `true`，向后兼容）

### Settings UI (`src/renderer/components/SettingsDialog.tsx`)

- 11 个 section 全部加 `storageKey`，仅「Claude Code Hook」`defaultOpen={true}`（最常用，状态可见性最高），其他 10 个默认折叠（用户主动展开后下次记住）
- 「实验功能」section 内（agentTeamsEnabled toggle 后）加 sandbox 三档 select 下拉框 + 详细文案（说明三档隔离强度差异 / 敏感目录黑名单 / 常用工具豁免名单 / 「仅下次新建会话生效」hint 用 amber 色高亮 + 同步给 agentTeamsEnabled 也加同色 hint）

### 应用注入 system prompt (`resources/claude-config/CLAUDE.md`)

- 加「沙盒模式（OS 级隔离，可能存在）」小节告诉会话内 model：哪些命令会被 OS 拦（写敏感目录 / 任意网络访问）+ strict 档下行为差异 + 看到 Permission denied / Operation not permitted 时的处理姿势 + 与 permissionMode 正交的关系
- 写死「机制说明」让 model 知边界，不按档位动态生成（model 看到无关说明也不会有副作用）

### 单测 (`src/main/adapters/claude-code/__tests__/sandbox-config.test.ts` 新文件)

- 22 cases 覆盖：`SANDBOX_MODE_VALUES` 枚举锁 / `SANDBOX_EXCLUDED_COMMANDS` 包含常见开发工具 / `off` 返回空对象 / `workspace-write` 三档每个字段 / `strict` 三档每个字段 / 不传 `network` 子对象的回归挡板（防止再退回 `network: {}` 写法）/ 未知 mode 触发 `console.warn` + 返回空对象 / `'off'` 与 `undefined` 不触发 warn
- 5 个 test files / 68 cases 全绿（其他 4 个 file 是已有 vitest，新加 sandbox-config 测试无破坏）

## 备注

- **spike 阶段 env gate `AGENT_DECK_SANDBOX_SPIKE` 已彻底删除**：实测真相确证后无需保留（git diff 可看历史）
- **summarizer 不被污染**：summarizer 走 `settingSources: []` + 自己 `query()` 调用，不读 sandbox 设置（与 `agentTeamsEnabled` 隔离同模式，sdk-bridge.ts:538-549 已注释说明）
- **Codex 子进程不动**：codex-cli 已硬编码 `sandboxMode: 'workspace-write'`，本次仅补齐 Claude Code 一侧
- **打包验证通过**：按 CLAUDE.md「打包与本地安装」7 步走完整流程后，UI workspace-write 仅 1 次弹框（dangerouslyDisableSandbox 那次给用户审批），跟 dev mode 完全一致
- **关联**：REVIEW_14（feasibility study）→ REVIEW_15（实施 + 多轮实测纠错）→ CHANGELOG_41（本变更）
- **阶段 3 候选**（REVIEW_14 推荐路径未做项，按用户反馈推进）：
  1. excludedCommands 名单按用户场景追加（docker / watchman / orb / lima 类）
  2. 加 `network.allowedDomains` UI 让用户自定义网络白名单（github.com / api.anthropic.com / npm registry / pypi 等），减少 SandboxNetworkAccess 触发频率
  3. 默认从 `'off'` 切到 `'workspace-write'`（与 Codex 对齐，需 1-2 周用户反馈无异常后做）
  4. SessionCard 加「sandbox 档位 chip」（要加 v007 migration 存「会话启动时档位」，等出现「不同会话不同档位」需求才做）
