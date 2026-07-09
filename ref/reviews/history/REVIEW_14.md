---
review_id: 14
reviewed_at: 2026-04-30
expired: false
skipped_expired:
---

# REVIEW_14: Agent 会话沙盒接入可行性调研（Claude Code SDK 0.2.118 sandbox + hooks + managedSettings 能力盘点）

## 触发场景

用户主动调研：是否可以给 Agent Deck 拉起的 agent 子进程加沙盒（OS 级权限隔离）、怎么接、有什么好处。

诉求背景：

- Agent Deck 让用户在 UI 里跑 Claude Code SDK / Codex CLI 的 agent 任务，agent 跑在用户**真实代码仓库**里
- 当前 Claude Code 子进程**只有应用层 `canUseTool` 弹框决策**，无 OS 强制隔离 → agent 理论上能 `rm -rf`、改 `~/.ssh/*`、`curl` 偷数据
- Codex 子进程已硬编码 `sandboxMode: 'workspace-write'`（OS 级 Seatbelt 隔离）
- 两个 backend 隔离强度不对称，主入口反而最裸 → 探索能否补齐

> **本份是 feasibility study，不是某段代码的修复审查**。无具体文件覆盖范围，`review-scope` 留空（不参与未来过期判定）。后续如进入 spike / 接入实施，会另起一份 fix-style review 覆盖实际改动文件。

## 方法

**双异构 Agent 并行**（按全局 CLAUDE.md「决策对抗」节）：

- **Agent A（仓库内现状盘点）**：Claude Explore subagent（Opus 4.7 xhigh）
  - 范围：SDK / CLI 子进程启动栈、权限模型、cwd 防御、env 白名单、reviews/changelog 历史决策、sandbox 现状
  - 输出：file:line 引用为基的事实摘要 + 接入切入点
- **Agent B（外部方案盘点）**：Claude Explore subagent（Opus 4.7 xhigh + WebFetch / WebSearch）
  - 范围：Claude Agent SDK / Codex / macOS Seatbelt / 容器 / Electron utility process / 业界类似产品（Cursor / Continue / OpenHands）
  - 输出：每方案隔离强度 + 接入成本 + 体验影响 + 风险

**主 Agent 现场实证裁决**（CLAUDE.md「实践验证 > 空猜」纪律）：

两份输出在「SDK 是否支持 hooks / OS 级 sandbox」上严重冲突，必须现场验证：

1. 直接读 `node_modules/@anthropic-ai/claude-agent-sdk@0.2.118/sdk.d.ts`（5332 行）
2. grep `sandbox|Sandbox|SANDBOX` + `hooks|HookEvent|PreToolUse|PostToolUse|canUseTool`
3. 读 `sdk-bridge.ts:476-525` 当前 query options 实际传什么
4. 看 `resources/claude-config/` 应用打包注入了什么（settings.json / hooks）

```review-scope
```

## 三态裁决结果

> 本节遵循全局「决策对抗」节验证纪律：每条 ✅ 必须带验证手段，未验证 finding 强制降级 ❓ + 非 HIGH。

### ✅ 真问题（双方独立提出 / 一方提出且现场实证成立）

| # | 严重度 | 结论 | 验证手段 |
|---|---|---|---|
| 1 | HIGH | SDK 0.2.118 提供 OS 级 sandbox（filesystem + network），Agent Deck 100% 没用 | 读 sdk.d.ts:1562 `sandbox?: SandboxSettings` + 4656-4732 完整结构（`enabled / failIfUnavailable / autoAllowBashIfSandboxed / allowUnsandboxedCommands / network.{allowedDomains,deniedDomains,httpProxyPort,allowMachLookup} / filesystem.{allowWrite,denyWrite,denyRead,allowRead} / excludedCommands`）；grep sdk-bridge.ts:476-525 query options 无 sandbox 字段 |
| 2 | HIGH | SDK 0.2.118 提供完整 hooks API（PreToolUse / PostToolUse / Stop / FileChanged / SessionStart / ...），Agent Deck 100% 没用 | 读 sdk.d.ts:1279 `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>` + 718 `HookCallback` + 1890/1870 `PreToolUse/PostToolUse` + 738 `HookPermissionDecision = 'allow' \| 'deny' \| 'ask' \| 'defer'`；grep sdk-bridge.ts:476-525 仅 canUseTool 一个回调 |
| 3 | MED | SDK 提供 `managedSettings` 字段，专门为 desktop app 强制下发 user/project 不可放宽的 lockdown 配置 | 读 sdk.d.ts:1602「Intended for embedding applications (e.g. desktop apps) ... user/project settings cannot widen restrictions set here」+ example `managedSettings: { sandbox: { network: { allowManagedDomainsOnly: true } } }` |
| 4 | MED | Codex 子进程已默认 OS 级 `workspace-write` 隔离，Claude Code 反而最裸（不对称） | 读 codex-cli/sdk-bridge.ts:191-198 `sandboxMode: 'workspace-write', approvalPolicy: 'never'`（硬编码）vs claude-code/sdk-bridge.ts:476-525 无任何 OS 隔离 |
| 5 | LOW | 应用打包的 `resources/claude-config/` 不带 settings.json、不配 hook，所有 hook 来源 = 用户 `~/.claude/settings.json` | `find resources -name "settings*.json"` 空；`grep -r "hooks" resources/` 仅 deep-code-review skill 内的 codex `--sandbox read-only` 文档；sdk-bridge.ts:504 `settingSources: ['user', 'project', 'local']` |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| Agent A | 「SDK 不支持 PreToolUse / PostToolUse hook，仅 canUseTool」 | sdk.d.ts:1279 `hooks` 字段铁证存在；Agent A 只看了 sdk-bridge.ts 当前用法，没查 SDK 类型定义里**可用但未用**的能力 |
| Agent A | 「Claude Code 无 OS 级沙盒（vs Codex 的 sandboxMode）」 | sdk.d.ts:1562 `sandbox` 字段 + 4656-4732 完整 OS 级 Seatbelt/bubblewrap 配置铁证 |

### ❓ 部分 / 未验证

| # | 现场 | 验证状态 | 结论 |
|---|---|---|---|
| 1 | 内置 native binary 在打包 .app 中实际启 sandbox 是否成功（依赖 macOS Seatbelt 可用性 + bundled binary 版本对 sandbox 字段的真实支持） | ❓ 未实证 | 类型存在不等于运行时可用，**必须 spike 才能定论**；强制降级为非 HIGH 风险项 |
| 2 | Agent B 给的若干外部 URL（docs.anthropic.com 沙盒文档 / cursor.com agent-sandboxing / cncf.io Lima v2.1 / Anthropic 工程博客等） | ❓ 未逐个核 | 核心结论已被 sdk.d.ts 类型铁证支持，外部 URL 真伪不影响主判断；不作为决策依据 |
| 3 | sandbox 与现有 canUseTool 决策流叠加是否有「应用层 allow 但 OS 拦」不直观行为 | ❓ 未实证 | 需 spike 阶段构造真实 agent 任务测 |
| 4 | 用户 `~/.claude/settings.json` 已配的 hook / sandbox 与 Agent Deck `managedSettings` 合并优先级（managedSettings 是 policy 层应高于 user，但需验证用户已有 hook 是否仍按预期触发） | ❓ 未实证 | 需 spike 阶段构造混合配置测 |

## 关键发现汇总

### SDK 沙盒能力地图（sdk.d.ts 实证）

| 能力 | 字段 | 类型定义位置 |
|---|---|---|
| OS 级文件系统隔离 | `sandbox.filesystem.{allowWrite,denyWrite,denyRead,allowRead,allowManagedReadPathsOnly}` | sdk.d.ts:4693-4714 |
| OS 级网络隔离 | `sandbox.network.{allowedDomains,deniedDomains,allowManagedDomainsOnly,allowUnixSockets,allowMachLookup,httpProxyPort,socksProxyPort}` | sdk.d.ts:4667-4692 |
| 沙盒内 Bash 免审 | `sandbox.autoAllowBashIfSandboxed` | sdk.d.ts:4662 |
| 不兼容沙盒命令白名单 | `sandbox.excludedCommands` | sdk.d.ts:4723 |
| 启动时硬性检查（无沙盒就退出） | `sandbox.failIfUnavailable`（默认 true） | sdk.d.ts:4659 |
| 控制能否用 dangerouslyDisableSandbox 逃逸 | `sandbox.allowUnsandboxedCommands` | sdk.d.ts:4666 |
| 完整 hooks 体系 | `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>` | sdk.d.ts:1279 |
| Hook 决策能力 | `HookPermissionDecision = 'allow' \| 'deny' \| 'ask' \| 'defer'` | sdk.d.ts:738 |
| 桌面应用强制配置 | `managedSettings: Settings` | sdk.d.ts:1602 |

**关键语义**（sdk.d.ts:1527）：「Filesystem and network restrictions are configured via permission rules, not via these sandbox settings」—— 实际访问限制走 permission rules（`Read/Edit/WebFetch` 的 allow/deny），sandbox 设置是**用 OS 级隔离强制执行**那些 deny 规则。两层互补，缺一不可。

### 接入沙盒的好处

1. **Claude Code / Codex 隔离对称**：消除「主入口反而最裸」的不一致
2. **`acceptEdits` / `bypassPermissions` 体验上升**：用户敢用更激进的权限模式 —— OS 强制兜底
3. **`autoAllowBashIfSandboxed` 减少权限弹框**：沙盒内 Bash 免审 → 正向 UX 收益
4. **网络白名单防数据外泄**：`sandbox.network.allowedDomains` 可挡 agent 偷 `curl` 到 paste.bin / Discord webhook
5. **保护用户敏感目录**：`sandbox.filesystem.denyRead` 可挡 agent 读 `~/.ssh`、`~/.aws`、`~/Downloads`
6. **`managedSettings` 让 audit 链清晰**：应用层硬约束 user/project 不能放宽
7. **复用 SDK 既有能力，零新依赖**：不引入 Docker / Lima / 自写 .sb profile 复杂度

### 接入沙盒的坏处与风险

1. **`failIfUnavailable` 默认 true**（sdk.d.ts:4659）：依赖 macOS Seatbelt（Apple 标记 undocumented）/ Linux bubblewrap，未支持平台直接报错退出 query → 需要 graceful degradation
2. **某些工具不兼容沙盒**：`docker` / `watchman` / 部分 native build 工具会挂，需要 `excludedCommands` 名单
3. **与 `canUseTool` 决策流交互未测**（❓3）
4. **用户 `~/.claude/settings.json` 配置合并优先级未测**（❓4）
5. **打包后 native binary 启 sandbox 可能挂**（❓1，核心未验证项）
6. **用户工作流可能受影响**：`pnpm install`（写 node_modules + 联网拉包）、`git push`（走 SSH）行为可能变 → 网络白名单需调试
7. **重启 dev / 重新打包成本**：改 main 进程 spawn 逻辑必须按 CLAUDE.md「打包与本地安装」节走完整 7 步重装

## 候选方案对比（按推荐度排序）

### A. SDK 内置 sandbox + managedSettings 渐进试点（推荐 ⭐⭐⭐）

- 做法：sdk-bridge.ts:476 query options 拼 `sandbox` + `managedSettings`，加 setting `claudeCodeSandbox: 'off' | 'workspace-write' | 'strict'`，**默认 off**，用户主动开
- 隔离强度：中强（OS 级 Seatbelt）
- 接入成本：低（SDK 原生，无新依赖；2-3 天 spike + 1-2 周打磨）
- 体验：开了沙盒后大部分场景无感；问题工具走 `excludedCommands`
- 风险：核心未验证项是「打包后能否启起来」—— spike 一次就有定论

### B. 直接默认开 `workspace-write`（与 Codex 对齐）

- 隔离强度：中强；接入成本：低
- 风险：**不推荐先做这个** —— 老用户已有工作流（pnpm install / orb / docker / watchman）可能挂，没有用户开关意味着出问题只能回滚整个版本。先做 A，spike 通过 + 至少一周用户反馈无问题再切默认

### C. 仅在应用层加 hook 强化决策（不开 OS 沙盒）

- 隔离强度：弱（应用层；agent 用 `eval` 或间接调用可绕）；接入成本：低
- 价值：作为 A 的补充层很合理，但单独用太弱 —— 不建议作为主方案

### D. 容器 / VM 隔离（Docker sandbox / Lima / OrbStack）

- 隔离强度：强；接入成本：高
- 文件性能 / credentials 卷挂载 / OrbStack 不支持 docker sandbox 等痛点
- **不推荐**：开销和复杂度远超收益。等 A 跑稳了用户还提诉求再考虑

### E. 自写 macOS sandbox-exec `.sb` profile

- 隔离强度：中；接入成本：中（SBPL 文档少）
- **不推荐**：SDK 已经做了同一件事且对接更紧

## 推荐路径

**方案 A，三阶段**：

1. **Spike（1-2 天，必跑）**：sdk-bridge.ts 临时硬编码 `sandbox: { enabled: true, autoAllowBashIfSandboxed: true }`，dev 模式 + 打包 .app 各跑一遍真实 agent 任务（让 agent 改本仓库一个文件 + `git status` + `pnpm typecheck`），验证：
   - SDK 不报 sandbox unavailable
   - 工具调用不被 OS 误拦
   - `autoAllowBashIfSandboxed` 真的减少弹框
2. **正式接入（3-5 天）**：spike 通过后加 settings 开关 + UI + `managedSettings` 包装 + `excludedCommands` 名单，默认 off 上线
3. **逐步默认 on**（视用户反馈，1-2 周后）：观察一周，若无异常报告且 Codex 历史无沙盒坑，可考虑默认 `workspace-write`，与 Codex 对齐

如果 spike 失败（内置 binary 不支持 / Seatbelt 报错 / native 工具大面积挂）：降级到 C（应用层 hook），写新 review 记录原因，等 SDK 更新再回来试。

## 修复（review 内不直接落地，本次为 feasibility study 不动代码）

### HIGH

无修复条目。本调研产出 = 推荐路径 + 接入文件清单（见下），**实际接入由后续 spike + CHANGELOG 落地**。

### 接入时改这些文件

| 文件 | 改动 |
|---|---|
| `src/main/adapters/claude-code/sdk-bridge.ts:476-525` | query options 拼 `sandbox` + `managedSettings` |
| `src/main/adapters/claude-code/sdk-runtime.ts:40-57` | 可选：`getSdkRuntimeOptions()` 扩展返回 sandbox 配置 |
| `src/main/settings-store.ts` | 加字段 `claudeCodeSandbox`（默认 'off'）+ 加入 `REMOVED_KEYS` 兜底 |
| `src/main/ipc.ts` `SettingsSet` handler | 新设置即改即生效（CLAUDE.md「主进程模块通信」节明确要求） |
| `src/shared/types.ts` | 新增 `ClaudeSandboxMode` 类型；不准 import Electron/Node |
| `src/preload/index.ts` | `window.api` facade 暴露新设置 |
| `src/renderer/.../SettingsDialog.tsx` | UI 新增下拉框 + 风险说明 |
| `resources/claude-config/CLAUDE.md` | 加一段说明「Agent Deck 已强制启用 sandbox X 模式」让会话内 agent 知道边界 |

**已存在的复用资产**（接入时直接 reuse，别重写）：

- `src/main/settings-env.ts:27-36` env 白名单 —— 类似的「白名单合并 + 优先级」模式可复用到 sandbox 域名白名单
- `src/main/session/manager.ts:14-22` `normalizeCwd` —— sandbox 路径必须先走 realpath
- Codex 那边 `sandboxMode: 'workspace-write'` 的运行时表现 —— 直接借鉴默认配置 + excludedCommands
- `src/main/settings-store.ts` `REMOVED_KEYS` 机制 —— 后续重命名 / 弃用字段时按此处理

## 关联 changelog

无（本次 feasibility study 不引入功能变更，无 CHANGELOG）。后续 spike + 接入完成时另起一份 `CHANGELOG_X.md` 记录功能变更，并新建 fix-style review 记录接入过程发现的问题。

## Agent 踩坑沉淀（如有）

候选 1 条 → `.claude/conventions-tally.md`「Agent 踩坑候选」section：

- **「调研 SDK 能力时只看应用当前用法、不查 d.ts → 错判 SDK 不支持某能力」**：Agent A 因只读 sdk-bridge.ts 当前 query options，错判「SDK 仅支持 canUseTool，无 hooks / 无 OS sandbox」；本次调研主 agent 现场读 sdk.d.ts 拿 hooks / sandbox 字段铁证反驳。后续调研 SDK / 第三方库能力时**强制要求查 d.ts 类型定义**，不能仅凭仓库当前调用面下结论。
