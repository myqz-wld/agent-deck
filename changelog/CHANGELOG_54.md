# CHANGELOG_54: 沙盒机制小步加固（A-1 + A-2 + B-4）

## 概要

REVIEW_14/15 落地后留了三块小账，本次还掉两条 + 补齐 REVIEW_14 提的「双 backend 沙盒对称」目标的 codex 那半边。原本 REVIEW_15 ❓3「默认 'off' → 'workspace-write'」也在候选清单内，用户决策**暂不切**（待更长观察期）。

A-1 + A-2 与 B-4 拆两个独立 commit；本次不引新单测文件，A-1/A-2 共用既有 `sandbox-config.test.ts`（22 case 仍全绿，断言扩了名单）。

## 变更内容

### A-1 + A-2：扩 Claude Code SDK 沙盒默认名单

#### `src/main/adapters/claude-code/sandbox-config.ts`

- `SANDBOX_EXCLUDED_COMMANDS` 在原 9 个（git/pnpm/npm/yarn/bun/pip/pip3/cargo/go）基础上扩 7 个 OS-level 容器/监视/构建工具：`docker / watchman / orb / lima / colima / make / xcodebuild`
- **明确不加** `node` / `npx`（agent 直接 spawn JS 等于通用 backdoor，npm/pnpm 已豁免间接调用路径仍有效）；**不加** `brew`（写 /usr/local 太宽）
- `buildSensitiveDenyReadPaths()` 在原凭据目录基础上扩 4 条：`~/.zsh_history` / `~/.bash_history` / `~/Library/Keychains` / `~/Library/Cookies`（macOS-only 路径在 Linux 不存在 SDK 会忽略）
- 顶部 JSDoc「阶段 3 候选」清单：划掉这两条；保留 `allowedDomains UI` + 「默认切换」候选

#### `src/main/adapters/claude-code/__tests__/sandbox-config.test.ts`

- `SANDBOX_EXCLUDED_COMMANDS` describe 块的 case：扩名单断言（含「不应包含 node/npx/brew」反向断言锁住设计决策）
- `'denyRead 包含敏感目录'` 两处 case（workspace-write + strict）：补 `~/.zsh_history` / `Library/Keychains` / `~/.bash_history` / `Library/Cookies` 断言（每档至少各加 2 条新断言）

### B-4：Codex 一路接 sandbox 三档

补齐 REVIEW_14「双 backend 沙盒对称」目标的另一半。Codex 此前硬编码 `sandboxMode: 'workspace-write'`，用户没法调档；现接通三档。

#### `src/shared/types/settings.ts`

- `AppSettings` 加 `codexSandbox: 'workspace-write' | 'read-only' | 'danger-full-access'`，JSDoc 详述三档语义（直接用 codex SDK 原生 `SandboxMode` union 字面量，不做映射避免命名混乱）
- `DEFAULT_SETTINGS.codexSandbox: 'workspace-write'`（保持历史硬编码值，零行为变更）

#### `src/main/ipc/_helpers.ts`

- 新增 `CODEX_SANDBOX_MODE_VALUES` 常量 + `CodexSandboxMode` 类型 + `parseCodexSandboxMode(value)` 校验函数（同 `parseSandboxMode` 模式：undefined/null → null；非白名单 → throw `IpcInputError`）

#### `src/main/ipc/settings.ts`

- import 加 `parseCodexSandboxMode`
- `SettingsSet` handler 在 `claudeCodeSandbox` 校验块下追加 `codexSandbox` 同形校验（null 兜底回 'workspace-write'）
- 新增 `applyCodexSandboxMode(p, next)` 函数（紧跟 `applyCodexCliPath`）
- 加进 `APPLY_FNS` 数组（在 `applyCodexCliPath` 之后，保证 path 优先于 sandboxMode 应用）

#### `src/main/adapters/types.ts`

- `AgentAdapter` 接口加可选方法 `setCodexSandboxMode?(mode): void`（与 `setCodexCliPath?` 同模式，仅 codex 实现）

#### `src/main/adapters/codex-cli/index.ts`

- `init` 钩子追加 `bridge.setCodexSandboxMode(settingsStore.get('codexSandbox'))`
- 加 `setCodexSandboxMode(mode)` public method 转发给 bridge
- 顶部 JSDoc 改写「默认安全策略」段：标明 sandboxMode 默认 workspace-write 但**可被 settings.codexSandbox 覆盖**

#### `src/main/adapters/codex-cli/sdk-bridge/index.ts`

- 类内加 private 字段 `currentSandboxMode`（默认 'workspace-write'）
- 加 `setCodexSandboxMode(mode)` setter（仅更新字段，**不清 codex 实例**——sandboxMode 在 startThread 调用时透传，不在 codex 实例上）
- `startThread` 选项把硬编码 `sandboxMode: 'workspace-write'` 改成 `sandboxMode: this.currentSandboxMode`

#### `src/renderer/components/SettingsDialog.tsx`

- 「实验功能」section 末尾、`claudeCodeSandbox` select 下面新增 `codexSandbox` 三档下拉框：`Workspace Write（默认）` / `Read Only` / `⚠ Danger Full Access`
- 一行 inline 文案说明语义；不复用 `claudeCodeSandbox` 的 amber 「⚠ 仅下次生效」hint 段（避免重复噪声，文案中已点出）

## 备注

- **A-3 暂不做**（用户决策）：把 `claudeCodeSandbox` 默认从 'off' 切到 'workspace-write' 仍是 REVIEW_15 ❓3 候选项，等更长观察期再切；本批次只扩名单
- **切档仅下次新建会话生效**（与 `claudeCodeSandbox` / `agentTeamsEnabled` / `enableTaskManager` 同模式 spawn-time 锁定）：sandboxMode 是 codex `startThread` 一次性参数，已在跑的 thread 不会被撤销
- **不需要 settings-store REMOVED_KEYS**：本次纯加字段，不删
- **不需要 migration**：settings 是 JSON 文件不是 SQLite
- **不动 `resources/claude-config/CLAUDE.md`**：与 codex 一路独立（CLAUDE.md 只注入到 Claude Code SDK system prompt）
- **关联**：REVIEW_14 「双 backend 沙盒对称」目标补齐 / REVIEW_15 ❓2（excludedCommands 扩名单）落地 / REVIEW_15 ❓3 仅 partial（A-3 未做）
