# CHANGELOG_108

## 概要

REVIEW_36 R1+R2 sandbox + resume + hand-off 真实生效性 + 优化空间深度 review × fix 收口（用户主动「sandbox 配置 resume / hand-off 后是否真生效」）。异构对抗（1 reviewer-claude 全 scope + 2 reviewer-codex 拆批）共挖 6 R1 真问题 + 5 R2 真问题（含 1 fix-to-fix bug）+ 中段用户反馈 user CLAUDE.md §Step 4 ff-merge 目标分支应该是 base_branch 而非直接 main。共修 13 文件 + 8 新 regression case + 全套 503 tests / typecheck 双端全过。详 [REVIEW_36.md](../../reviews/history/REVIEW_36.md)。

## 变更内容

### R1 HIGH: recoverer fallback claudeCodeSandbox 静默降级（双方独立 ✅，安全 critical）

- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:47-67` `CreateSessionThunk` 类型加 `claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict'` 字段
- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:432 + L471` jsonl missing fallback 路径 + 正常 resume 路径 createThunk 都加 `claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined` 显式透传
- 修前漏洞：fallback 路径下 sandbox-resolve 拿 opts.resume=undef + opts.claudeCodeSandbox=undef → 走 settings 全局 fallback（默认 'off'）→ SDK 子进程实际无沙盒，与 sessionRepo.claudeCodeSandbox='strict' 完全脱钩 → DB 显 strict + SDK 实际无沙盒
- 测试：`__tests__/sdk-bridge.recovery.test.ts` 加 2 个 regression case（jsonl missing strict 透传 + normal resume workspace-write 透传）+ `__tests__/sdk-bridge/_setup.ts` TestBridge 捕获 claudeCodeSandbox

### R1 HIGH: hand_off_session schema 缺 sandbox 字段（双方独立 ✅）

- `src/main/agent-deck-mcp/tools/schemas.ts:300-310` HAND_OFF_SESSION_SCHEMA 加 `codex_sandbox` + `claude_code_sandbox` 两 enum 字段镜像 spawn_session
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:282-290` spawnArgs 构造段加 sandbox 字段透传

### R1 HIGH: 外置 worktree allowWrite 不覆盖（三方独立 ✅）

- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:218-238` plan-driven 模式 default cwd 推导加分支 — 约定 worktree（`worktreePath.startsWith(mainRepo + '/')` 命中）走 mainRepo（CHANGELOG_99 cwd resilience 不变）；外置 worktree → cwd=worktreePath（让 sandbox.allowWrite 自然覆盖）。判定用 `mainRepo + '/'` 严格防同名前缀误命中（`/repo` vs `/repo-other`）

### R1 LOW × 3 trivial

- `src/main/agent-deck-mcp/tools/handlers/spawn.ts:107-109` LOW-1 sessionRepo.get 单次反查（合并 callerExists / leadRecord）
- `src/main/adapters/claude-code/sdk-bridge/query-options-builder.ts:133-137` LOW-2 注释从 `managedSettings.sandbox` 改为「顶层 sandbox 字段（REVIEW_15 实测铁证）」
- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:135-148` LOW-3 删 CHANGELOG_107 Step 1 临时 silence TS6138 已成死代码的 `void this.summariseFn`

### R2 HIGH: hand_off_session(team_name=x) baton 关掉新 spawn session（fix-to-fix bug，lead 实证）

- `src/main/agent-deck-mcp/tools/handlers/shutdown-teammates-on-baton.ts:46-86` 加 `excludeSessionIds: ReadonlySet<string>` 可选 deps 参数 — caller 显式传集合让 helper 跳过指定 sid
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:82-92 + L297-322` shutdownTeammates seam 签名加可选第二参；调用时把新 spawn 的 sessionId 通过 excludeSessionIds 传给 helper
- 修前漏洞：spawn.ts:310-317 把新 sid 加为 teammate → hand-off-session.ts 默认调 shutdownTeammatesOnBaton(caller) → shutdown-teammates-on-baton.ts:84 只排除 caller 不排除新 sid → **新 session 立即被 sessionManager.close 关掉**。R1 HIGH-2 加 sandbox schema 字段后用户更可能传 team_name → 撞此 pre-existing bug
- 测试：`__tests__/hand-off-session.handler-deny-happy.test.ts` 加 R2 HIGH-A regression case（验证新 spawn sid 在 excludeSessionIds 中）

### R2 HIGH: cwd fallback workspace-write 写权限边界变化（架构性 trade-off，emit warn 透明化）

- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:233-251` cwd fallback 路径强 emit warn message — workspace-write 档下显示「原写权限范围 X，新写权限范围 Y（fallback 父目录），如安全敏感请右键归档新建会话」。strict / off 档不需提示
- 轻量级架构修法：保留 fallback 算法（不破坏现有 best-effort 体验）+ 强 emit 透明化安全风险，避免 migration 持久化 mainRepo 元数据的大改动

### R2 MED: restartWithClaudeCodeSandbox 冷重启丢失既有 permissionMode（lead 实证）

- `src/main/adapters/claude-code/sdk-bridge/restart-controller.ts:235-243` 透传 `permissionMode: rec.permissionMode ?? undefined` — 修前用户原 `acceptEdits/plan/bypassPermissions` 切 sandbox 后被静默重置 default

### R2 MED: restart 单飞标记设置过晚 race（lead 实证）

- `src/main/adapters/claude-code/sdk-bridge/restart-controller.ts:103-145 + L200-280` restartWithPermissionMode + restartWithClaudeCodeSandbox 同款修法 — placeholder Promise 在 close + DB write + createSession 之前 set 到 recovering Map，覆盖整个冷重启的副作用窗口
- 修前漏洞：inflight 检查后**直到 createSession promise 建好**才 set，两个并发 restart 都能越过 inflight 检查同时进入 close 阶段

### R2 MED: 外置 worktree 时 mainRepo plan 文件被 sandbox 拦（HIGH-3 fix follow-up）

R2 MED-C 反向证明 R1 HIGH-3 fix 不彻底 — extraAllowWrite 透传链架构性重构：

- `src/main/adapters/claude-code/sandbox-config.ts:115-202` `buildSandboxOptions` 加第三参 `extraAllowWrite?: readonly string[]`，workspace-write 档 allowWrite=[cwd, ...dedupedExtra, /tmp, cache]
- `src/main/adapters/claude-code/sdk-bridge/index.ts:155-200 + L240-247` createSession opts 加 `extraAllowWrite` 透传给 buildSandboxOptions
- `src/main/adapters/types.ts:57-77` `CreateSessionOptions.extraAllowWrite`
- `src/main/adapters/claude-code/index.ts:74-83` claude adapter 透传
- `src/main/agent-deck-mcp/tools/schemas.ts:77-87 + L312-322` SPAWN_SESSION_SCHEMA + HAND_OFF_SESSION_SCHEMA 加 `extra_allow_write` 字段（z.array(z.string()).max(16).optional()）
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts:212-220` 透传 args.extra_allow_write 给 createSession
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:240-265` plan-driven + 外置 worktree 自动加 mainRepo 进 extraAllowWrite（caller 显式传 args.extra_allow_write 优先合并）

### 用户中段反馈：user CLAUDE.md §Step 4 ff-merge 目标分支 + archive_plan tool 默认值

用户中途插话：「user CLAUDE.md §Step 4 plan 收尾流程的 ff-merge 把 worktree branch 合到 main 不对，应该合到切出来的分支上（原分支概念）」。

- `~/.claude/CLAUDE.md` §Step 2 plan frontmatter 字段加 `base_branch`（plan 创建时切 worktree 所在的原分支，feature branch 上开 plan 就是 feature branch 名）
- `~/.claude/CLAUDE.md` §Step 4 step 2 改为「先 checkout base_branch + ff-merge worktree branch」+ ⚠️ 强调「不是无脑用 main」
- `src/main/agent-deck-mcp/tools/schemas.ts:202-208` archive_plan tool schema `base_branch` 去掉 `.default('main')` 改 optional
- `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:46-58 + L268-307` impl 解析优先级 = caller 显式 input.baseBranch > plan frontmatter.base_branch > 'main' fallback。新增 effectiveBaseBranch 替换原 input.baseBranch

### INFO follow-up

- `src/main/adapters/codex-cli/sdk-bridge/index.ts:381-410` codex `restartWithCodexSandbox` 加 implicit fork rename defense — 当前 codex SDK 实测 resume 永远返回同 id，但加 if newRealId !== sessionId → renameSdkSession + warn 防 SDK 升级时 silently fail（与 claude restart 同款）
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:210-234` HIGH-3 注释补完整（「strict 档下降级 worktreePath 无意义」+「外置 worktree 删了 fallback 路径限制」）
- `src/main/agent-deck-mcp/tools/schemas.ts:268-280` HAND_OFF_SESSION_SCHEMA cwd describe 文档化「约定 vs 外置 worktree」推导差异

### Verify

- `pnpm typecheck` 双端 0 errors
- `pnpm exec vitest run` = 40 test files / **503 tests 全过** + 64 skipped (pre-existing SQLite binding self-check)
- 增 8 case：2 HIGH-1 regression + 5 HIGH-2/3 + R2 HIGH-A regression

## 已知踩坑

- **R1 reviewer-codex 第一次失败**：codex 跑 ~410k token 后主动尝试跑 `pnpm vitest` 触发 sandbox EPERM 链 → 30+ 次 mkdir 重试 → exit 1 → OUT empty。修法：拆批 + prompt 加硬约束「严禁主动调 vitest / pnpm test / mkdir / 任何写操作」让 codex 只走 grep / sed / nl / 读源码。本经验应沉淀到 reviewer-codex.sh.tmpl 作为下次 review 默认硬约束（follow-up）
- **R2 codex finding 反映「fix 真生效后激活原本被掩盖的问题」**：R1 HIGH-1 fix 让 sandbox 真生效后，cwd fallback 路径的 sandbox.allowWrite 边界问题（R2 HIGH-B）才显眼。fix-to-fix 衍生 race 典型 — 修一个问题让另一个相关问题暴露
- **R2 HIGH-A baton bug 是真正的 fix-to-fix**：HIGH-2 加 schema 字段让用户更可能配 team_name → 撞 pre-existing baton 关新 session bug。说明深度 review fix 后 R2 复审有价值（不是仪式）
- **架构性重构选轻量方案**：R2 HIGH-B 选「保留 fallback 算法 + emit warn 提示」而非 migration 持久化 mainRepo 元数据，trade-off 是「best-effort fallback 体验保留 + 透明化安全风险」vs「彻底解决 + 大改动」。文档化 trade-off 比黑盒架构性重构更适合 fallback 这种异常路径
- **base_branch 用户反馈**：mcp tool 默认值从 schema `.default('main')` 改 optional + impl 解析优先级让 plan frontmatter 字段成为 SSOT，避免 feature branch 上跑 plan 把 worktree 改动合到 main 污染主线
- **archive-plan-impl test 全部 pass**：base_branch 改动后已存测试无回归（test 都显式传 baseBranch arg，不依赖 default）

## 关联

- **REVIEW_36.md**: R1+R2 详细三态裁决 + cascading 影响 audit + 修复方法详述
- **REVIEW_15.md**: REVIEW_15 实测确认 sandbox 双层并行（SandboxNetworkAccess + HTTP_PROXY）+ 顶层 sandbox 字段（非 managedSettings.sandbox）— 本轮 LOW-2 注释更新基于此
- **REVIEW_32.md**: spawn 默认继承 lead permission/sandbox 三态机制（REVIEW_32 HIGH-5）— 本轮 HIGH-2 hand-off schema 加 sandbox 字段是 spawn 三态机制的延伸覆盖
- **REVIEW_34.md**: handOffSpawn 透传 sandbox + worktree_path 存在性预检（REVIEW_34 H6/H10）+ archive_plan base_branch checkout（REVIEW_33 H1）— 本轮 base_branch 用户反馈是 REVIEW_33 H1 的进一步完善（caller 不传时优先 frontmatter 而非 default 'main'）
- **CHANGELOG_99**: cwd resilience 设计（plan-driven default cwd=mainRepo）+ recoverer findFallbackCwd 启发式 fallback — 本轮 HIGH-3 是约定 vs 外置 worktree 的边界完善
- **CHANGELOG_106 + CHANGELOG_107**: shutdownTeammatesOnBaton helper + recoverer summariseFn fallback prepend — 本轮 R2 HIGH-A 在 helper 加 excludeSessionIds 不破坏 helper 既有签名（archive_plan 等其他 caller 可继续不传）
