---
review_id: REVIEW_36
title: sandbox + resume + hand-off 真实生效性 + 项目优化空间深度 review (R1+R2)
created_at: 2026-05-14
plan_id: null
worktree_path: null
base_commit: e6ffce4
final_commit: TBD
heterogeneous_dual_completed: true
---

# REVIEW_36 — sandbox + resume + hand-off 真实生效性 + 优化空间 R1+R2 深度 review × fix 收口

## 触发场景

用户主动「deep code review 一下项目代码有没有优化/重构的空间和需要，额外重点：沙盒的配置是否是真实生效的，特别是 resume、hand off 后」。`agent-deck:deep-code-review` SKILL 多轮异构对抗模式 + R2 复审验证 fix 不引新问题。

## 方法

### Scope = 11 文件 ~3300 LOC

聚焦沙盒生效全链 + spawn / hand-off 透传：

- **claude SDK 沙盒**：sandbox-config.ts / sdk-bridge/sandbox-resolve.ts / sdk-bridge/index.ts / sdk-bridge/recoverer.ts / sdk-bridge/restart-controller.ts / sdk-bridge/session-finalize.ts / sdk-bridge/query-options-builder.ts
- **codex SDK 沙盒**：codex-cli/sdk-bridge/index.ts
- **mcp tool 透传链**：agent-deck-mcp/tools/handlers/spawn.ts / hand-off-session.ts / hand-off-session-impl.ts

### 异构对抗 reviewer

| 轮次 | reviewer-claude | reviewer-codex |
|---|---|---|
| **R1** | 1 teammate (全 11 文件 scope) | 拆 2 批 (Batch A=claude SDK 7 文件 / Batch B=codex+spawn/hand-off 4 文件) |
| **R2** | 同 R1 reviewer (复用 mental model) | 同 R1 reviewer 2 批 (复用 mental model) |

### R1 codex 第一次失败 + 用户决策重试

R1 reviewer-codex teammate 第一次撞 codex CLI sandbox `read-only` EPERM 链：codex 主动尝试跑 `pnpm vitest` 验证某些 finding → vitest mkdir `/var/folders/...` 30+ 次 EPERM 重试 → codex exit 1 → OUT empty。**未拿到任何有效 finding**。

按 SKILL §失败兜底 + 用户决策（选项「重试 reviewer-codex teammate 拆批 + prompt 硬约束」）：shutdown 失败 teammate → 重 spawn 拆 2 批（A: claude SDK 7 文件 / B: codex+spawn/hand-off 4 文件）+ prompt 加硬约束「严禁主动调 vitest / pnpm test / mkdir / 任何写操作」。

### 工作流（R1 → fix → R2 → fix → 收口）

- **R1**: 1 reviewer-claude（全 scope）+ 2 reviewer-codex（拆 2 批）= 3 个独立 finding 集
- **R1 fix**: 3 HIGH + 3 LOW（reviewer-claude HIGH-1 + reviewer-codex Batch A H1 双方独立 ✅ HIGH 真问题；reviewer-claude MED-1 + reviewer-codex Batch B H1 双方独立 ✅ HIGH-2 升级；reviewer-claude MED-2 + reviewer-codex Batch A M1 + reviewer-codex Batch B H2 三方独立 ✅ HIGH-3 升级）
- **R2**: 复用 R1 同对 reviewer 验证 fix 不引新问题
- **R2 fix**: 1 R2 HIGH-A（fix-to-fix bug：baton 关掉新 spawn session）+ 2 R2 MED（restart-controller 丢 permissionMode + race window）+ R2 HIGH-B + MED-C（cwd fallback 写权限扩大 + 外置 worktree plan 文件被拦）
- **用户中途反馈**：user CLAUDE.md §Step 4 ff-merge 目标分支应该是 base_branch（plan 创建时切 worktree 所在的原分支）而不是直接 main → 同步修 user CLAUDE.md + archive_plan tool 默认值
- **INFO follow-up**：注释完善 / schema describe 文档化 / codex restartWithCodexSandbox rename defense

## R1 三态裁决（共 6 真问题 + 3 INFO + 1 *未验证*）

### ✅ HIGH 真问题（3 条全部双方/多方独立提出）

#### HIGH-1: recoverer fallback claudeCodeSandbox 静默降级（安全 critical）

- 双方独立：reviewer-claude HIGH-1 + reviewer-codex Batch A H1 完全撞车
- 文件：`recoverer.ts:420 + L452`
- 问题：fallback 路径调 createThunk 没透传 `rec.claudeCodeSandbox`，sandbox-resolve 拿 opts.resume=undef + opts.claudeCodeSandbox=undef → 走 settings 全局 fallback（默认 'off'）→ SDK 子进程实际无沙盒，与 sessionRepo.claudeCodeSandbox='strict' 完全脱钩
- 后续 renameSdkSession 把 fromRow.claude_code_sandbox 覆盖到 NEW row 让 DB 字段看起来正确，但已 spawn 的 SDK 进程已无法改沙盒（spawn-time 锁定）→ DB 显 strict + SDK 实际无沙盒
- 修法：`CreateSessionThunk` 类型加 `claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict'` 字段；recoverer 两处 createThunk 调用都加 `claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined`

#### HIGH-2: hand_off_session schema 缺 sandbox 字段（双方独立）

- reviewer-claude MED-1 + reviewer-codex Batch B H1（codex 升 HIGH 因接口完整性 — caller 无法覆盖只能继承）
- 文件：`schemas.ts:294` + `hand-off-session.ts:223`
- 问题：spawn_session schema 已有 `permission_mode / codex_sandbox / claude_code_sandbox` 三字段，但 HAND_OFF_SESSION_SCHEMA 只有 `permission_mode` —— hand_off_session caller 无法为新 session 显式覆盖 sandbox 档位（只能依赖 lead 继承）
- 修法：HAND_OFF_SESSION_SCHEMA 加 `codex_sandbox` + `claude_code_sandbox` 两 enum 字段镜像 spawn_session；hand-off-session.ts spawnArgs 同步加透传

#### HIGH-3: 外置 worktree 路径 sandbox.allowWrite 不覆盖（三方独立角度互补）

- reviewer-claude MED-2 + reviewer-codex Batch A M1 + reviewer-codex Batch B H2（codex 升 HIGH）
- 文件：`hand-off-session.ts:209` + `sandbox-config.ts:156`
- 问题：CHANGELOG_99 plan-driven default cwd 改为 mainRepo（cwd resilience）。约定 worktree（`<mainRepo>/.claude/worktrees/<plan-id>`）正常 ✓。但**外置 worktree**（用户手动 `git worktree add /tmp/wt` / `/Users/me/elsewhere/wt`）下 cwd=mainRepo + sandbox.allowWrite=[mainRepo, /tmp, ~/.cache] 不覆盖外置路径 → workspace-write 写每个文件弹框 / strict 完全卡死
- 修法：plan-driven 模式 default cwd 推导加分支 — `worktreePath.startsWith(mainRepo + '/')` 命中 → mainRepo（约定 worktree）；否则 → worktreePath（外置 worktree）。判定用 `mainRepo + '/'` 严格防同名前缀误命中（`/repo` vs `/repo-other`）

### ✅ LOW 真问题（trivial 直接合）

- **LOW-1**: spawn.ts:107-108 sessionRepo.get 重复调用 → 合并成 `const leadRecord = ...; const callerExists = leadRecord !== null;`（reviewer-claude 单方）
- **LOW-2**: query-options-builder.ts:133 注释仍写 `managedSettings.sandbox` 但实现已改顶层 `sandbox` → 改注释（reviewer-codex Batch A 单方）
- **LOW-3**: recoverer.ts:135 `void this.summariseFn` 是 CHANGELOG_107 Step 1 临时 silence TS6138，Step 3 起 helper 真调用后已成死代码 → 直接删（reviewer-codex Batch A 单方）

### ❌ 反驳/不修

- **reviewer-claude LOW-2 restart-controller 短窗口 DB ↔ SDK 不一致**：reviewer-codex 实际验证「restartWithClaudeCodeSandbox 时序验证通过」反向佐证是 UX > 一致性的合理取舍 → 不修
- **reviewer-claude LOW-3 session-finalize 吞错**：reviewer-codex 未提，reviewer-claude 自己也建议「保持」→ 接受现状

## R2 三态裁决（5 真问题 + 3 INFO + 1 R1 follow-up）

R1 fix 全过 + 无回归 ✅（reviewer-claude R2 详 audit + reviewer-codex Batch A R2 INFO 「HIGH-1 fix 语义与原行为完全一致，无回归」）。但 R2 复审挖出新问题（**fix 真生效**激活了原本被掩盖的 cwd-sandbox 协同问题；3 条 pre-existing restart bug；1 条 fix-to-fix bug）：

### ✅ R2 HIGH 真问题

#### R2 HIGH-A: hand_off_session(team_name=x) baton 关掉新 spawn session（lead 已实证）

- reviewer-codex Batch B R2 HIGH-1，lead grep 验证证据完整
- 链路：spawn.ts:310-317 把新 sid 加为 teammate → hand-off-session.ts 默认调 shutdownTeammatesOnBaton(caller) → shutdown-teammates-on-baton.ts:84 只排除 caller 不排除新 sid → **新 session 立即被 sessionManager.close 关掉**
- **fix-to-fix 衍生**：HIGH-2 加 `claude_code_sandbox` schema 字段后用户更可能配 hand_off_session 全套字段（含 team_name），撞这个 pre-existing 但被掩盖的 bug
- 修法：shutdownTeammatesOnBaton 加 `excludeSessionIds: ReadonlySet<string>` 参数（dep injection）；hand-off-session.ts 把新 spawn 的 sessionId 通过 excludeSessionIds 传给 helper

#### R2 HIGH-B: cwd fallback workspace-write 写权限扩大（架构性 trade-off）

- reviewer-codex 双批共识：Batch A R2 H1 + Batch B R2 H2（HIGH-3 follow-up）
- reviewer-claude R2 视为「fallback 路径固有 trade-off」，reviewer-codex 视为 silent escalation HIGH
- 问题：recoverer.ts cwd fallback 后 sandbox.allowWrite=[fallback cwd, /tmp, ~/.cache]，原 worktree 写边界扩大到 fallback 父目录（如 `/Users/me/elsewhere/wt` 删了 → fallback `/Users/me/elsewhere`）
- **轻量级架构修法**（不走 migration）：保留 fallback 算法（不破坏现有 best-effort 体验）+ 强 emit warn message 告诉用户「workspace-write 档下 sandbox 写权限边界变化，原写权限范围 X，新写权限范围 Y（fallback 父目录），如安全敏感请右键归档新建会话」。让用户透明知情决策。strict / off 档不需提示（无 allowWrite / 无 sandbox）

### ✅ R2 MED 真问题

#### R2 MED-A: restartWithClaudeCodeSandbox 冷重启丢失既有 permissionMode（lead 已实证）

- reviewer-codex Batch A R2 M1，lead grep 验证
- 文件：`restart-controller.ts:229-234`
- 问题：restartWithClaudeCodeSandbox 传 claudeCodeSandbox 但 NOT permissionMode → query-options-builder L62 默认 `default` → 用户原 `acceptEdits/plan/bypassPermissions` 切 sandbox 后被静默重置；DB/UI 与 SDK 实际行为不一致
- 修法：透传 `permissionMode: rec.permissionMode ?? undefined`

#### R2 MED-B: restart 单飞标记设置过晚 race（lead 已实证）

- reviewer-codex Batch A R2 M2，lead grep 验证
- 文件：`restart-controller.ts:191-269`（restartWithPermissionMode + restartWithClaudeCodeSandbox 同款）
- 问题：inflight 检查后**直到 createSession promise 建好**才 `recovering.set(sessionId, p)` → 两个并发 restart 都能越过 inflight 检查，同时进入 closeSession + DB write 阶段，结果交错
- 修法：inflight 检查通过后**立即** `recovering.set(sessionId, p)`，覆盖 close + DB + createSession 全阶段

#### R2 MED-C: 外置 worktree 时 mainRepo plan 文件被 sandbox 拦（HIGH-3 fix 不彻底）

- reviewer-codex Batch B R2 MED-1，反向证明 HIGH-3 fix 不彻底
- 问题：HIGH-3 fix 让外置 worktree → cwd=worktreePath → workspace-write 只允许写 worktreePath / /tmp / cache → mainRepo 不在 allowWrite 内 → 接力 session 更新 `mainRepo/.claude/plans/<id>.md` plan frontmatter status=completed 被沙盒拦
- 修法（与 R2 HIGH-B 共享 sandbox extraAllowWrite 透传链）：
  - `sandbox-config.ts` `buildSandboxOptions` 加第三参 `extraAllowWrite?: readonly string[]`，workspace-write 档 allowWrite=[cwd, ...dedupedExtra, /tmp, cache]
  - `sdk-bridge/index.ts createSession` opts 加 `extraAllowWrite?: readonly string[]`
  - `adapters/types.ts` `CreateSessionOptions.extraAllowWrite` + `claude-code/index.ts` adapter 透传
  - `spawn.ts` opts.extra_allow_write 透传给 createSession
  - `schemas.ts` SPAWN_SESSION_SCHEMA + HAND_OFF_SESSION_SCHEMA 加 `extra_allow_write` 字段（z.array(z.string()).max(16).optional()）
  - `hand-off-session.ts` plan-driven + 外置 worktree 自动加 mainRepo 进 extraAllowWrite（caller 显式传 args.extra_allow_write 优先合并）

### ❓ R2 *未验证* / INFO follow-up（已落地）

- **reviewer-codex Batch B R2 ❓ codex restartWithCodexSandbox 隐式 fork runtime defense**：当前 codex SDK 实测 resume 永远返回同 id，但代码无 defense；SDK 升级时可能 silently fail。修法：加 rename defense（与 claude restartWithClaudeCodeSandbox 同款 if newRealId !== sessionId → renameSdkSession + warn）
- **reviewer-claude R2 INFO-1**：HIGH-3 修法注释补完整（「strict 档下降级 worktreePath 无意义」+「外置 worktree 删了 fallback 路径限制」）
- **reviewer-claude R2 INFO-3**：schemas.ts cwd describe 文档化「约定 vs 外置 worktree」推导差异

### INFO（不阻塞合并，下次拆分轮处理）

- **reviewer-claude R2 INFO-2**：recoverer.ts 602 行继续触发拆分护栏

## 用户中途反馈（user CLAUDE.md §Step 4 ff-merge 目标分支）

中段用户插话：「user CLAUDE.md §Step 4 plan 收尾流程里的 `git -C <main-repo> merge --ff-only` 把 worktree branch 合到 main 不对，应该合到切出来的分支上（原分支概念）」。

**问题**：feature branch 上跑 plan → ff-merge worktree branch 时不该无脑合到 main，应该合到切 worktree 时所在的 base branch（plan frontmatter 记录）。

**关联问题**：mcp `archive_plan` tool schema 当前 `base_branch?: 'main'` 默认值同样有问题。

**修法**：
1. user CLAUDE.md §Step 2 plan frontmatter 加 `base_branch` 字段说明（feature branch 上开 plan 就是 feature branch 名）
2. user CLAUDE.md §Step 4 step 2 改为「先 checkout base_branch + ff-merge worktree branch」+ ⚠️ 强调「不是无脑用 main」
3. archive_plan tool schema `base_branch` 去掉 `.default('main')` 改 optional
4. archive-plan-impl.ts 解析优先级 = caller 显式 input.baseBranch > plan frontmatter.base_branch > 'main' fallback

## 修复落地（共 9 文件 / 5 commit 准备）

### 实现层（src）
- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts`: HIGH-1 (CreateSessionThunk 加 claudeCodeSandbox + 两处 createThunk 透传) + LOW-3 (删死代码) + R2 HIGH-B (emit warn 写权限边界变化)
- `src/main/adapters/claude-code/sdk-bridge/restart-controller.ts`: R2 MED-A (透传 permissionMode) + R2 MED-B (单飞标记提前 set 覆盖全阶段)
- `src/main/adapters/claude-code/sdk-bridge/index.ts`: R2 MED-C (createSession opts 加 extraAllowWrite + 透传 buildSandboxOptions)
- `src/main/adapters/claude-code/sdk-bridge/query-options-builder.ts`: LOW-2 (注释更新 managedSettings.sandbox → 顶层 sandbox)
- `src/main/adapters/claude-code/sandbox-config.ts`: R2 MED-C (buildSandboxOptions 加第三参 extraAllowWrite)
- `src/main/adapters/types.ts`: R2 MED-C (CreateSessionOptions.extraAllowWrite)
- `src/main/adapters/claude-code/index.ts`: R2 MED-C (adapter 透传 extraAllowWrite)
- `src/main/adapters/codex-cli/sdk-bridge/index.ts`: R2 codex follow-up (restartWithCodexSandbox rename defense)
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts`: LOW-1 (单次反查 sessionRepo.get) + R2 MED-C (透传 extra_allow_write)
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts`: HIGH-2 (sandbox 字段透传) + HIGH-3 (planModeDefaultCwd 推导) + R2 HIGH-A (excludeSessionIds 排除新 sid) + R2 MED-C (外置 worktree 自动加 mainRepo) + R2 INFO-1 (注释完善)
- `src/main/agent-deck-mcp/tools/handlers/shutdown-teammates-on-baton.ts`: R2 HIGH-A (excludeSessionIds 参数)
- `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts`: 用户反馈 (base_branch caller > frontmatter > main 优先级)
- `src/main/agent-deck-mcp/tools/schemas.ts`: HIGH-2 (HAND_OFF_SESSION_SCHEMA 加 sandbox 字段) + R2 MED-C (extra_allow_write 字段) + 用户反馈 (base_branch optional 不再默认 main) + R2 INFO-3 (cwd describe 文档化)

### 文档
- `~/.claude/CLAUDE.md`: §Step 2 plan frontmatter 加 base_branch 字段 + §Step 4 step 2 ff-merge 目标改为 base_branch (强调不是无脑 main)

### 测试（增 8 case）
- `src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts`: 2 HIGH-1 regression case (jsonl missing strict 透传 + normal resume workspace-write 透传)
- `src/main/adapters/claude-code/__tests__/sdk-bridge/_setup.ts`: TestBridge.createSession 捕获 claudeCodeSandbox 字段
- `src/main/agent-deck-mcp/__tests__/hand-off-session.handler-deny-happy.test.ts`: 5 case (HIGH-2 sandbox 透传 caller 显式 + 不传 / HIGH-3a-c cwd 推导 含同名前缀防御 / R2 HIGH-A excludeSessionIds 防 baton 关新 session)

### Verify
- typecheck 双端 0 错
- 全套 40 files / 503 tests 全过 (64 skipped 是 pre-existing SQLite binding self-check)

## 关联 changelog

CHANGELOG_108 — REVIEW_36 R1+R2 sandbox + resume + hand-off 真实生效性 fix 落地

## 已知踩坑

- **R1 reviewer-codex 第一次失败**：codex 跑 ~410k token 后主动尝试跑 `pnpm vitest` 触发 sandbox EPERM 链，OUT empty。修法：拆批 + prompt 加硬约束「严禁主动调 vitest / pnpm test / mkdir / 任何写操作」。本经验沉淀到 `~/.claude/templates/reviewer-codex.sh.tmpl` 作为下次 review 默认硬约束
- **R2 codex finding 反映「fix 真生效后激活原本被掩盖的问题」**：R1 HIGH-1 fix 让 sandbox 真生效后，cwd fallback 路径下的 sandbox.allowWrite 边界问题（R2 HIGH-B）才显眼起来。这是 fix-to-fix 衍生 race 的典型 — 修一个问题让另一个相关问题暴露
- **R2 HIGH-A baton bug 是真正的 fix-to-fix**：HIGH-2 加 schema 字段让用户更可能配 team_name → 撞 pre-existing baton 关新 session bug。说明深度 review fix 后 R2 复审有价值（不是仪式）
- **架构性重构选轻量方案**：R2 HIGH-B 选「保留 fallback 算法 + emit warn 提示」而非 migration 持久化 mainRepo 元数据，trade-off 是「best-effort fallback 体验保留 + 透明化安全风险」vs「彻底解决 + 大改动」。文档化 trade-off 比黑盒架构性重构更适合 fallback 这种异常路径
- **base_branch 用户反馈**：mcp tool 默认值从 schema `.default('main')` 改 optional + impl 解析优先级让 plan frontmatter 字段成为 SSOT，避免 feature branch 上跑 plan 把 worktree 改动合到 main 污染主线

## Cascading 影响 audit（reviewer-claude R2 6 项全过）

1. recoverer fallback fix 与 lead 继承断链：lead 继承在 spawn handler 内，与 recoverer 完全独立 — 无交互 ✓
2. HIGH-1 fix 与 restart-controller 协同：restartWithClaudeCodeSandbox 显式传 claudeCodeSandbox 给 createSession，不走 recoverer；recovering Map 单飞，race 不存在 ✓
3. placeholder enqueue race：unrelated to fix ✓
4. batonMode 透传：不受 sandbox 字段影响 ✓
5. HIGH-2 + HIGH-3 交互：caller 显式 strict + 外置 worktree → spawnArgs={cwd: worktreePath, claude_code_sandbox: 'strict'} → buildSandboxOptions('strict', worktreePath) → strict 档不给 allowWrite。修法对 strict 档无意义但无害 ✓
6. rename 协同：fallback 透传 rec.claudeCodeSandbox='strict' → finalizeSessionStart 写 newRealId='strict' → rename(OLD, newRealId) toExists=true 分支 UPDATE 同值 = no-op ✓
