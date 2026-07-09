---
plan_id: "add-claude-cli-path-override-and-bump-sdks-20260520"
created_at: "2026-05-20"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/add-claude-cli-path-override-and-bump-sdks-20260520"
status: "completed"
base_commit: "4cfe0d8"
base_branch: "main"
revision: "v2 (Step 1.5 Deep-Review R1 三态裁决落地 — 修 3 HIGH + 5 真 MED + 5 trivial LOW;0 真 finding 残留)"
motivation_source: "与 plans/hand-off-session-adopt-teammates-20260520.md 平行的 follow-up;user 反馈\"加 claudeCliPath 设置项对齐 codex\"+\"顺便 bump 应用内置 CLI 版本\""
priority: "MED(claudeCliPath 部分 LOW + bump SDK 部分 MED 因 breaking 风险,但 spike 实测 0 breaking 后整体降到 LOW-MED)"
final_commit: "ece8f6f4d8fd1a95395dea467461f0824ae799c7"
completed_at: "2026-05-20"
---
# 加 `claudeCliPath` 设置项(对齐 codex)+ bump 应用内置 SDK 版本

## 总目标

两件主题相关任务(都是"应用内置 binary 管理"主题)一并做:

1. **加 `claudeCliPath` 设置项**(对齐 `codexCliPath` historical asymmetry):面板加输入项 + settings type 加字段 + claude-code SDK call sites 优先级链改 `user 填的 > 内置`,让 user 可选用自装版本(类似 codex 模式)
2. **bump 应用内置 SDK 版本**(spike 实测 0 breaking,放心做):
   - `@anthropic-ai/claude-agent-sdk` `^0.2.118` → `^0.3.144`(major bump 但 PURELY ADDITIVE)
   - `@openai/codex-sdk` `^0.120.0` → `^0.131.0`(11 minor 跨越但 PURELY ADDITIVE — d.ts 仅 +2 行 token 计数字段)

## 动机

user 实测设置面板看到只 codex 有"二进制路径"选项,询问为啥不对称。grep 实测确认 historical asymmetry:codex SDK 自然提供 `codexPathOverride` API,agent-deck 顺手暴露给 user;claude SDK 同样支持 `pathToClaudeCodeExecutable`(`query-options-builder.ts:140` spread)但 agent-deck 现实现只走 `getPathToClaudeCodeExecutable()` 自动解析 npm 包 + asar.unpacked,没接 user override 入口。补 `claudeCliPath` 是 historical-asymmetry 平衡 + ~32 行 base / ~112 行含可选 unit test(spike3 实测 + Step 1.5 Deep-Review R1 修订 §Step 8 mock 估算后)。

bump SDK 版本是同主题 follow-up:既然在改 binary 管理路径,顺手把内置版本拉到最新让用户用上 latest CLI features(claude SDK 0.2 → 0.3 / codex SDK 0.120 → 0.131 都跨越多个 release)。spike1+2 实测 0 breaking → 放心做。

## 不变量

- **N1 claudeCliPath 镜像 codexCliPath 字面对称**:settings.ts 字段 jsdoc 描述 / DEFAULT 默认 null / ipc/settings.ts hot-toggle 钩子 / ExternalToolsSection.tsx UI 控件全部与 codex 镜像 — 维护成本最低 + user mental model 对称
- **N2 每 phase 末 typecheck + 全 test 套必须 0 fail + build 全过**:test 数 ≥ 当前 baseline(spike 时 762 pass + 76 skip;Phase 1 加 priority chain 单测后基线 +N,新增 test 文件需 commit message 注明数字漂移)。**Step 1.5 Deep-Review R1 L-MED-2 修法**:合并旧 N2「不破坏 762 测试」(钉死数字易触发 false positive)+ N4「typecheck/test/build 全绿」语义重叠
- **N3 bump 后 .app 启动 + 起新 SDK 会话 + 走 deep-review SKILL spawn pair smoke 通过**:Phase 4 e2e smoke 验证 vendored binary 路径解析 + asarUnpack glob + sandbox cold-switch + mcp tool integration 全链路 work。**N3 同时承担 D9 peer dep 兼容性兜底**(typecheck 不查间接 dep API surface,只能靠 e2e 实测验证 0.81 间接 dep 与 claude-agent-sdk 0.3.144 内部代码路径是否真兼容 — Step 1.5 Deep-Review R1 L-MED-4 修法)
- **N5 优先级链 `user 填非空 > bundled fallback`**:`(claudeCliPath && claudeCliPath.trim()) || getPathToClaudeCodeExecutable()` inline pattern — 镜像 codex 现行(spike3 §B1 边界完整覆盖 null/空字符串/全空白/含前后空白/正常路径 5 种)。**user override path 前后空白(含 \\n)被 trim 后传给 SDK 是 codex 现行行为镜像**,filepicker 残留 \\n 不让 spawn 失败(user-friendly 静默副作用 — Step 1.5 Deep-Review R1 L-LOW-1 修法)
- **N6 已 spawn 中的 SDK 会话不受 claudeCliPath 变更影响**:子进程已 spawn 后 binary path 已传递给 cli.js — setting 改动只影响下次 createSession(与 codex setCodexCliPath 同款 mental model,spike 2 §1 同款铁证)

> 编号注:旧 N4「typecheck/test/build 全绿」已合并入 N2,N# 编号留空避免 cross-reference 漂移。

## 设计决策(不再争论)

- **D1 claudeCliPath 优先级链镜像 codex 现行 inline pattern**(RFC R1.Q1 决):`(path && path.trim()) || getPathToClaudeCodeExecutable()` 在 2 个 production call sites 直接 inline;不抽 helper(codex 也 inline,N=2 不到抽 helper 的阈值)
- **D2 bump 范围:两个都 bump 但选最近稳定版**(RFC R1.Q2 决):
  - claude SDK → `^0.3.144`(2026-05-18 release,2 天老,跳过 0.3.145 = spike 当时 < 24h 太新)— spike1 实测 0 breaking
  - codex SDK → `^0.131.0`(2026-05-18 release,2 天老,跳过 0.132.0 = spike 当时 < 24h 太新)— spike2 实测 0 breaking
- **D3 bump 撞 breaking 时退化策略**(RFC R1.Q3 决,但 spike 实测 0 breaking → 不触发):「升级为复杂 plan,加 SDK migration phase」分支留作未来撞 breaking 时备用,本 plan 不需要。**Step 1.5 Deep-Review R1 C-LOW-1 修法 — 给可执行 recipe 防 Phase 2/3 撞 breaking 临场无指引**:
  - **触发条件**:Phase 2/3 跑 `pnpm typecheck` 报 ≥ 1 error / `pnpm test --run` ≥ 1 fail / d.ts diff 含非 additive 改动(类型字段重命名/移除/收紧 union)
  - **第一动作**:**停止本 phase 不再继续后续 step**;`git -C <worktree> reset --hard HEAD~1`(若已 commit)或 `git -C <worktree> checkout package.json pnpm-lock.yaml + pnpm install`(若未 commit)回滚 SDK bump → 保 plan §不变量 N2 不破
  - **拆 plan 入口**:本 plan §Phase 2/3 stop in place;新建 sibling plan `<sdk-name>-migration-<YYYYMMDD>.md`(如 `claude-sdk-0.3.x-migration-20260521.md`)按 user CLAUDE.md §复杂 plan 流程从 Step 0 RFC 重起(spike inventory breaking surface,RFC 决该不该 migration / 拆什么 sub-phase / 分批 land);老 plan(本 plan)删 §Phase 2 或 §Phase 3 改成「等 sibling migration plan 收口后再回 bump」
  - **migration phase 第一动作 inventory**:在新 plan §Phase 0.5 spike 内 grep 全 src/ 找该 SDK 受 breaking 影响的 call site → 列每条 fix recipe(refactor type usage / 改 import / 改 hook handler shape 等)→ migration 完成后回老 plan 续做
- **D4 smoke test 矩阵最全覆盖**(RFC R1.Q4 决):
  - typecheck + 全 test 套(必)
  - claude session spawn / sendMessage / streaming / claudeCodeSandbox 冷切(off→workspace-write→strict)
  - codex session spawn / sendMessage / streaming / codexSandbox 冷切(workspace-write→read-only→danger-full-access)+ mcp tool approval gate(自调本应用注入的 mcp tool 实测)
  - deep-review SKILL spawn pair smoke(reviewer-claude + reviewer-codex 异构对一齐起)
  - hand_off baton(plan-driven mode handoff 测起新 session)
- **D5 inline 而非抽 helper**(spike3 §Step 3 决):2 caller 文件分别 inline + import settingsStore;不在 sdk-runtime.ts 加 `resolveClaudeBinary()` helper(避免 sdk-runtime.ts 引入 settingsStore 依赖,保持 pure utility 模块)。**Step 1.5 Deep-Review R1 C-INFO-1 + L-MED-1 双方独立修法 — 显式 articulate 边界 + 标注「硬约束 §1 例外」防机械检查再争论**:user CLAUDE.md §提示词资产维护 §硬约束 §1「多处出现同款规则抽到一处其他位置引用」治理 prompt 资产(CLAUDE.md / agent body / SKILL)字符级冗余;D5 inline 决议适用代码 module 边界设计,两者**作用域正交不冲突**。codex N=2 现行也是 inline 模式(`codex-instance-pool.ts:46` + `codex-cli/sdk-bridge/index.ts:240` 两文件都 inline 同款 priority chain),本 plan 字面镜像。如未来出现第 3 个 call site 再考虑抽 helper
- **D6 ipc/settings.ts hot-toggle 钩子 no-op**(spike3 §Step 6 决):claude SDK 不持 instance pool 不需 invalidate;每次 createSession 重新 settingsStore.get → setting 即改即生效(下次 createSession 用新路径)。占位钩子留 if-block 有助 reader 看出对称结构,但 body 只放注释解释「不需 invalidate」
- **D7 不加 existsSync 护栏**(spike3 §B2 决):codex 现行不做,镜像 — user 填错路径时 SDK spawn 自然 ENOENT,error 走 recoverer 兜底链。如未来想加 existsSync follow-up plan 处理
- **D8 现有测试 mock 策略保留 + Phase 1 §1.6 改动量 0 LOC**(spike3 §Step 8 + Step 1.5 Deep-Review R1 L-HIGH-1 + L-HIGH-2 双方现场实测修法):
  - 实测 5 文件已直接 / 间接 mock 适配 priority chain 短路语义:`createsession-fail-fast.test.ts` ✓ / `setttimeout-fallback-symmetry.test.ts` ✓ / `sdk-bridge.recovery.test.ts` ✓ / `set-permission-mode-rollback.test.ts` ✓(line 51-52 已 mock settings-store) / `hand-off.test.ts` ✓(通过 sdk-runtime mock 接住,priority chain `(undefined && trim) || fallback` 短路至 fallback)
  - **`file-change-intent-delay.test.ts` 不需要 mock** — 实测仅测 sdk-message-translate 纯函数 + StreamProcessor,0 处 sdk-bridge / sdk-runtime / settings-store 引用,**完全不走 priority chain 路径**
  - **`sdk-bridge.consume-fork.test.ts` 不需要 mock** — TestBridge override createSession 直接 return mock handle,priority chain 不被实际调用
  - **`hand-off.test.ts` 强加 vi.mock 会破坏现有 test** — 该 file line 197+202+210 现有 `await import('@main/store/settings-store')` + `settingsStore.set('handOffModel', ...)` 直读真 store 模式,vi.mock 会 mock 掉 set
  - 未来可选加 priority chain 行为单测(独立文件,~80 LOC,Phase 1 自决是否加)
- **D9 `@anthropic-ai/sdk` peer dep warning 不 fix 在本 plan**(spike1 §peer dep 决):0.93+ peer 收紧产生 WARN 但不阻塞 install / typecheck / test;Phase 2 留 backlog 注释,后续 follow-up plan 处理(`pnpm add @anthropic-ai/sdk@^0.93.0`)。**Step 1.5 Deep-Review R1 L-MED-4 修法 — typecheck 不查间接 dep API surface,如果 0.3.144 内部 SDK 真用上 0.93+ 新 API → runtime 才撞错;Phase 4 e2e smoke(N3)起真 SDK 会话验证 0.81 间接 dep 是否真兼容 0.3.144 内部代码路径,作为 peer dep 兼容性兜底**
- **D10 spike 累积旧版本残留可选 `pnpm store prune`**(spike2 §副作用 决):0.120 残留 ~150 MB 不阻塞,Phase 3 实施时一并 prune(可选)

## 步骤 checklist

### Step 0/0.5/1/1.5/2 已跑或将跑

- [x] Step 0 RFC 多轮对齐 design(R1 1 轮收敛,Q1-Q4 全决)
- [x] Step 0.5 spike1 跑通 — claude SDK 0.2.118 → 0.3.144 typecheck 0 errors / test 762 pass
- [x] Step 0.5 spike2 跑通 — codex SDK 0.120.0 → 0.131.0 typecheck 0 errors / test 762 pass / d.ts +2 行 additive
- [x] Step 0.5 spike3 跑通 — claudeCliPath priority chain design 验证 + 改动 LOC 估算 + tests mock 策略
- [x] Step 1 plan v1 完整写就
- [x] Step 1.5 Deep-Review SKILL kind='plan' R1 — 3 HIGH + 5 真 MED 全 land plan v2(本文档);0 残留
- [ ] Step 2 EnterWorktree(user confirm 后,走 §EnterWorktree CLI stale base bug 主路径 (b) Bash + EnterWorktree(path:) 两步)

### Phase 1 — 加 claudeCliPath 设置项 + sdk-bridge wire(~32-112 LOC)

- [ ] **1.1** `src/shared/types/settings.ts` 加 `claudeCliPath: string | null` 字段(紧挨 codexCliPath,line ~123;jsdoc 描述镜像 codexCliPath jsdoc 风格)+ `DEFAULT_SETTINGS.claudeCliPath = null`(紧挨 codexCliPath default,line ~386)
- [ ] **1.2** `src/main/ipc/settings.ts` 加 hot-toggle 钩子(if-block 与 codexCliPath 紧挨,~line 85-87 后追加;body 只放注释解释「claude SDK 不需 invalidate」— D6)
- [ ] **1.3** `src/main/adapters/claude-code/sdk-bridge/index.ts:253` 加 inline priority chain(原 1 行 `const claudeBinary = getPathToClaudeCodeExecutable()` → 2 行 `const claudeCliPath = settingsStore.get('claudeCliPath');` + `const claudeBinary = (claudeCliPath && claudeCliPath.trim()) || getPathToClaudeCodeExecutable();`)+ 顶部加 `import { settingsStore } from '@main/store/settings-store';`
- [ ] **1.4** `src/main/session/oneshot-llm/claude-runner.ts:55` 同款 inline priority chain + import settingsStore
- [ ] **1.5** `src/renderer/components/settings/sections/ExternalToolsSection.tsx` 加 ExecutablePicker 控件(label="Claude 二进制路径",紧挨现有 Codex 控件之后)
- [ ] **1.6** **0 mock 改动需要**(D8 修订):priority chain `(claudeCliPath && trim) || fallback` 短路语义自动接住未 mock 的 `settingsStore.get` 返 undefined / null;现有 5 个测试已直接 / 间接 mock 接住(详 §设计决策 D8 5 文件清单)。如未来想加 test isolation 守门(防 user 真 settings.json 写过 claudeCliPath 让本地 test fail),可在 hand-off.test.ts 顶部 `beforeAll` 加 `settingsStore.set('claudeCliPath', null)` 显式归零,但**不在 Phase 1 范围**
- [ ] **1.7**(可选)新加 priority chain 单测 — 实测 grep 现没有 `getPathToClaudeCodeExecutable` 行为单测,可选加 ~80 LOC 验证「user 填非空 → user override / 留空 → fallback / 全空白 → fallback」3 case;Phase 1 自决,不强求
- [ ] **1.8** ⚑ checkpoint:`pnpm typecheck` + `pnpm test --run` 全绿;commit 信息含「Phase 1: add claudeCliPath setting (mirror codex)」

### Phase 2 — bump `@anthropic-ai/claude-agent-sdk` 0.2.118 → 0.3.144

- [ ] **2.1** `pnpm update @anthropic-ai/claude-agent-sdk@0.3.144`(spike1 实测 1m 57s 完成)
- [ ] **2.2** 验证 lockfile clean — `pnpm-lock.yaml` 只改 claude SDK 相关条目;主仓库内可能也产生 `node_modules/.pnpm/` 旧 0.2.118 残留 ~10 MB(可选 `pnpm store prune`)
- [ ] **2.3** 确认 asarUnpack glob 不需改 — `package.json` 已含 `node_modules/@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*/**/*` 通配,新版命名一致(spike1 §asarUnpack 实测验证)
- [ ] **2.4** `pnpm typecheck` 全绿(spike1 实测 0 errors)
- [ ] **2.5** `pnpm test --run` 全绿(spike1 实测 762 pass)
- [ ] **2.6**(可选 backlog notice)peer dep `@anthropic-ai/sdk@>=0.93.0` warn — 在 commit 信息或 changelog 注释「留 follow-up 处理」(D9)
- [ ] **2.7** ⚑ checkpoint:typecheck + test 全绿;commit 信息含「Phase 2: bump claude-agent-sdk 0.2.118 → 0.3.144 (spike1 verified zero breaking)」
- [ ] **2.8** 撞 breaking 退化路径(D3):typecheck error / test fail / d.ts 非 additive 改动 → 立即 reset lockfile + 拆 sibling migration plan(详 D3 recipe)

### Phase 3 — bump `@openai/codex-sdk` 0.120.0 → 0.131.0

- [ ] **3.1** `pnpm update @openai/codex-sdk@0.131.0`(spike2 实测 3m 24s 完成 — 比 spike1 慢因 codex platform binary 包 ~150 MB 大)
- [ ] **3.2** 验证 lockfile clean — 同 Phase 2 模式
- [ ] **3.3** 确认 asarUnpack glob 不需改 — `package.json` 已含 `node_modules/@openai/codex-{darwin,linux,win32}-*/**/*` 通配(spike2 §asarUnpack 实测验证)
- [ ] **3.4** 确认 `resolveBundledCodexBinary()` PLATFORM_BINARY_MAP 不需改 — vendored binary 路径结构 0.120.0 → 0.131.0 完全一致 `vendor/<triple>/codex/codex`(spike2 §vendored binary 实测 5 platform 全表验证)
- [ ] **3.5** `pnpm typecheck` 全绿(spike2 实测 0 errors)
- [ ] **3.6** `pnpm test --run` 全绿(spike2 实测 762 pass,与 Phase 2 累积测试一致)
- [ ] **3.7**(可选)`pnpm store prune` 清旧版本残留(D10)
- [ ] **3.8** ⚑ checkpoint:typecheck + test 全绿;commit 信息含「Phase 3: bump codex-sdk 0.120.0 → 0.131.0 (spike2 verified zero breaking, only +2 line additive `reasoning_output_tokens`)」
- [ ] **3.9** 撞 breaking 退化路径(D3):同 Phase 2.8 路径 — reset lockfile + 拆 sibling migration plan

### Phase 4 — 端到端 smoke 测试(D4 最全覆盖)

> ⚠️ Phase 4 必须在 Phase 1+2+3 都 land 后跑 — typecheck 通不代表 runtime ok;新版 vendored binary spawn 行为只能实测验证。

- [ ] **4.1 应用 boot smoke**:Step 1.5 Deep-Review R1 C-MED-2 修法 — inline pkill 第 0 步避免 reader 漏看 CLAUDE.md。**完整 0-5 步序列**:
  - **Step 0 杀旧实例**(必做):`pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null` + `pkill -f "Agent Deck Helper" 2>/dev/null`(防 macOS 复用同 bundle id 活进程,旧 main 与新 .app 资源错配,renderer 显示 monaco 源码堆)
  - **Step 1**:`rm -rf release && pnpm dist`
  - **Step 2**:`rm -rf "/Applications/Agent Deck.app" && cp -R "release/mac-arm64/Agent Deck.app" /Applications/`
  - **Step 3**:`codesign --force --deep --sign - "/Applications/Agent Deck.app"`(ad-hoc 重签 — electron-builder 跳过签名时 codesign Identifier 错位)
  - **Step 4**:`xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"`(清 Gatekeeper quarantine)
  - **Step 5**:启动 → 验证 renderer / settings panel UI 正常加载(无 dynamic import 失败 / 无 ENOTDIR / 无 ABI mismatch)
  - 测 wrapper 前必跑 `unset ELECTRON_RUN_AS_NODE`(防 Electron 切到 Node 伪装模式 — 详 §K8)
- [ ] **4.2 claude session smoke**:
  - 新建 claude session(默认 sandbox=off)→ sendMessage → streaming events 正常
  - claudeCodeSandbox 冷切 off → workspace-write → strict 三档(SettingsPanel SDK 区域 / NewSessionDialog SDK 设置 — restartWithClaudeCodeSandbox 路径 verify 重建 SDK 子进程 + 历史保留)
- [ ] **4.3 codex session smoke**:
  - 新建 codex session(默认 sandbox=workspace-write)→ sendMessage → streaming events 正常
  - codexSandbox 冷切 workspace-write → read-only → danger-full-access 三档
  - 起 mcp tool approval gate(reviewer-codex agent body 内会用到 — 会话内调 task_create / hand_off_session 等 mcp tool 出 approval gate 弹给 user)
- [ ] **4.4 deep-review SKILL spawn pair smoke**:Step 1.5 Deep-Review R1 L-LOW-3 修法 — 明确 smoke 边界
  - 触发 `/agent-deck:deep-review` SKILL with kind='code' / paths=[随便几个文件]
  - **smoke 验收标准**:验证 `spawn_session` × 2 成功 + 双 reviewer SessionDetail 显示「跑起来」+ lead 收两份回复 + 调 `shutdown_session` × 2 成功
  - **不要求 review 内容质量**(允许 reviewer 出 0 finding 直接收尾)— 仅验证管道通畅,不评审 review 工艺
- [ ] **4.5 hand_off baton smoke**:
  - 起一个 session A(plan-driven 或 generic mode 二选一)
  - 调 `mcp__agent-deck__hand_off_session` 起 session B(generic mode prompt='测起新会话')
  - 验证 session A 自动归档 + session B 起来 + cwd resilience
- [ ] **4.6 ⚑ checkpoint**:5 大 smoke 全过 + 主进程 / renderer console 无 error/warn 关键日志(允许 warn 等级 setttimeout-fallback 这种已知 / migration 这种合预期)
  - 失败时按 user CLAUDE.md §决策对抗 — single decision 走双 Bash 起外部 CLI(reviewer-claude.sh.tmpl + reviewer-codex.sh.tmpl)做单点对抗

### Phase 5 — Deep-Review SKILL kind='code' 收口

- [ ] **5.1** invoke `/agent-deck:deep-review` SKILL with `{kind: 'code', paths: [<phase 1+2+3 改的所有文件>]}`
- [ ] **5.2** 双 reviewer 出 finding,反驳轮 + 三态裁决(详 user CLAUDE.md §决策对抗 §三态裁决)
- [ ] **5.3** 修 0 HIGH 0 真 MED → review 通过
- [ ] **5.4** ⚑ checkpoint:typecheck + test 全绿(若 review 出新改动)

### Phase 6 — changelog + archive_plan

- [ ] **6.1** 新建 `<main-repo>/changelog/CHANGELOG_X.md` — Step 1.5 Deep-Review R1 C-MED-1 + L-MED-3 双方独立修法:**实施时执行 `ls changelog/CHANGELOG_*.md | grep -oE "[0-9]+" | sort -n | tail -1` 找 max X,新建 X+1**(不钉死具体数字 — plan 写作时 max=132 但实施前可能新写 changelog 让 max 漂移);记录 Phase 1-3 改动概要,引用 plan 归档路径
- [ ] **6.2** 同步 `changelog/INDEX.md` 加行(简表 + 主题概要 ≤80 字)
- [ ] **6.3** `ExitWorktree(action: "keep")` 切出 worktree
- [ ] **6.4** 调 `mcp__agent-deck__archive_plan({plan_id, worktree_path, base_branch:"main", changelog_id:<6.1 实测填的 max+1>})` — 自动 ff-merge / mv plan / mv spike-reports / commit / 删 worktree + branch + baton-cleanup phase 1+2 archive caller
  - 如撞 archive_plan precheck fail(mainRepo dirty 等):走 user CLAUDE.md §Step 4 5 步手工归档 + `mcp__agent-deck__shutdown_baton_teammates` escape hatch 补跑 phase 1
- [ ] **6.5** ⚑ caller session 自动归档 — 会话使命终结

## 当前进度

- ✅ v0 初始草稿写就(motivation + RFC question + spike 列表 + checklist 占位)
- ✅ Step 0 RFC 1 轮 4 个 design question 全决(D1-D4 + 间接 D5-D10)
- ✅ Step 0.5 spike1+2+3 跑通 — claude SDK 0 breaking / codex SDK 0 breaking / claudeCliPath design 验证清晰
- ✅ Step 1 plan v1 完整写就
- ✅ Step 1.5 Deep-Review R1 三态裁决 + plan v2 修订 — 3 HIGH(base_commit stale / file-change-intent-delay 不需要 mock / spike3 §Step 8 mock claim 错)+ 5 真 MED(D5 硬约束边界 / N2+N4 重复 + 762 stale / CHANGELOG max stale / D9 N3 兜底缺 / Phase 4.1 pkill 缺) + 5 trivial LOW(D3 退化 recipe / N5 trim 语义 / K7 命名撞车 / Phase 4.4 SKILL smoke 边界 / LOC 估算 stale)全 land;R2 双方 ✅ 可合 + 1 真 MED(spike3 后半段 stale)+ 1 LOW 顺手清,0 残留
- ✅ Step 2 EnterWorktree(主路径 (b) Bash + EnterWorktree(path:),worktree HEAD = main HEAD = 4cfe0d8 base 锁定)
- ✅ Phase 1 commit `99a9373` — claudeCliPath setting + sdk-bridge wire(5 文件 +40/-2 LOC,settings.ts / ipc/settings.ts / sdk-bridge/index.ts / claude-runner.ts / ExternalToolsSection.tsx;⚑ typecheck 0 + test 762 pass)
- ✅ Phase 2 commit `b855fe1` — bump @anthropic-ai/claude-agent-sdk 0.2.118 → 0.3.144(spike1 实测 0 breaking;⚑ typecheck 0 + test 762 pass)
- ✅ Phase 3 commit `38483f1` — bump @openai/codex-sdk 0.120.0 → 0.131.0(spike2 实测 +2 行 additive;⚑ typecheck 0 + test 762 pass)
- ✅ Phase 4.1 production build GREEN(`pnpm build` 187+8+449 modules transformed,无新错误)
- 🔶 Phase 4.4 / 4.5 部分 implicit smoke verified(本会话由 hand_off baton 起来 + 跑 deep-review SKILL 双 reviewer pair 成功),但**完整 5 大 smoke 仍需 user 实测** — Phase 4.1 dist 出 .app 后 install + 4.2 claude session sandbox 切档 + 4.3 codex session sandbox + mcp tool approval gate + 4.4 完整 SKILL shutdown + 4.5 cwd resilience verify
- ✅ Phase 5 Deep-Review SKILL kind='code' R1 — 双方 0 真 HIGH;1 单方 MED 反驳(asarUnpack glob:历史 .app 实证 electron-builder pnpm-aware hoist 真生效);1 真 MED(plan §当前进度 stale)+ 1 真 LOW(picker tooltip 硬编码 codex)修;3 LOW 接受作 Phase 4 兜底(无 unit test / dist 实测 / peer dep runtime 兼容)
- ⏳ Phase 4.1-4.3 user 实测 + Phase 6 changelog + archive_plan 收尾

## 下一会话第一步

如果是新会话接力(罕见 — 本 plan Phase 5 R1 已完成,主要剩 Phase 6 收尾 + Phase 4.1-4.3 user 实测):

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/add-claude-cli-path-override-and-bump-sdks-20260520.md` 全文读
2. **worktree 已建**(Phase 1+2+3 已 commit `99a9373` / `b855fe1` / `38483f1`)→ 走 `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/add-claude-cli-path-override-and-bump-sdks-20260520")` 直接进入
3. 进 worktree 后立刻 `Bash: pwd` 自检 cwd 在 worktree 内 + `git log --oneline -5` 确认 Phase 1-3 commit 在 worktree branch 上
4. **下一步通常是**:
   - **(a) Phase 4.1-4.3 user 实测**:`pnpm dist` 出 .app + install 验证 boot smoke + claude/codex session smoke + sandbox 切档 + mcp tool approval gate(详 §Phase 4.1-4.3)
   - **(b) Phase 6 changelog + archive_plan**:实测 `ls changelog/CHANGELOG_*.md | grep -oE "[0-9]+" | sort -n | tail -1` 找 max 写新 changelog + ExitWorktree(action:keep) + archive_plan 自动 ff-merge / mv plan / mv spike-reports / commit / 删 worktree
5. 进度 / 决策变更必须先告诉用户征得确认

## 已知踩坑

> 注:Step 1.5 Deep-Review R1 L-LOW-2 修法 — spike1 §H4 内部「K7」概念(claude SDK 内部 native binary 解析逻辑)与本 plan §K1-K8 编号不同含义,本节 §K5 引用改成「SDK native binary 解析路径」消歧避免 reader 跳错章节。

- **K1 spike worktree v2.1.112 stale base bug 实测击中**(spike1 prep):用 `EnterWorktree(name:)` 一步建+进时 base 可能落到 origin/main 而非本地 HEAD;本 spike 改用 `git worktree add -b ... <path>` 显式 + `EnterWorktree(path:)` 两步,保 base = HEAD。Phase 2 实施时同款主路径,不再二次踩
- **K2 scratch worktree pnpm postinstall 跳 electron build script**(spike1 §Step 4):pnpm 默认 ignore lifecycle scripts(`Run "pnpm approve-builds" to pick`);scratch worktree 跑 test 撞 "Electron failed to install correctly";`cd .pnpm/electron@.../node_modules/electron && node install.js` 手工跑修。**Phase 2/3 实施时**走主仓库已 install 好的状态,无此问题
- **K3 main bump 0.2 → 0.3 数字看起来像 breaking,实测 PURELY ADDITIVE**(spike1 实测铁证):major version 数字升不等于 breaking。spike 实测确认 typecheck 0 errors / test 0 fail / d.ts diff 全 additive。**Phase 2 实施时不需触发 RFC R1.Q3 D3 退化分支**(留作未来 backlog)
- **K4 codex 11 minor 跨越实测仅 +2 行 additive**(spike2 实测铁证):11 个 minor 数字看起来恐怖,实际 d.ts diff 只有 `reasoning_output_tokens: number` 一个字段加在 turn usage 里。**Phase 3 实施时不需触发任何 fallback**
- **K5 user override 短路 SDK native binary 解析路径不存在反向覆盖风险**(spike3 §B3 实证):priority chain 拿到 user 路径 → 直接 spread 给 query options.pathToClaudeCodeExecutable → SDK 不再走内部 native binary 解析(spike1 §H4 概念上称 "K7" 但与本节 K# 编号不同含义)。**Phase 1 实施时不需加额外护栏**
- **K6 已 spawn 中的 SDK 子进程不受 setting 变更影响**(spike3 §N6 实证):binary path 已经 spawn 时传给 cli.js 子进程 → setting 改了不会回滚已跑会话。这是 **feature 不是 bug**(与 codex 同款语义),不要试图加复杂的「热重启所有 active session」逻辑
- **K7 改 main / preload 必须重启 dev**(CLAUDE.md 项目级约定):Phase 1 改的文件含 main/ 下源码 → 跑 dev 验证 UI 时按 CLAUDE.md §验证流程节 5 行 kill+pkill+pnpm dev 流程
- **K8 Phase 4 e2e smoke 必跑 unset ELECTRON_RUN_AS_NODE**(CLAUDE.md §打包与本地安装):Bash 工具调起的 wrapper 默认带此 env,会让 Electron 切到 Node 伪装模式 → wrapper `--version` 返 v20.18.3 不是真 .app 版本。Phase 4 验证 wrapper 步骤前必跑 unset
