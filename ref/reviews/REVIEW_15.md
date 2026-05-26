---
review_id: 15
reviewed_at: 2026-04-30
expired: false
skipped_expired:
---

# REVIEW_15: Sandbox 三档实施 + 多轮实测纠错（plan 阶段多个假设被实测证伪）

## 触发场景

REVIEW_14 spike 阶段 1 通过后正式接入 sandbox 三档（settings + UI + canUseTool 收口）。**实施过程多次撞「凭直觉假设 → 实测证伪 → 推翻重写」循环**，反映出沙盒系统这种「双层并行 + 工具回路 + 环境变量注入」的复杂机制纯靠局部观察推断容易误判，必须加 log + 实测才能下结论（与 P20 互补，新候选已沉淀 tally）。

本份不属于纯 fix-style review，是「实施 + 实测 + 推翻假设 + 重写注释」的复合记录。中途多次出现「先写 plan 假设、跑代码、实测发现错、回滚、改注释、再实测」的循环，所有假设和证伪过程在三态裁决里诚实记录。

## 方法

**非双对抗**——实施性质 + spike 阶段已对抗过一轮（REVIEW_14）+ 涉及实测 SDK 行为多次需要快速 round-trip。验证手段以「主 agent 加 log + dev 跑真实 prompt + 用户截图 / log 对照 + sdk.d.ts grep」为主。

**关键证据来源**：
- `[sandbox] mode=X → enabled (top-level)` log（确证 sandbox 顶层字段传给 SDK 了）
- `[canusetool] tool=SandboxNetworkAccess input.dangerouslyDisableSandbox=undefined` 临时 log（确证 SDK 真的在调这个工具）
- `[sandbox-canusetool] SandboxNetworkAccess intercept host=example.com → auto-deny + fallback hint` 永久 log（实测每次 host 拦截一行）
- 用户给的 proxy 错误头 `403 Forbidden + X-Proxy-Error: blocked-by-allowlist`（铁证 SDK 同时启了本地 HTTP CONNECT proxy）
- 用户 settings store `claudeCodeSandbox: "workspace-write"` 实际持久化值（证明 settings 链路通）
- spike 阶段用户截图的 SandboxNetworkAccess 弹框（与本次 [sandbox-canusetool] log 形成时间线对照）

**范围**：6 个改的文件 + 1 个新文件（不含 11 个 sandbox 无关 modified 是 Agent Teams M1+/M2+/M3 那条线的）

```text
src/shared/types.ts              # AppSettings + DEFAULT_SETTINGS 加 claudeCodeSandbox
src/main/ipc.ts                  # parseSandboxMode + SettingsSet 入口校验
src/main/adapters/claude-code/sandbox-config.ts             # 新文件：buildSandboxOptions
src/main/adapters/claude-code/sdk-bridge.ts                 # 删 spike env + 接 buildSandboxOptions + canUseTool 加分支
src/renderer/components/settings/controls.tsx               # Section collapsible + localStorage
src/renderer/components/SettingsDialog.tsx                  # 11 个 section storageKey + sandbox 下拉框 + hint
resources/claude-config/CLAUDE.md                           # 加沙盒模式说明段
src/main/adapters/claude-code/__tests__/sandbox-config.test.ts  # 新文件：22 cases
```

```review-scope
resources/claude-config/CLAUDE.md
src/main/adapters/claude-code/__tests__/sandbox-config.test.ts
src/main/adapters/claude-code/sandbox-config.ts
src/main/adapters/claude-code/sdk-bridge.ts
src/main/ipc.ts
src/renderer/components/SettingsDialog.tsx
src/renderer/components/settings/controls.tsx
src/shared/types.ts
```

> 本份 review 首次加入 git 的 commit 视为这批文件的覆盖基线。File-level Review Expiry 自动按基线计算 churn / commit / 时间。

## 三态裁决结果

> 本节遵循全局「决策对抗」节的「实践验证 > 空猜」纪律：每条 ✅ 必须带验证手段。本次特殊在于：实施过程多次出现「先假设后证伪」，所有假设演化都诚实记入 ❌ 反驳里。

### ✅ 真问题（实测 + log 实证）

| # | 严重度 | 现场 | 验证手段 |
|---|---|---|---|
| 1 | HIGH | SDK 沙盒网络拦截走双层并行：(a) `SandboxNetworkAccess` 内置工具回路（向 canUseTool 申请 host 授权）+ (b) 本地 HTTP CONNECT proxy 注入（`https_proxy` env + 按 allowlist 实际拦截，curl 拿 `403 + X-Proxy-Error: blocked-by-allowlist`） | dev `[canusetool]` log 实证 SDK 真调 `SandboxNetworkAccess` 工具 + 用户给 proxy 头 `X-Proxy-Error: blocked-by-allowlist` 实证本地代理存在；两层互补不是二选一 |
| 2 | HIGH | canUseTool 顶部 `SandboxNetworkAccess` 自动 deny + 结构化 message 分支稳定生效（**不是死代码**），让 model 100% 按指引 fallback `dangerouslyDisableSandbox`（不是概率性 reasoning） | `[sandbox-canusetool] intercept host=example.com → auto-deny + fallback hint` log 每次会话跑 curl 都触发；model reasoning 链显示「沙箱里 curl 没输出，按规则用 dangerouslyDisableSandbox 重试」直接引用我们的 message 措辞 |
| 3 | HIGH | `dangerouslyDisableSandbox: true` 让 SDK 不走 proxy 直接执行命令（沙盒外）→ curl 真能拿到 example.com HTML | dev + 打包 .app 双跑实证 + 用户截图第三次 Bash 调用拿到 HTML body |
| 4 | MED | settings 链路完整通：用户在 SettingsDialog 切档 → IPC `SettingsSet` 校验 + 持久化 → settings store JSON 写入 → sdk-bridge `settingsStore.get('claudeCodeSandbox')` 读到正确值 → buildSandboxOptions 装配 sandbox 字段 | 用户 settings JSON `claudeCodeSandbox: "workspace-write"` 实测 + `[sandbox] mode=workspace-write → enabled (top-level)` log 实证全链路 |
| 5 | MED | UX 收口：用户视角仅 1 次弹框（绕沙盒那次给用户审批），SandboxNetworkAccess 那次被自动 deny 不弹给用户 | 用户在 dev + 打包后 .app 双场景实测确认「没问题」 |
| 6 | LOW | Section 折叠交互正常 + localStorage 持久化跨会话生效 + 默认仅「Claude Code Hook」展开（最常用，状态可见性高） | 用户实测确认「没问题」 |
| 7 | LOW | sandbox-config 22 cases vitest 全绿 + 全套 5 test files / 68 cases 无破坏 | `pnpm test` 输出 |

### ❌ 反驳（plan 阶段 / 调查阶段假设被实测证伪）

| # | 报项 | 反驳依据 |
|---|---|---|
| 1 | plan 阶段假设「`managedSettings.sandbox` 装载整套 sandbox 给 desktop app 强约束」（基于 sdk.d.ts:1602 `managedSettings` 字段 jsdoc 推断） | 用户 settings store `claudeCodeSandbox: "workspace-write"` 写对了，但 sandbox 没启 + curl 走 proxy 拿 403 → 真相：`managedSettings` 仅承载 policy-only 字段（如 `allowManagedDomainsOnly`），不会被 SDK 翻译为整套 sandbox 装载配置；改回 `query.options.sandbox` 顶层字段后 sandbox 真启 |
| 2 | 第二轮假设「不传 `network: {}` 子对象让 SDK 走 SandboxNetworkAccess 工具回路代替 HTTP_PROXY 注入」（基于 spike 阶段配置最简也弹了 SandboxNetworkAccess 推断） | 部分对部分错：实测两层**并存**而不是二选一。删 `network: {}` 后 SDK 仍启本地 HTTP_PROXY 拦网络（curl 还是拿 403），同时 SandboxNetworkAccess 工具也照样调（`[canusetool]` log 铁证）。原假设的「二选一」前提错 |
| 3 | 第三轮假设「canUseTool 顶部 `SandboxNetworkAccess` 自动 deny 分支是死代码」（基于「没看到弹框 + curl 走 proxy 路径」推断） | 加 `[canusetool]` log 后铁证此分支**一直生效**：用户视角看不到弹框是因为我们 auto-deny + 给 message 让 model 走 fallback 路径，整个流程是「设计好的稳定路径」不是「分支没触发」。**加 log 之前的「断言死代码」是没实证就下定论的典型踩坑** |
| 4 | 第四轮假设「workspace-write 配置里 `excludedCommands` 或 `filesystem` 字段触发 SDK 切到 HTTP_PROXY 模式」（基于「spike 极简版弹 SandboxNetworkAccess、加配置后不弹」错觉） | 第四次 dev 跑「极简版 workspace-write」（只 `enabled + autoAllowBashIfSandboxed`）行为跟完整版**完全一样**：仍走 HTTP_PROXY 路径，仍不弹 SandboxNetworkAccess 给用户（因为我们 auto-deny 了）→ 整套假设链坍塌，根因是反驳 #3 的「死代码」误判，不是字段差异 |

### ❓ 部分 / 未验证 / 阶段 3 候选

| # | 项目 | 状态 |
|---|---|---|
| 1 | 用户自定义 `network.allowedDomains` UI（让 proxy 直接放行常用域名 github.com / api.anthropic.com / npm registry 等，减少 SandboxNetworkAccess 触发频率） | 阶段 3 候选 |
| 2 | excludedCommands 名单按用户实际场景追加（docker / watchman / orb / lima 类） | 阶段 3 候选 |
| 3 | 默认从 `'off'` 切到 `'workspace-write'`（与 Codex 对齐） | 阶段 3 候选，需 1-2 周用户反馈无异常 |
| 4 | SessionCard 加「sandbox 档位 chip」 | 跳过；当前所有会话档位都跟全局一致显示重复信息，等出现「不同会话不同档位」需求才做（要加 v007 migration） |

## 修复（CHANGELOG_41 落地）

### HIGH

1. **`src/main/adapters/claude-code/sandbox-config.ts`**：从 `managedSettings.sandbox` 包装路径回滚到 `query.options.sandbox` 顶层字段（reuse SDK `SandboxSettings` 类型 import），三档配置依实测真相重新装配
2. **`src/main/adapters/claude-code/sdk-bridge.ts:248`**：canUseTool 顶部 `SandboxNetworkAccess` 自动 deny + 结构化 message 分支稳定生效，注释更新写明「实测真相 + 双层并行机制 + 不是死代码」
3. **`src/main/adapters/claude-code/sdk-bridge.ts:526`**：删 spike env gate（`process.env.AGENT_DECK_SANDBOX_SPIKE === '1'` 那 8 行 hack） + 加 `[sandbox] mode=X → enabled` 一行 log 让排查少绕一圈

### MED

4. **`src/shared/types.ts:399`**：`AppSettings` 加 `claudeCodeSandbox` 字段 + JSDoc 详述三档语义
5. **`src/main/ipc.ts:177`**：加 `parseSandboxMode` helper（参考 `parsePermissionMode` 模式）+ `SettingsSet` handler 入口对该字段做白名单校验
6. **`src/renderer/components/SettingsDialog.tsx:400`**：「实验功能」section 加 sandbox 三档 select 下拉框 + 详细文案 + 「仅下次新建会话生效」amber 色 hint（同步给 agentTeamsEnabled 也加同色 hint）
7. **`resources/claude-config/CLAUDE.md:23`**：加「沙盒模式」说明段告诉会话内 model 边界（哪些命令会被拦 + 处理姿势 + 与 permissionMode 正交）

### LOW

8. **`src/renderer/components/settings/controls.tsx:12`**：`Section` 加 `defaultOpen` + `storageKey` props 实现折叠 + localStorage 持久化（命名空间 `agent-deck:settings:section:<key>`）
9. **`src/renderer/components/SettingsDialog.tsx`**：11 个 section 全部加 storageKey，仅「Claude Code Hook」defaultOpen=true
10. **`src/main/adapters/claude-code/sandbox-config.ts`** 防御性兜底：未知 mode 字符串静默回 `'off'` + `console.warn`
11. **`src/main/adapters/claude-code/__tests__/sandbox-config.test.ts`** 新文件：22 cases vitest 单测覆盖

## 关联 changelog

- [CHANGELOG_41.md](../changelogs/CHANGELOG_41.md)：本次实施变更落地

## Agent 踩坑沉淀

候选 1 条 → `.claude/conventions-tally.md`「Agent 踩坑候选」section（与 P20 互补）：

- **「调研 SDK / 复杂系统**行为机制**时凭直觉/局部观察下结论 → 误判」**：本次连续 4 次假设错误（managedSettings.sandbox 装载 / 不传 network 走工具回路代替 HTTP_PROXY / canUseTool 分支是死代码 / 是某个字段触发 SDK 切模式）—— 全是「没加 log 实证就基于局部观察推断机制」的典型踩坑。预防：碰到 sandbox / proxy / 双层防护类「行为机制」问题，**先在关键决策点加 log + 跑实证**，不要靠现象猜机制；尤其是「分支没触发」这种推断必须靠 log 而不是「用户视角没看到」。与 P20 互补：P20 是「能力存不存在」类（→ 查 d.ts），新候选是「行为怎么工作」类（→ 加 log + 实测）
