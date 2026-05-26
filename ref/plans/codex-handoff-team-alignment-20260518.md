---
plan_id: "codex-handoff-team-alignment-20260518"
created_at: "2026-05-18"
status: "completed"
base_branch: "main"
base_commit: "4aefb5ad26ca3842a8ea20302f2e2da930fee0eb"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-handoff-team-alignment-20260518"
final_commit: "88c94f192cd53986d46ecad3a916a10e6b92aea6"
completed_at: "2026-05-19"
---
# Plan: codex-handoff-team-alignment-20260518 (v4.1 post-P6-light-review)

## 总目标

让 codex-cli adapter 能完整使用 hand-off / team / archive_plan 等 MCP 编排机制，解之前双对抗 review 发现的 3 个 HIGH 阻塞（HIGH-1 caller_session_id transport 注入 / HIGH-2 cold-start 协议 codex 不识别 / HIGH-4 NO MSG ANCHOR + Wire format 协议规约 codex 不可见）。顺手解 EnterWorktree CLI stale base bug + archive_plan 场景 C 解锁。

## 历史

- **v1**（已废弃）：5 phase 19+ step。双对抗 review 发现 3 HIGH + 6 MED + 多 LOW
- **v2**（已废弃）：加 P-1 Spike Phase 前置 3 spike
- **v3**（已废弃）：3 spike 完成 + 基于 spike 综合重写 P1-P5 详细 step 到行级 + line-level reference
- **v4**（已废弃）：v3 走双对抗 review 出 6 HIGH + 7 MED + 4 LOW = 17 条 finding，全部 inline 修补到 v4。关键修订：
  - D1 新增 token 共存 ADR 三态明示（per-session vs 全局 fallback）
  - D3 修正 4 种异构矩阵 reviewer-claude wrapper 的 adapter 选择歧义（codex-cli + agent_name='reviewer-claude' → codex-config wrapper，**不是** claude-config）
  - 新增 D7「lead vs teammate 信号源」：用 `opts.batonMode` flag 或 `args.adapter` 异质性，**禁**用 spawnedBy 字段判断（v3 错误信号源）
  - 不变量 6 修订：enforce 点是 spawn handler 在 options-builder 阶段 spread default 字段，**不**在 bridge.startThread hardcode（避免污染普通 codex session）
  - 新增不变量 7：`mcpSessionTokenMap.rename` 调用必须进 `sessionManager.renameSdkSession` 函数体（防 thread-loop.ts fork 路径漏调）
  - P1 Step 1.1 补 `rename.ts` 20 列扩展 + toExists UPDATE 覆盖块
  - P1 Step 1.4 拆 sub-step 写清 handler vs impl 改动
  - P2 Step 2.5 拆 5 sub-step（a-e）+ 加 sid 时序「先 allocate(tempSid) → new Codex → startThread → real sid rename」
  - P2 Step 2.8/2.9 改名 sessionManager.close（不是 shutdownSession）
  - P3 Step 3.3-3.4 补 ipc/assets.ts + preload + renderer adapter 参数传递
  - P4 加 Step 4.0 mini-spike：claude -p 内部 Bash tool 在 codex sandbox 嵌套层下是否跑通
  - P5 加 Step 5.4.5 pre-archive smoke test（dev 起 codex teammate spawn → reviewer wrapper 端到端）
- **v4.1**（本版本，2026-05-18 P6 light review 后定稿）：v4 P6 走 light review 出 3 HIGH + 6 MED + 2 LOW = 11 条 finding，全部 inline 修补到 v4.1。关键修订：
  - **H1**：P6.1 user CLAUDE.md 直 Edit 拆 4 sub-step（dry-run diff → user ack → backup → Edit）
  - **H2**：P6.4 拆 P6.4a/b（**保留 deep-code-review/ 目录名，不 mv**；物理 mv 推到 P6.7 + 新增 P6.7b deprecation stub 保留老名为 6 个月）
  - **H3**：P6.5 明示老 SKILL 仍叫 deep-code-review + caller 走 P6.4b auto cp 落地（兜底 caller 手动 cp）
  - **M1**：P6.3 reviewer agent body 改动覆盖 4 个 file（含 P4 新建的 codex-config 2 个）
  - **M2**：P6.8 加 3 sub-step（worktree 预检 → ExitWorktree(keep) → archive_plan）+ 接力会话场景说明
  - **M3**：§P6 RFC §复杂 plan §触发条件 改成「保留现有 2 bullet，bullet 1 内扩展子条件，新增 bullet 3」（不删现有触发项）
  - **M4**：auto sandbox cache 命名 `<sha8>-<sanitized-basename>.md` + invocation-id manifest（防并发 review 互踩 + cleanup 精确）
  - **M5**：§当前进度 加 P5/P6 checkpoint + §下一会话第一步 加分支（如选不跑 P6 → 直接 P5.6 archive）
  - **M6**：kind='mixed' 模板加成本明示（2x token + 2x time）+ 失败兜底（任一 reviewer fail 不阻塞，缺失方 finding 降级单方非 HIGH）
  - **L1**：P6.6 加 3 条 smoke（新名 plan review + auto cp + reviewer body sandbox 节生效）+ dev 重启提示（agent body spawn-time 注入必须 kill + 重启）
  - **L2**：§已知踩坑 加「SKILL.md 内嵌模板 vs ~/.claude/templates/ 关系」（plugin self-contained 与 user 全局两份独立维护）

## 不变量

1. **不破坏现有 claude-code 路径**：所有改动对 claude adapter 行为零回归
2. **应用层托管不依赖 codex agent 配合**：HIGH-1 修法走 transport 中间件
3. **MCP 版 EnterWorktree/ExitWorktree 不强制取代 claude builtin**：claude 端 builtin 仍是首选
4. **plugin / SKILL 资产两套独立维护**：
   - **协议层 + agent body** 在 codex-config 新建独立目录
   - **SKILL** 复用现有 `src/main/codex-config/skills-installer.ts` 独立通道
5. **archive_plan 预检解锁场景 C**：通过 sessionRepo.cwd_release_marker 标记 + **archive_plan 预检改读 sessionRepo.cwd（非 process.cwd）**
6. **codex teammate spawn 默认 option 强制（v4 修订 enforce 点）**：spawn 出的 codex teammate session 必须配 `sandboxMode: 'workspace-write'` + `approvalPolicy: 'never'` + `networkAccessEnabled: true` + `additionalDirectories: ['~/.claude', '~/.codex']`。**enforce 点 = spawn handler 在 `options-builder.ts` narrowToCodexOpts 阶段按 agent_name 是否 reviewer-* 触发 spread default 字段**；**禁**在 `bridge.startThread` 默认 hardcode（污染普通 codex session）。reviewer-claude wrapper Bash 模板用 `$AGENT_DECK_CLAUDE_PATH` env var（由主进程 `resolveBundledClaudeBinary()` 计算后注入 envOverride），**禁** hardcode `/abs/path/to/claude`
7. **`mcpSessionTokenMap.rename` 进 `sessionManager.renameSdkSession` 函数体**（v4 新增）：rename 同步必须在 `sessionManager.renameSdkSession` 内部调用（与 sdkOwned 转移同款保证），不能让 caller 各自调（codex bridge `thread-loop.ts` CLI 隐式 fork 路径会漏；claude SDK fallback 路径同款不漏）。claude vs codex 各自调用语义对照表见 P2 Step 2.8

## 设计决策（不再争论）

### D1. caller_session_id transport 注入（v3 锁死方案 B + v4 补 token 共存 ADR）

**Spike 1 实证**（详 `<worktree>/spike-reports/spike1-mcp-sdk-extra-arg.md`）：mcp-sdk 1.29.0 `RequestHandlerExtra` 已含完整 transport-level context。

**三 transport 行为对照**：

| Transport | extra.authInfo 来源 | callerSessionIdOverride 行为 |
|---|---|---|
| **in-process** | undefined（不走 HTTP） | closure 直接 override 现状不变 |
| **HTTP** | `{resolvedSid, fallbackToGlobal}` from HookServer.onRequest req.raw.auth | extra.authInfo.resolvedSid |
| **stdio** | undefined（stdio 无 HTTP auth） | undefined → fallback args.caller_session_id |

#### v4 新增 ADR：per-session token vs 全局 token 共存策略（M1 修法）

**背景**：现状 `agent-deck-mcp-injector.ts` 走全局 `process.env.AGENT_DECK_MCP_TOKEN`（main bootstrap 设进，codex 子进程继承）。P2 引入 per-session token Map 后，三个边界必须明示：

**(a) bearer_token_env_var 共存语义**：
- codex SDK config 写 `bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN'` 不变（codex CLI 子进程仍读 env var 拿 token）
- 但 env 来源切换：**per-session 路径** envOverride `{ AGENT_DECK_MCP_TOKEN: <session-token> }`（new Codex 时 frozen，spike 2 实证）；**全局路径**（外部 codex CLI / claude 普通调用）仍读 process.env（main bootstrap 设的全局 token）
- 两者**不冲突**：per-session 走 envOverride 优先（spike 2 §1 实证），全局走 process.env fallback

**(b) fallback 全局命中策略**：
- HookServer.onRequest mcp 分支接收 Bearer token → 先查 mcpSessionTokenMap.get(token) → 命中返 resolvedSid + fallbackToGlobal=false；不命中再比对 mcpServerToken（全局 token）→ 命中返 resolvedSid=null + fallbackToGlobal=true
- handler 内 callerSessionId 为 null + fallbackToGlobal=true 时：**视为 external caller**（走 EXTERNAL_CALLER_ALLOWED 表，spawn/send/shutdown/archive_plan/hand_off_session/enter_worktree/exit_worktree 全 deny；list/get 允许）
- 这保证「external codex CLI 走全局 token 调用 MCP 时只能读不能写」与 stdio external caller 行为对齐

**(c) process.env mutation 与 envOverride frozen 互动**：
- main bootstrap 启动时设 `process.env.AGENT_DECK_MCP_TOKEN = <global-token>`（一次性，不再 mutate）
- per-session Codex envOverride 在 `new Codex({env: {...process.env, AGENT_DECK_MCP_TOKEN: <session-token>}})` 时 frozen 拷贝（spike 2 §1 实证 envOverride 内部 `Object.assign` 拷贝到子进程 env，不共享引用）
- 主进程后续 mutate process.env 不影响已建的 Codex 实例（spike 2 §Test 1 实证）；新 spawn 的 codex teammate 会拿到新 process.env 快照
- `setAgentDeckMcpTokenEnv()` 全局 setter **删除**（v4 修订）— 全局 token 在 main bootstrap 启动时一次性设，运行时不再改

### D2. EnterWorktree/ExitWorktree MCP tool

- 字段 `cwd_release_marker`: enter 时 set 为 worktreePath / exit 时 clear / session close hook 联动清
- archive_plan 预检改读 `sessionRepo.cwd`（不再读 process.cwd）+ marker 等于 worktreePath → 放过
- 多 session 并发：marker 是 per-session 字段（不是全局），各 caller 各持
- base 优先级：caller arg base_commit > caller arg base_branch > plan frontmatter base_commit > plan frontmatter base_branch > HEAD
- 路径/分支冲突：enter_worktree 失败时不写 marker + 返回结构化 error + hint

### D3. 4 种异构矩阵（v4 修正 reviewer-claude wrapper adapter 选择歧义）

**Spike 3 实证**（详 `<worktree>/spike-reports/spike3-codex-sandbox-extern-cli.md`）：codex SDK workspace-write 完整支持 reviewer-claude wrapper 路径。

**4 种异构矩阵全部 feasible（v4 修订矩阵明示 adapter）**：

| Lead | Reviewer | spawn args（确切） | 实现 |
|---|---|---|---|
| claude lead | reviewer-claude teammate | `adapter:'claude-code', agent_name:'reviewer-claude'` | 现状 `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`（claude SDK teammate） |
| claude lead | reviewer-codex teammate | `adapter:'claude-code', agent_name:'reviewer-codex'` | 现状 `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`（claude SDK 子 session, Bash 起外部 codex CLI 拿 oneshot） |
| codex lead | reviewer-codex teammate | `adapter:'codex-cli', agent_name:'reviewer-codex'` | P4 新建 `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md`（codex SDK teammate） |
| codex lead | reviewer-claude teammate | `adapter:'codex-cli', agent_name:'reviewer-claude'` | P4 新建 `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md`（codex SDK 子 session, Bash 起外部 claude CLI 拿 oneshot）|

**关键修正（v3 H4 反驳）**：codex lead spawn reviewer-claude wrapper teammate 时 **`adapter='codex-cli'`**（不是 'claude-code'），agent_name='reviewer-claude' → 走 codex-config wrapper body。**`adapter='claude-code' + agent_name='reviewer-claude'` 是 claude lead × claude teammate 的 cell**（第一行），不是 codex × claude wrapper。

- `resources/claude-config/` 现状保持
- `resources/codex-config/` 新建：`CODEX_AGENTS.md` + `agent-deck-plugin/agents/`
- **SKILL 不在 codex-config 单独写**：skills-installer.ts 改 multi-source 让 codex 视角差异写到 codex-config/.../skills/（如有，当前阶段不必），仍走独立通道 ~/.codex/skills/agent-deck/

### D4. spawn handler agent_name 按 adapter 路由

spawn.ts 按 `args.adapter` 选 plugin root：`'codex-cli'` → codex-config / `'claude-code'` → claude-config

### D5. agents-md-installer 源切换（v4 补 fallback 策略）

- 同步源切到 `codex-config/CODEX_AGENTS.md`（不再读 claude-config/CLAUDE.md）
- **fallback 策略**：如果 `codex-config/CODEX_AGENTS.md` 不存在（开发/打包配置漏） → throw 显式 error（**不**静默 fallback 到 claude-config/CLAUDE.md，避免 typecheck/build 过但运行时 codex AGENTS.md 注入静默退化到 claude 视角内容，让用户视角直到跑 codex 才发现错）
- **`package.json` extraResources 配置**：P3 Step 3.1 同步加 `resources/codex-config/` 到 extraResources（与 `resources/claude-config/` 同款）

### D6. 短期 schema deny 兜底

- 仅 `hand_off_session` 入口判 args.adapter === 'codex-cli' 暂 reject（archive_plan 输入无 adapter 字段，无需特殊兜底）
- P5 Step 5.1 落地后撤

### D7. lead vs teammate 信号源约定（v4 新增）

**v3 错误信号源 `opts.spawnedBy`**：
1. `spawned_by` 字段在 sessions 表，在 spawn handler `setSpawnLink` 后才写库（spawn.ts:291）
2. baton 路径已删 spawnedBy（spawnedBy=null，spawn.ts:264-280 注释明示 REVIEW_39 共识）
3. adapter.createSession 跑的时候没法读到 spawned_by（时序错位）

**v4 正确信号源**：

| 场景 | 信号 | 来源 |
|---|---|---|
| spawn handler 内判定「这是 codex teammate spawn」 | `args.adapter === 'codex-cli' && args.agent_name === 'reviewer-claude' \|\| 'reviewer-codex'`（按 agent_name 是否 plugin reviewer-* 触发） | spawn handler 收到 args 直读 |
| spawn handler 内判定「这是 baton 路径」 | `opts.batonMode === true`（hand-off-session-impl 调 spawn 时显式传） | spawn.ts:44 / 67-69 已存在 |
| adapter.createSession 内不需判定 lead/teammate | (移到 spawn handler 层) | options-builder.ts 在 buildCreateSessionOptions 阶段 spread default 字段（D6 / 不变量 6） |

**禁** adapter.createSession 内通过任何形式读 spawnedBy / 反查 sessionRepo 判定角色 — 全部 enforce 提到 spawn handler 层。

## 步骤 checklist

### P0 ✅ Plan + worktree 建立

- [x] 写本 plan v2 / v3 / v4 到 `<main-repo>/.claude/plans/codex-handoff-team-alignment-20260518.md`，每版本原地升级
- [x] Bash `git worktree add -b worktree-codex-handoff-team-alignment-20260518 <main-repo>/.claude/worktrees/codex-handoff-team-alignment-20260518` 用 HEAD 作 base
- [x] `EnterWorktree(path: ...)` 进 worktree
- [x] 自检 `git rev-parse HEAD` 等于 base_commit

### P-1 ✅ Spike Phase（前置必做）

- [x] **Spike 1** (`spike-reports/spike1-mcp-sdk-extra-arg.md`)：mcp-sdk 1.29.0 RequestHandlerExtra 完整 transport context；HIGH-A 走 (B) extra.authInfo
- [x] **Spike 2** (`spike-reports/spike2-codex-sdk-subprocess.md`)：codex SDK 子进程模型；HIGH-B 走 per-session 新建 Codex 实例
- [x] **Spike 3** (`spike-reports/spike3-codex-sandbox-extern-cli.md`)：workspace-write 完整支持 reviewer-claude wrapper

### P0.5 ✅ plan v3 + v4 综合重写（本文件原地升级两轮）

- [x] v3: 综合 3 spike 结果 + 重写 P1-P5 详细 step 到行级 + line-level reference
- [x] v3 双对抗 review：6 HIGH + 7 MED + 4 LOW = 17 条 finding
- [x] v4: 17 条 finding 全部 inline 修补到 v4

### P1 EnterWorktree/ExitWorktree MCP tool（~16 step）

> 本 phase 解 HIGH-C (cwd_release_marker 数据流断)，让 archive_plan 预检接受 codex / 外部 caller 路径。

#### Step 1.1: session_repo schema migration v020 + **rename.ts 同步扩列**（v4 H1 修法）

**Files**：

- `src/main/store/migrations/v020_sessions_cwd_release_marker.sql`（新建）：
  ```sql
  ALTER TABLE sessions ADD COLUMN cwd_release_marker TEXT DEFAULT NULL;
  ```
- `src/main/store/migrations/index.ts`：line 32 后加 `import v020 from './v020_sessions_cwd_release_marker.sql?raw';`；line 59 后加 `{ version: 20, name: 'sessions_cwd_release_marker', sql: v020 },`
- `src/main/store/session-repo/types.ts`：line 22 `Row` interface 加 `cwd_release_marker: string | null`；line 48+ `rowToRecord` 加 `cwdReleaseMarker: r.cwd_release_marker ?? null`
- `src/shared/types.ts`：SessionRecord interface 加 `cwdReleaseMarker: string | null`
- `src/main/store/session-repo/core-crud.ts`：upsert 改造（line 36-37 INSERT 列表加 `cwd_release_marker`；line 49 ON CONFLICT 后加 `cwd_release_marker = excluded.cwd_release_marker,`；line 70-73 binds object 加 `cwd_release_marker: rec.cwdReleaseMarker ?? null`）
- **`src/main/store/session-repo/rename.ts` 同步扩列（v4 H1 关键修法）**：
  - line 78-102 INSERT statement 列表从 19 列扩到 **20 列**，加 `cwd_release_marker`（INSERT 列名 + VALUES 占位符 + fromRow.cwd_release_marker 参数）
  - line 152+ `if (toExists && fromRow.<col>)` UPDATE 覆盖块加新分支：
    ```ts
    if (toExists && fromRow.cwd_release_marker) {
      db.prepare(`UPDATE sessions SET cwd_release_marker = ? WHERE id = ?`).run(
        fromRow.cwd_release_marker,
        toId,
      );
    }
    ```
  - 注释参考行 152-156 (permission_mode) / 164-170 (claude_code_sandbox) / 195-203 (extra_allow_write) 同款模式
  - **rationale**: SDK fork / recover (manager.renameSdkSession) 时如果不复制此列，codex teammate enter_worktree 设的 marker 在 fork 后丢失，下次 archive_plan 预检走"在 worktree 内 + 无 marker"分支 reject

**新增 setter（同 core-crud.ts）**：

- `export function setCwdReleaseMarker(id: string, marker: string | null): void`：`UPDATE sessions SET cwd_release_marker = ? WHERE id = ?`
- `export function clearCwdReleaseMarker(id: string): void` = setCwdReleaseMarker(id, null)

#### Step 1.2: MCP tool schemas + types 注册

**Files**：

- `src/main/agent-deck-mcp/tools/schemas.ts`：加 `ENTER_WORKTREE_SCHEMA` + `EXIT_WORKTREE_SCHEMA`（zod）+ Args / Result types
- `src/main/agent-deck-mcp/types.ts` line 60+ AGENT_DECK_TOOL_NAMES 加 `enterWorktree: 'enter_worktree', exitWorktree: 'exit_worktree'`
- `src/main/agent-deck-mcp/types.ts` line 75+ EXTERNAL_CALLER_ALLOWED 加 `enter_worktree: false, exit_worktree: false`（写操作 deny external）

#### Step 1.3: 2 个 MCP tool handler

**Files**：

- `src/main/agent-deck-mcp/tools/handlers/enter-worktree.ts`（新建）：详 v3 同款（已具备）
- `src/main/agent-deck-mcp/tools/handlers/exit-worktree.ts`（新建）：详 v3 同款
- `src/main/agent-deck-mcp/tools/index.ts`：注册 2 个 new tool

#### Step 1.4: archive_plan handler 改读 sessionRepo.cwd（HIGH-C 修法，v4 M4 拆 2 sub-step）

**v4 修订 — 拆 sub-step**：

**Sub-step 1.4a — `archive-plan.ts` handler 注入 marker fetcher**：

- `src/main/agent-deck-mcp/tools/handlers/archive-plan.ts:67-81` 现状已有 `resolveCallerCwdDeps()` 注入 cwd
- 改造：扩展为 `resolveCallerSessionDeps()`，同时注入 `cwd: () => row.cwd` + `cwdReleaseMarker: () => row.cwdReleaseMarker`
- `ArchivePlanDeps` interface 扩展（在 archive-plan-impl.ts）：加 `cwdReleaseMarker?: () => string | null`

**Sub-step 1.4b — `archive-plan-impl.ts` 2 态 switch 改 4 态**：

- 现状（`archive-plan-impl.ts:234-239`）：2 态预检
  ```ts
  if (cwdReal === worktreeReal || cwdReal.startsWith(worktreeReal + sep)) {
    return reject(`caller cwd ... still inside worktree`);
  }
  ```
- v4 改造：4 态 switch
  ```ts
  const inWorktree = cwdReal === worktreeReal || cwdReal.startsWith(worktreeReal + sep);
  const marker = deps.cwdReleaseMarker?.() ?? null;
  
  if (!inWorktree) {
    // 状态 1: caller 已 ExitWorktree, 放过 (现有 claude builtin 路径)
  } else if (marker === worktreeReal) {
    // 状态 2: caller 持 MCP enter_worktree marker, 放过 (codex / 跨 adapter 路径)
  } else if (marker === null) {
    // 状态 3: caller cwd 在 worktree 内但无 marker → 走 claude builtin 路径但忘 ExitWorktree, reject
    return reject(`caller cwd inside worktree but no enter_worktree marker; must ExitWorktree first`);
  } else {
    // 状态 4: marker !== worktreeReal (marker 指向另一个 worktree)
    // 业务场景: codex teammate 在 worktree A 起 marker, 试图 archive worktree B → 不允许跨 worktree archive
    return reject(`caller marker (${marker}) does not match target worktree (${worktreeReal})`);
  }
  ```
- **状态 4 业务场景**：codex teammate 可能并发多个 plan / hand_off_session 起新 worktree 后误 archive 旧 plan；4 态明确区分

#### Step 1.5: 测试矩阵（≥ 8 case，v4 M2 加 re-allocate / fork rename）

**Files**：

- `src/main/store/session-repo/__tests__/cwd-release-marker.test.ts`（新建）：
  - TC1: upsert 后 setCwdReleaseMarker / clearCwdReleaseMarker / rowToRecord 投影正确
  - TC2: migration v020 idempotent
  - **TC2b: rename(fromId, toId) 后 cwdReleaseMarker 跟到 toId**（H1 修法测试）
- `src/main/agent-deck-mcp/__tests__/enter-exit-worktree.test.ts`（新建）：
  - TC3: enterWorktree 创建 worktree + setMarker → exitWorktree(action:'remove') 清 worktree + 清 marker
  - TC4: enterWorktree 路径冲突 → marker 不写 + 返回 err
  - TC5: base 优先级
- `src/main/agent-deck-mcp/__tests__/archive-plan.impl-cwd-marker.test.ts`（新建，4 态全覆盖）：
  - TC6: 状态 1 (caller 不在 worktree + 无 marker) → 放过
  - TC7: 状态 2 (caller 在 worktree + marker == worktreePath) → 放过（MCP 协议路径）
  - TC8: 状态 3 (caller 在 worktree + 无 marker) → reject（claude builtin 忘 ExitWorktree）
  - TC9: 状态 4 (caller 在 worktree + marker != worktreePath) → reject（跨 worktree archive）

#### Step 1.6: typecheck + ad-hoc dev 验证

- `pnpm typecheck`
- `pnpm dev` 起应用 → 手动跑一遍 enter_worktree → archive_plan 流程

### P2 caller_session_id transport 注入（~13 step，v4 H2/M3/M5/M6/L1/L2 修补）

> 本 phase 解 HIGH-1 caller_session_id transport 注入。Spike 1（HIGH-A）+ Spike 2（HIGH-B）修法同 commit batch 收口。

#### Step 2.1: 新建 mcp-session-token-map.ts（v4 M2 re-allocate 修补）

**Files**：

- `src/main/agent-deck-mcp/mcp-session-token-map.ts`（新建）：
  - 双向 map：`sessionToToken: Map<string, string>` + `tokenToSession: Map<string, string>`
  - `export function allocate(sessionId: string): string`：
    - **v4 M2 修法**：检查 `sessionToToken.get(sessionId)` 是否已有旧 token → 有则**先清旧反向 entry** `tokenToSession.delete(oldToken)`，再插新双向 map（防 re-allocate 同 sid 时旧 tokenToSession entry 残留）
    - 调 `crypto.randomUUID()` 生成新 token；插入双向 map；返回 token
  - `export function get(token: string): string | null`：tokenToSession.get(token) ?? null
  - `export function rename(oldSid: string, newSid: string): void`：原子迁移
  - `export function release(sessionId: string): void`：清双向 map 双 entry
  - `export function clearAll(): void`：测试 helper
  - **Global fallback token 仍保留**：process.env.AGENT_DECK_MCP_TOKEN（外部 codex CLI / 非应用 spawn 路径走 fallback；详 D1 §(b) fallback 命中策略）

#### Step 2.2: HookServer.onRequest mcp 分支改造（fastify 5 req.raw.auth 注入 + v4 M3 内嵌 mini-spike）

**Files**：

- `src/main/hook-server/server.ts` line 50 `/mcp` 前缀分支：
  - 改造：读 Authorization Bearer → 优先 `mcpSessionTokenMap.get(token)` 反查 sessionId
  - 命中 → `(request.raw as any).auth = { resolvedSid: sid, fallbackToGlobal: false }`
  - 不命中但等于 `mcpServerToken`（全局 token）→ `(request.raw as any).auth = { resolvedSid: null, fallbackToGlobal: true }`
  - 既不在 sessionTokenMap 也不等于 globalToken → 拒 401

**v4 M3 修法 — 内嵌 fastify 5 mini-spike acceptance test**（实施时一次性跑）：

- 在 P2 Step 2.2 落地前，写一个 mini-runner（`<worktree>/spike-reports/spike-p2-fastify5-mini.mjs`）：起 HookServer → 在临时 tool handler 内 `console.log(extra.authInfo)` → curl `-H "Authorization: Bearer <token>"` POST /mcp → 期望 stdout 拿到 `{resolvedSid: '<token-mapped-sid>', fallbackToGlobal: false}`
- mini-runner 跑通 → 写 `<worktree>/spike-reports/spike-p2-fastify5-mini.md` 记结论 → 进 Step 2.2 真实改造
- mini-runner 跑不通 → 调整 fastify 5 注入路径（如改 `request.context.config.auth` 等）→ 改 plan + 重试

#### Step 2.3: agent-deck-mcp/tools/index.ts callerSessionIdOverride 签名扩展

**Files**：

- `src/main/agent-deck-mcp/tools/index.ts` line 63-71 `BuildAgentDeckToolsDeps.callerSessionIdOverride`：
  - 现状：`(() => string | null) | null`
  - 改造：`((extra?: unknown) => string | null) | null`
- line 83-92 `makeCtx` 接受 `extra` 参数；调用 `callerSessionIdOverride?.(extra) ?? null`
- line 94-143 7 个 tool handler + P1 加的 2 个新 handler（enter_worktree / exit_worktree）改造为 `async (args, extra) => handler(args, makeCtx(args, extra))`

#### Step 2.4: transport-http.ts callerSessionIdOverride 实现

**Files**：

- `src/main/agent-deck-mcp/transport-http.ts` line 85-88：
  - 改造：`callerSessionIdOverride: (extra: any) => extra?.authInfo?.resolvedSid ?? null`
- in-process / stdio 维持现有行为（详 D1 三 transport 行为对照）

#### Step 2.5: codex bridge per-session 新建 Codex 实例（v4 H2/M5 关键修法，拆 5 sub-step）

**v3 单步「per-session Map cache」underspecified 真实改动量；v4 拆 5 sub-step**：

**Sub-step 2.5a — `sdk-bridge/index.ts` 字段重组**：

- 删 `private codex: Codex | null = null`（line 139 前的 field）
- 加 `private codexBySession: Map<string, Codex> = new Map()`（key = sessionId）

**Sub-step 2.5b — `ensureCodex(sessionId, sessionToken)` signature 改造**：

- 现状 line 139-165 `ensureCodex(): Promise<Codex>`（无参数）
- 改造：`ensureCodex(sessionId: string, sessionToken: string): Promise<Codex>`
  - 查 `codexBySession.get(sessionId)` 命中 → return（注意 sessionToken 已塞 envOverride，无需校验 token 一致性，session 内 token 不变）
  - 否则 `new sdk.Codex({ env: { ...process.env, AGENT_DECK_MCP_TOKEN: sessionToken }, codexPathOverride: ... })` → 写入 Map → return

**Sub-step 2.5c — `createSession` / `sendMessage` 路径 sid 时序（v4 H2 关键修法）**：

- 现状 `sdk-bridge/index.ts:212` `const codex = await this.ensureCodex();` 在拿 sid 前
- 改造 sid 时序：
  ```ts
  // (1) 应用层先 allocate tempSid 拿 token
  const tempSid = randomUUID();
  const sessionToken = mcpSessionTokenMap.allocate(tempSid);
  
  // (2) 用 tempSid + token 起 Codex 实例
  const codex = await this.ensureCodex(tempSid, sessionToken);
  
  // (3) 后续 startThread 拿 realSid
  const thread = codex.startThread(...);
  // 等 thread first event 拿到 real thread id (codex SDK 返)
  const realSid = await waitForRealThreadId(thread);
  
  // (4) 应用层 rename tempSid → realSid（sessionManager.renameSdkSession 内部会调 mcpSessionTokenMap.rename，不变量 7）
  sessionManager.renameSdkSession(tempSid, realSid);
  
  // (5) codexBySession Map 同步 rename key
  // 在 sessionManager.renameSdkSession 内部统一调（不变量 7 + 不在 caller 各自调）
  ```
- `codexBySession` rename 路径：作为 Sub-step 2.5d

**Sub-step 2.5d — `closeSession` 清 Map entry**：

- 现状 `sdk-bridge/index.ts:525 async closeSession(sessionId)`：清 sessions Map / recovering Map / thread-loop
- 改造：加 `this.codexBySession.delete(sessionId);` + 调 `mcpSessionTokenMap.release(sessionId)` 同步（参考 Step 2.8 invariant）

**Sub-step 2.5e — `setCodexCliPath` clear 整 Map**：

- 现状 line 131-137 `setCodexCliPath()` 清 `this.codex = null` + 调 `invalidateCodexInstance()`（oneshot pool）
- 改造：`this.codexBySession.clear();` + invalidateCodexInstance()
- **注意**：已 spawn 中的 codex 子进程不受影响（spike 2 §1 实证 envOverride 已 frozen 到子进程 env，bridge.codexBySession Map 清空只让下次 ensureCodex 重建实例）

**`codex-instance-pool.ts` 与 bridge per-session Map 边界（v4 M5 明示）**：

- pool 仅服务 **oneshot caller**（summarizer-runner / handoff-runner），不需要 per-session token，沿用全局 process.env 路径
- bridge 服务 **live session**，per-session Codex 实例 + per-session token（mcp 协议 caller 反查）
- 两套 cache 实质需求不同（oneshot 不需要 mcp，live bridge 必须 mcp），不强行合并（codex-instance-pool.ts 头注释已明示，沿用）

#### Step 2.6: agent-deck-mcp-injector.ts 验证（v4 M1 共存策略落地）

**Files**：

- `src/main/codex-config/agent-deck-mcp-injector.ts`：现状 `buildAgentDeckMcpConfigForCodex` 写 `bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN'`
- 改造：**保留 bearer_token_env_var 不变**（D1 §(a) 共存语义）— codex CLI 子进程读 env var 拿 token，无论 env var 是 envOverride 注入（per-session 路径）还是 main bootstrap 全局设（fallback 路径）
- 删 `setAgentDeckMcpTokenEnv()` setter（D1 §(c) 全局 token 一次性设，运行时不再 mutate）
- 加 unit test 验证 codex config 段含 `bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN'`

#### Step 2.7: codex CLI MCP server entry 配置实地检查（Spike 2 残留）

**手工 spike-style 验证**（P2 实施时一次性跑）：

- 跑应用 → 起一个 codex teammate session → 看 spawn 出的 codex 子进程 `~/.codex/config.toml` 实际 mcp_servers.agent-deck 段内容
- 关键问题：codex CLI MCP client 怎么读 `AGENT_DECK_MCP_TOKEN` env 注入 HTTP Authorization header？
  - 选项 A：codex 自动透传所有 process.env 给 mcp client
  - 选项 B：需要 config 显式 binding（`headers = { Authorization = "Bearer ${env:AGENT_DECK_MCP_TOKEN}" }` 类似）
- 选项 B 命中 → 改 `agent-deck-mcp-injector.ts` 拼这段 config；选项 A 命中 → 无需改
- **输出**：在 worktree 内写 `spike-reports/spike-p2-codex-mcp-entry.md` 记录实测结论

#### Step 2.8: sessionManager.renameSdkSession 集成 mcpSessionTokenMap.rename（v4 L1/M6 修法）

**v4 修订 — 改名 + 集成统一进函数体**：

**Files**：

- `src/main/session/manager.ts:432-449` `renameSdkSession(fromId, toId)`（不是 `shutdownSession`，v3 L1 名称错）：
  - 现状已原子 transfer sdkOwned / 调 sessionRepo.rename / emit `session-renamed`
  - **v4 M6 修法**：函数体末尾加：
    ```ts
    mcpSessionTokenMap.rename(fromId, toId);
    // codex adapter 路径同步 rename codexBySession Map key
    if (toRecord?.agentId === 'codex-cli') {
      codexCliBridge.renameCodexInstance(fromId, toId);  // sdk-bridge.ts 加这个 public method
    }
    ```
- claude vs codex 调用语义对照表：

  | adapter | 调用路径 | 走 mcpSessionTokenMap |
  |---|---|---|
  | claude-code | SDK fallback tempKey→realId | **不走**（claude 在 in-process MCP transport，closure override，不走 token map） |
  | codex-cli | thread-loop.ts CLI 隐式 fork OLD→NEW first event | **走**（codex 在 HTTP MCP transport，必须 rename per-session token map） |

- **关键**: renameSdkSession 函数体内**统一**调 mcpSessionTokenMap.rename（不变量 7）；caller（thread-loop.ts / sdk-bridge recoverer）不需各自调

#### Step 2.9: sessionManager.close 集成 mcpSessionTokenMap.release（v4 L1 修正命名）

**Files**：

- `src/main/session/manager.ts:277` `async close(sessionId)`（不是 shutdownSession）
- 改造：末尾加 `mcpSessionTokenMap.release(sid)` 清 token map
- codex 路径同步：函数体内调 `codexCliBridge.closeSession(sid)` 时 sub-step 2.5d 已经清 codexBySession + release token

#### Step 2.10: 测试矩阵（≥ 8 case，v4 M2/L2/M7 race / leak case 全覆盖）

**Files**：

- `src/main/agent-deck-mcp/__tests__/mcp-session-token-map.test.ts`（新建）：
  - TC1: allocate / get / release 双向 map 一致性
  - TC2: rename oldSid → newSid 后 get(token) 返回 newSid
  - TC3: release(sid) 后 get(token) 返回 null
  - **TC3b: re-allocate same sid → 旧 token tokenToSession entry 清干净，新 token 生效**（M2）
  - **TC3c: 并发 allocate 两个 sid → token 唯一**（randomUUID 并发安全）
- `src/main/agent-deck-mcp/__tests__/transport-http-extra-auth.test.ts`（新建）：
  - TC4: HTTP transport extra.authInfo.resolvedSid 正确反查
  - **TC4b: fallback global token 时 resolvedSid=null + fallbackToGlobal=true → spawn_session 被 EXTERNAL_CALLER_ALLOWED 拦截**（D1 §(b) 测试）
- `src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts`（新建，仿 spike2-runner 架构）：
  - TC5: 多 codex session per-session token 不串（**改用中性变量名 `SPIKE_LABEL` 而非 `AGENT_DECK_MCP_TOKEN`，避撞 v3 L2 codex 拒读 TOKEN 字样**；通过 startThread Bash echo $SPIKE_LABEL 验证子进程 env）
  - TC6: 外部 codex CLI fallback 走 globalToken（mcpSessionTokenMap.get 返 null → fallbackToGlobal: true）
  - TC7: sessionId rename (SDK CLI 隐式 fork) → mcpSessionTokenMap.rename + codexBySession Map rename 在 renameSdkSession 函数体内统一调
  - **TC7b: session close → token map 应清空 + codexBySession Map 删 entry**（M7 内存泄漏）

**注意 better-sqlite3 binding ABI**（项目 CLAUDE.md 末尾踩坑）：跑 SQLite 真测前后必须保护 binding。优先走 task-repo.test.ts 顶部的 binding 自检 skip 守门。

#### Step 2.11: codex receiveTeammateMessage E2E wire prefix 端到端测试

**Files**：

- `src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts`（新建）：
  - TC8: spawn claude lead + codex teammate（同 team）→ lead send_message → universal-message-watcher dispatch → codex bridge.receiveTeammateMessage 加 wire prefix → codex SDK emit user-role message → codex 子进程拿到 prompt 顶部 `[from <name> @ claude-code][msg <id>][sid <senderSid>]` 正确

#### Step 2.12: 撤 D6 hand_off_session schema deny（推到 P5）

P5 Step 5.1 一起撤。

### P3 spawn agent_name 按 adapter 路由 + codex-config 骨架（~12 step，v4 H3/H5/H6/M7 修补）

> 本 phase 解 HIGH-2 + HIGH-4。

#### Step 3.1: 新建 resources/codex-config/ 骨架（v4 同步加 package.json extraResources）

**Files**：

- `mkdir -p resources/codex-config/agent-deck-plugin/agents/`
- `resources/codex-config/CODEX_AGENTS.md`（P3 阶段建空 placeholder，内容 P4 写）
- `package.json` `build.extraResources` 加 `resources/codex-config` 目录（与现有 `resources/claude-config` 同款）—— 保证打包后 prod 路径找得到（详 D5 fallback 策略）

#### Step 3.2: getAgentDeckPluginPath 拆 adapter-aware（v4 H5 改造点全列表）

**Files**：

- `src/main/adapters/claude-code/sdk-injection.ts` line 53-58 `getAgentDeckPluginPath()`：
  - 改名为 `getClaudeAgentDeckPluginPath()`（沿用现状路径）
- 新增（同文件或新建 `src/main/adapters/codex-cli/codex-config-paths.ts`）：
  - `getCodexAgentDeckPluginPath()`：返 `<resourcesPath>/codex-config/agent-deck-plugin/`（prod）/ `<repo>/resources/codex-config/agent-deck-plugin/`（dev）
- 新增 helper：`getAgentDeckPluginPathForAdapter(adapter: 'claude-code' | 'codex-cli'): string`（switch 分发）
- `getAgentDeckPluginsForSession()` (sdk-injection.ts:71-74) **保留 claude-code only 行为**：codex SDK 没有 plugins[] 字段（走 ~/.codex/AGENTS.md 注入 + ~/.codex/agents/ 目录），不通用化 signature

#### Step 3.3: bundled-assets.ts multi-root 支持 + AssetMeta adapter 字段（v4 H5 全调用点改造）

**Files**：

- `src/main/bundled-assets.ts`:
  - line 21 import 改：`import { getClaudeAgentDeckPluginPath, getCodexAgentDeckPluginPath } from '...';`
  - `loadBundledAssets()` line 34-43 双 root 遍历（claude-code root + codex-cli root），结果 merge 到 snapshot
  - **AssetMeta 加 `adapter: 'claude-code' | 'codex-cli'` 字段**（`@shared/types`）
  - **qualifiedName 加 adapter 前缀**：`agent-deck:<adapter>:<name>`（如 `agent-deck:codex-cli:reviewer-claude`）— 避免同名 agent 跨 root 冲突
  - `getBundledAssetContent(kind, name, adapter)` line 50 加 adapter 参数（**breaking change，所有 caller 同步改**）
  - `getBundledAssetPath(kind, name, adapter)` line 64 加 adapter 参数

#### Step 3.4: 所有 caller 同步加 adapter 参数（v4 H5 显式列表）

**Files**：

- `src/main/agent-deck-mcp/tools/handlers/spawn.ts:74-80`：`getBundledAssetContent('agent', args.agent_name, args.adapter)` 按 args.adapter 路由
- `src/main/ipc/assets.ts:125-130` `AssetsGetContent` handler：
  - 现状：`(_e, kindArg, nameArg, sourceArg)` 三参数
  - 改造：`(_e, kindArg, nameArg, sourceArg, adapterArg)` 四参数；parse adapter 后调 `getBundledAssetContent(kind, name, adapter)`
  - 同步加 `AssetsRevealInFolder` / `AssetsGetPath` 等同款 IPC handler（如有）
- `src/preload/api/assets.ts` IPC facade：加 adapter 参数透传
- `src/renderer/components/AssetsLibraryDialog.tsx:145` 调用 `window.api.assetsGetContent(...)` 加 adapter 参数（从 AssetMeta.adapter 字段拿）
- `src/shared/ipc-channels.ts` Assets IPC schema：加 adapter 参数（zod）
- **测试**：含 ipc/assets.ts unit test + AssetsLibraryDialog UI 渲染双 adapter 资产分组

#### Step 3.5: spawn handler 按 adapter 路由 + codex teammate spawn default enforce 提到 options-builder 层（v4 H3/H6 修法）

**v4 修订 — 信号源用 args.adapter + args.agent_name，enforce 点在 options-builder.ts，禁 bridge 默认 hardcode**：

**Files**：

- `src/main/agent-deck-mcp/tools/handlers/spawn.ts` Step 3.4 已改 agent_name 按 adapter 路由
- **`src/main/adapters/options-builder.ts:79-88` `narrowToCodexOpts(raw: CreateSessionOptionsRaw): CodexCreateOpts`**：
  - 现状：现 4 字段（cwd / prompt / resume / codexSandbox / model / extraAllowWrite 等）
  - 改造：扩接受 `agent_name` 字段（caller 透传）；按 `agent_name in ['reviewer-claude', 'reviewer-codex']` 触发 default spread：
    ```ts
    function narrowToCodexOpts(raw: CreateSessionOptionsRaw): CodexCreateOpts {
      const out: CodexCreateOpts = { cwd: raw.cwd };
      // ... 现有字段
      
      // v4 H6: codex teammate spawn default enforce
      if (raw.agentName === 'reviewer-claude' || raw.agentName === 'reviewer-codex') {
        out.codexSandbox = 'workspace-write';  // 强制 (caller 显式覆盖? — Plan 决策: 不允许覆盖, agent_name reviewer-* 路径必须走 workspace-write)
        out.approvalPolicy = 'never';
        out.networkAccessEnabled = true;
        out.additionalDirectories = [
          path.join(os.homedir(), '.claude'),
          path.join(os.homedir(), '.codex'),
        ];
        
        // v4 M7: reviewer-claude wrapper 路径加 AGENT_DECK_CLAUDE_PATH env
        if (raw.agentName === 'reviewer-claude') {
          out.envOverrideExtra = {
            AGENT_DECK_CLAUDE_PATH: resolveBundledClaudeBinary(),
          };
        }
      }
      return out;
    }
    ```
- **`src/main/adapters/types.ts:141` `CodexCreateOpts` 接口**：扩展加可选字段 `approvalPolicy?: 'never' | 'on-request'`, `networkAccessEnabled?: boolean`, `additionalDirectories?: string[]`, `envOverrideExtra?: Record<string, string>`
- **`src/main/adapters/codex-cli/sdk-bridge/index.ts:241-247` `startThread()` 字段**：
  - 现状 hardcode 4 字段（workingDirectory / sandboxMode / approvalPolicy / skipGitRepoCheck）
  - 改造：从 opts 读 approvalPolicy / networkAccessEnabled / additionalDirectories（如果 opts 没传，沿用现有 default — `approvalPolicy: 'never'` 等）
  - **关键**：bridge 不主动 enforce default — 让 options-builder 层决定（保证 lead 路径 / 普通 codex session 不被污染）
- `resolveBundledClaudeBinary()` helper 新建（与 `resolveBundledCodexBinary()` 同模式，在 `src/main/adapters/claude-code/` 下新文件）

#### Step 3.6: agents-md-installer 源切换（v4 D5 fallback 策略）

**Files**：

- `src/main/codex-config/agents-md-installer.ts:71-77` `getBuiltinAgentsMdContentPath`：
  - 改造：返 `codex-config/CODEX_AGENTS.md`
- `getBuiltinAgentsMd()` line 100+ fallback 链：
  - 加显式 error throw — `codex-config/CODEX_AGENTS.md` 不存在 → throw new Error('codex-config/CODEX_AGENTS.md missing, build/dev config error')
  - **禁** silently fallback 到 claude-config/CLAUDE.md（D5 fallback 策略）
- 测试：codex AGENTS.md 内容来自 codex-config 源

#### Step 3.7: skills-installer.ts multi-source 支持（P3 阶段不动）

P3 阶段先保留单源，P4 Step 4.4 决策是否真要 multi-source。

#### Step 3.8: main bootstrap 启动顺序检查

`src/main/index.ts` step 8.5（bundled-assets cache 预热）：保证 multi-root 扫描在 spawn handler 第一次调用前完成。

#### Step 3.9: 测试矩阵（≥ 6 case，v4 H4 矩阵 vs TC 对齐）

**Files**：

- `src/main/__tests__/bundled-assets-multi-root.test.ts`（新建）：
  - TC1: scan claude-config + codex-config 双 root，snapshot 含两 adapter 各自 agents
  - TC2: `getBundledAssetContent('agent', 'reviewer-claude', 'claude-code')` vs `('agent', 'reviewer-claude', 'codex-cli')` 返回不同内容
- `src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts`（新建）：
  - **v4 H4 修法：TC 与 D3 矩阵严格对齐**
  - TC3: claude lead spawn codex teammate（args: `{adapter:'codex-cli', agent_name:'reviewer-codex'}`）→ 找 codex-config/.../reviewer-codex.md
  - TC4: codex lead spawn claude wrapper teammate（args: `{adapter:'codex-cli', agent_name:'reviewer-claude'}`）→ 找 codex-config/.../reviewer-claude.md（**不是** claude-config；与 D3 矩阵第 4 行对齐）
  - TC5: claude lead spawn claude teammate（args: `{adapter:'claude-code', agent_name:'reviewer-claude'}`）→ 找 claude-config/.../reviewer-claude.md（D3 矩阵第 1 行）
  - TC6: claude lead spawn reviewer-codex teammate via claude wrapper（args: `{adapter:'claude-code', agent_name:'reviewer-codex'}`）→ 找 claude-config/.../reviewer-codex.md（D3 矩阵第 2 行）
  - TC7: agent_name 在错 adapter root 下不存在 → err
- `src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts`（新建）：
  - TC8: spawn args `{adapter:'codex-cli', agent_name:'reviewer-codex'}` → options-builder spread 4 项 unsafe default + envOverrideExtra={AGENT_DECK_CLAUDE_PATH:?} 不含（不是 reviewer-claude）
  - TC9: spawn args `{adapter:'codex-cli', agent_name:'reviewer-claude'}` → options-builder spread 4 项 unsafe default + envOverrideExtra.AGENT_DECK_CLAUDE_PATH 有值
  - TC10: spawn args `{adapter:'codex-cli', agent_name: null}`（普通 codex session 用户起的 lead）→ options-builder 不 spread unsafe default

#### Step 3.10: claude 端回归测试

- 现有 `tools.test.ts` 等保证 zero regression（claude 端不动 sdk-bridge / adapter logic）
- AssetsLibraryDialog UI 显示双 adapter assets（手工 ad-hoc 验证）

#### Step 3.11: typecheck + dev 验证

- pnpm typecheck
- pnpm dev → 起 codex teammate spawn 看 startThread 真实 option 含 4 项 unsafe default

### P4 codex 视角资产内容（纯写作，~7 step，v4 加 4.0 mini-spike + 4.3 改 env var）

> 本 phase 解 HIGH-2 + HIGH-4 内容侧。

#### Step 4.0: Mini-spike — claude -p 内部 Bash tool 在 codex sandbox 嵌套层下是否跑通（v4 L4 修法）

**问题**：spike 3 实测 codex sandbox workspace-write 内 spawn `claude -p "say hi"` 返回 "你好"（33s），但**没测 claude 内部跑 Bash 工具调用 / read fs / write fs / spawn 子进程**。claude CLI 在 codex 子 sandbox 内 spawn，claude 内部 Bash tool 会再起一层 sandbox-exec，嵌套场景未实证。

**方案**：
- 写 `<worktree>/spike-reports/spike4-claude-nested-sandbox.mjs`（仿 spike3-runner.mjs 架构）
- 启 codex SDK 实例 sandbox=workspace-write + additionalDirectories=['~/.claude', '~/.codex', '/tmp']
- 让 codex 内 Bash 起 `claude -p "请帮我跑 ls /tmp 并把结果输出"` → 看 claude 是否能调 Bash tool 跑 ls 拿结果
- 失败模式：claude 内 Bash 撞 sandbox / claude 内 Read fs 拒绝 / claude 主动放弃工具调用 fallback 纯文本
- **结论分流**：
  - PASS → 进 Step 4.3（reviewer-claude.md wrapper 正常写）
  - FAIL → 决策：要么调整 reviewer-claude wrapper 让 claude 只跑 oneshot 文本 review 不用工具（功能阉割但仍 feasible）；要么 claude CLI 用 `--dangerously-skip-permissions` / `--no-sandbox` 类似 escape hatch（如有），让 claude 内部 Bash tool 不再 sandbox（claude SDK 实际可能没有此 flag → 那 reviewer-claude wrapper 只能限「纯文本 review，不用工具」）
- 输出：`<worktree>/spike-reports/spike4-claude-nested-sandbox.md`

#### Step 4.1: 写 resources/codex-config/CODEX_AGENTS.md（协议层 codex 视角）

详 v3 同款。

#### Step 4.2: 写 resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md（codex SDK teammate body）

详 v3 同款。

#### Step 4.3: 写 resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md（codex wrapper body，v4 M7 用 env var）

**v4 修订 — Bash 模板用 `$AGENT_DECK_CLAUDE_PATH` env var**：

```bash
# 由 options-builder.ts 在 spawn 时注入 envOverride
$AGENT_DECK_CLAUDE_PATH -p < /tmp/<input>.txt > /tmp/<output>.txt 2>&1
```

- 主进程 `resolveBundledClaudeBinary()` 返打包后内置 claude SDK 的绝对路径（与 `resolveBundledCodexBinary` 同模式）
- options-builder.ts narrowToCodexOpts 在 agent_name='reviewer-claude' 路径下 spread `envOverrideExtra: {AGENT_DECK_CLAUDE_PATH: resolveBundledClaudeBinary()}`
- bridge.ts createSession 把 `opts.envOverrideExtra` 合并进 `new Codex({env: {...process.env, ...opts.envOverrideExtra}})`
- codex 子进程拿到 env var → reviewer-claude.md prompt 内 Bash 用 `$AGENT_DECK_CLAUDE_PATH` 引用
- **如果 Step 4.0 mini-spike 失败**：调整 wrapper 内容限「纯文本 review，不用工具」

#### Step 4.4: codex 视角 SKILL 差异处理

当前阶段不写差异 SKILL（D3 修订），留 placeholder。

#### Step 4.5: 应用打包 CLAUDE.md（`resources/claude-config/CLAUDE.md`）加 enter_worktree MCP tool 引用说明

详 v3 同款。

#### Step 4.6: 内容自检 — 走「提示词资产维护」6 步

详 v3 同款。

### P5 收尾（~7 step，v4 L3 加 smoke test）

#### Step 5.1: 撤 D6 临时 schema deny

#### Step 5.2: 双对抗 review P1-P4 改动

#### Step 5.3: fix review finding

#### Step 5.4: typecheck + build

- `pnpm typecheck` 必跑
- `pnpm build` 大改动跑

#### Step 5.4.5: Pre-archive smoke test（v4 L3 修法）

- `pnpm dev` 起应用
- 起 codex teammate spawn（args: `{adapter:'codex-cli', agent_name:'reviewer-codex', team_name:'<test-team>', cwd:<worktree>}`）
- 跑 reviewer-codex teammate oneshot review 任一文件
- 看：
  - stdout 拿到 review finding 文本响应（不卡在 spawn / sandbox 拒绝阶段）
  - 主进程 console 无 error / warn
  - codex 子进程 mcp 调用（list_sessions 等）能成功（per-session token 真的注入子进程 env）
- 失败 → 回到 P3 / P4 修补 → 重跑

#### Step 5.5: 写 CHANGELOG_<next>

#### Step 5.6: archive_plan（推迟到 P6.8 — 见下方 P6 章节）

P5 收尾后**不立即 archive_plan**；本 plan 有 P6（流程改进）需在 archive 前完成。archive_plan 时序统一移到 P6.8（CHANGELOG csv 含 P5+P6 两个）。

## v4.1 修订点（相对 v4，对应 P6 light review 11 条 finding）

**HIGH（3 条修补）**：
- ✅ H1 user CLAUDE.md 直 Edit 缺授权 + backup + dry-run diff → P6.1 拆 4 sub-step（a dry-run / b ack / c backup / d Edit）
- ✅ H2 SKILL 重命名兼容方案 / chicken-egg 物理 mv 时序 → P6.4 拆 a/b（保留 deep-code-review/ 目录）+ P6.7 拆 a/b/c/d（user confirm 后才物理 mv + 加 deprecation stub）
- ✅ H3 P6.5 老 SKILL 没 auto cp + SCOPE PATH MISMATCH → P6.5 明示老 SKILL 仍叫 deep-code-review（不撞 mismatch）+ caller 走 P6.4b auto cp 落地（兜底 caller 手动 cp）

**MED（6 条修补）**：
- ✅ M1 P6.3 漏 P4 codex-config 2 reviewer body → P6.3 覆盖 4 file（claude-config 2 + codex-config 2）+ claude vs codex 两视角 sandbox 说明分别提供
- ✅ M2 P6.8 archive_plan 缺 ExitWorktree 前置 → P6.8 拆 3 sub-step（worktree 预检 → ExitWorktree(keep) → archive_plan）+ 接力会话场景说明
- ✅ M3 触发条件汇总丢 bullet 2 → §P6 RFC 决策汇总 §触发条件 改成「保留 bullet 1 + bullet 2 不动，bullet 1 内扩展子条件，新增 bullet 3」
- ✅ M4 auto sandbox cache 命名冲突 + 并发踩 → 统一 `<sha8>-<sanitized-basename>.md` + invocation-id manifest + cleanup 按 manifest 精确 rm
- ✅ M5 P5 推迟 archive_plan 没写 P5 收尾门 + 接力分支 → §当前进度 加 P5/P6 checkpoint + §下一会话第一步 加分支
- ✅ M6 kind='mixed' 模板成本 / 失败兜底 → §P6 RFC + P6.4 加成本明示 2x token + 2x time + 任一 reviewer fail 不阻塞、缺失方 finding 降级单方非 HIGH

**LOW（2 条修补）**：
- ✅ L1 P6.6 验证项窄 → 加 3 条 smoke（新名 plan review + auto cp + reviewer body sandbox 节生效）+ dev 重启提示
- ✅ L2 SKILL.md 内嵌模板 vs ~/.claude/templates/ 关系不清 → §已知踩坑 加条 13 明示两份独立维护（plugin self-contained vs user 全局）

## v4 修订点（相对 v3，对应 17 条 finding）

**HIGH（6 条修补）**：
- ✅ H1 rename.ts 漏 cwd_release_marker 列 → P1 Step 1.1 加 rename.ts 20 列扩展 + toExists UPDATE 覆盖块 + TC2b
- ✅ H2 ensureCodex 无 sid 时序 → P2 Step 2.5c 写清「先 allocate(tempSid) → new Codex → startThread → real sid rename」5 步时序
- ✅ H3 spawnedBy 反向信号源 → 加 D7「lead vs teammate 信号源约定」+ P3 Step 3.5 用 args.adapter + args.agent_name 触发 default
- ✅ H4 D3/P3/P4 reviewer-claude 矩阵矛盾 → D3 矩阵补「spawn args 确切」列明示 + P3 Step 3.9 TC4 修正 args.adapter='codex-cli'
- ✅ H5 multi-root scan 改造点多 → P3 Step 3.2-3.4 拆分 + 显式列 ipc/assets.ts:125 / preload / renderer / AssetsLibraryDialog.tsx:145 / IPC schema 5 处改造点
- ✅ H6 codex teammate spawn option 不能 hardcode bridge → 不变量 6 修订 enforce 点 = options-builder 层 + P3 Step 3.5 落地

**MED（7 条修补）**：
- ✅ M1 token 共存策略未写 ADR → D1 加 ADR 三态明示 (a)(b)(c)
- ✅ M2 mcp-session-token-map.allocate re-allocate 漏清 → P2 Step 2.1 allocate 检查旧 token 先清反向 entry + TC3b
- ✅ M3 fastify 5 端到端未实跑 → P2 Step 2.2 内嵌 mini-spike acceptance test（spike-p2-fastify5-mini）
- ✅ M4 archive_plan 改 handler vs impl 不清 → P1 Step 1.4 拆 sub-step 1.4a (handler) + 1.4b (impl) 各自 line refs
- ✅ M5 ensureCodex 改造超 line:139 单点 → P2 Step 2.5 拆 5 sub-step (a-e) + 与 codex-instance-pool 边界明示
- ✅ M6 rename 必须进 renameSdkSession 函数体 → 加不变量 7 + P2 Step 2.8 改名 close + 函数体内调
- ✅ M7 reviewer-claude wrapper claude path resolution → 加 `resolveBundledClaudeBinary()` helper + options-builder 注入 `AGENT_DECK_CLAUDE_PATH` envOverrideExtra + P4 Step 4.3 改 `$AGENT_DECK_CLAUDE_PATH`

**LOW（4 条修补）**：
- ✅ L1 sessionManager.shutdownSession 不存在 → P2 Step 2.8/2.9 改名 sessionManager.close + 函数体调
- ✅ L2 codex 拒读 TOKEN 字样 → P2 Step 2.10 TC5 改用中性变量名 SPIKE_LABEL
- ✅ L3 P5 漏 pre-archive smoke test → P5 加 Step 5.4.5 pre-archive smoke test
- ✅ L4 ❓ claude -p 内部跑 Bash tool 嵌套 sandbox 未验证 → 加 Step 4.0 mini-spike，结果分流决策

## v3 修订点（相对 v2，保留供追溯）

[v3 已废弃，详 v3 同款节内容，不重复]

## v2 修订点（相对 v1，保留供追溯）

[v2 已废弃，详 v2 同款节内容，不重复]

## 当前进度

- ✅ P0 完成
- ✅ P-1 Spike 1/2/3 完成
- ✅ P0.5 plan v3 重写完成（v3 → 668 行）
- ✅ P0.5 plan v3 双对抗 review 完成（6 HIGH + 7 MED + 4 LOW = 17 finding）→ v4 修补
- ✅ P0.5 plan v4 P6 增加 + 3 轮 RFC（user 对齐 design 大方向 + 实施细节）
- ✅ P0.5 plan v4 P6 light review 完成（3 HIGH + 6 MED + 2 LOW = 11 finding）→ v4.1 修补（本文件原地升级）
- ✅ **P1 Step 1.1 完成（2026-05-18 by session 9bf392ec）**：
  - 新建 `src/main/store/migrations/v020_sessions_cwd_release_marker.sql`（worktree 内）
  - 改 `src/main/store/migrations/index.ts` 注册 v020
  - 改 `src/main/store/session-repo/types.ts` Row + rowToRecord 加 cwd_release_marker 列
  - 改 `src/shared/types/session.ts` SessionRecord 加 cwdReleaseMarker（含完整 4 态分流 jsdoc + H1 修法说明）
  - 改 `src/main/store/session-repo/core-crud.ts` upsert INSERT/UPDATE/binds 三处加 cwd_release_marker + 新增 setCwdReleaseMarker / clearCwdReleaseMarker setter
  - 改 `src/main/store/session-repo/rename.ts` 19 → 20 列扩展 + toExists UPDATE 覆盖块加 cwd_release_marker 分支（H1 关键修法 — 两条 fallback 路径都不丢 marker）
  - `pnpm typecheck` 0 错误
  - commit `331d01a` 在 worktree branch `worktree-codex-handoff-team-alignment-20260518`
  - **未做（推 Step 1.5）**：测试用例（TC1 / TC2 / TC2b 等 ≥ 8 case）
  - **未做（推 Step 1.6）**：ad-hoc dev 验证
- ✅ **P1 Step 1.2 完成（2026-05-18 by session 9bf392ec）**：
  - 改 `src/main/agent-deck-mcp/tools/schemas.ts` 加 ENTER_WORKTREE_SCHEMA / EXIT_WORKTREE_SCHEMA + Args + Result interface（含 5 态 baseSource enum 表明 D2 优先级链命中哪个来源）
  - 改 `src/main/agent-deck-mcp/types.ts` AGENT_DECK_TOOL_NAMES 7 → 9 tool（加 enterWorktree / exitWorktree）+ EXTERNAL_CALLER_ALLOWED 同步加两个 false
  - `pnpm typecheck` 0 错误（EXTERNAL_CALLER_ALLOWED Record 强制穷举校验通过）
  - commit `eac9bb7` 在 worktree branch
  - **未做（留 Step 1.3）**：handler 实现 + tools/index.ts 注册
- ✅ **P1 Step 1.3 完成（2026-05-18 by session 9bf392ec）**：
  - 新建 `handlers/enter-worktree.ts` + `handlers/enter-worktree-impl.ts` (240 行) — 含 5 态 base 优先级 + 路径/branch 存在性预检 + setMarker
  - 新建 `handlers/exit-worktree.ts` + `handlers/exit-worktree-impl.ts` (220 行) — 含 keep/remove 双 action + dirty 预检 + 保护分支清单 + idempotent 边角
  - 改 `tools/index.ts` 注册 2 个新 tool (含完整 description)
  - 修 isError type guard 签名 `EnterWorktreeImplResult|Error` 太窄 → 改 unknown discriminated check
  - `pnpm typecheck` 0 错
  - commit `0d08b1c` 在 worktree branch
- ✅ **P1 Step 1.4 完成（2026-05-18 by session 9bf392ec, HIGH-C 修法）**：
  - `archive-plan-impl.ts` 老 2 态 cwd 预检 → 新 4 态分流（plan §不变量 5 + D2）
  - `ArchivePlanDeps` 加 `cwdReleaseMarker?: () => string | null` (DEFAULT 返 null 兼容老路径)
  - `archive-plan.ts` handler resolveCallerCwdDeps 扩注入 marker（与 cwd 同 row read 复用）+ mergeCallerCwd 处理两字段独立优先级
  - 4 态 markerReal realpath 解析对齐 worktreeReal 防 symlink false-negative
  - `pnpm typecheck` 0 错 + archive-plan.impl-core (12/12) / impl-r33 / impl-ff-merge-body / impl-followup-20260515 (50/50) 0 regression
  - commit `23f7b41` 在 worktree branch
- ✅ **P1 Step 1.5 完成（2026-05-18 by session 9bf392ec, 测试矩阵 29 cases ≥ 8 要求）**：
  - `archive-plan.impl-cwd-marker.test.ts` 5 cases (TC6/7/8/9 + TC10 symlink) — 5/5 pass
  - `enter-exit-worktree.test.ts` 17 cases (TC3-5 enter + 7 exit 边角) — 17/17 pass
  - `cwd-release-marker.test.ts` 7 cases (TC1/2/2b set/clear/projection + migration + rename 两条分支) — binding skip 守门触发（local Node 23 binding ABI 130 mismatch；CI/prod Electron 33 binding 一致能跑）
  - 附带架构修法：enter/exit-worktree-impl.ts 去掉 sessionRepo import 防 electron load + DEFAULT_DEPS 故意抛 hint error 防 silently no-op + impl 控制流 reorder（worktree path/branch 存在性预检提到 base resolution 前短路 reject）
  - 新建 `store/session-repo/__tests__/_setup.ts` (binding probe + makeMemoryDb 载到 v001-v020) — 独立维护不动共享 `agent-deck-repos/_setup.ts` 避免 team/message 测试 regression
  - commit `782a0fc` 在 worktree branch
- ⏳ **P1 Step 1.6 推后**：typecheck 已通过 N 次；ad-hoc dev 验证受 electron-rebuild postinstall 阻塞（Python distutils 缺失），不影响 P2 推进，**推到 P5 Step 5.4.5 pre-archive smoke test 一起跑**（届时需先解 Python 环境问题或切 Python 3.11 跑 pnpm install）
- ⏳ **P1 全 phase 完成（除 Step 1.6 推后 smoke test）**：HIGH-C cwdReleaseMarker 数据流断已通解，codex / 跨 adapter caller 走 mcp enter_worktree 路径起 worktree 后能正常 archive_plan
- ✅ **P2 Step 2.1 完成（2026-05-18 by session 2060bb28）**：
  - 新建 `src/main/agent-deck-mcp/mcp-session-token-map.ts` (137 行) — 双向 Map sessionToToken / tokenToSession（module-level 单例）
  - 5 个 export：allocate (含 v4 M2 防 re-allocate 残留：先清旧 token 反向 entry 再插新双向 map) / get / rename (不变量 7：必须由 sessionManager.renameSdkSession 函数体统一调) / release / clearAll (测试 helper)
  - 全局 fallback token (process.env.AGENT_DECK_MCP_TOKEN) 仍保留：外部 codex CLI / 非应用 spawn 路径走 fallback → HookServer 比对 mcpServerToken → fallbackToGlobal=true → handler 视为 external caller (EXTERNAL_CALLER_ALLOWED 表 spawn/send/shutdown 全 deny)
  - `pnpm typecheck` 0 错
  - 现有测试 archive-plan-followup (50/50) + tools (46/46) 0 regression；其他 5 file/9 case 失败全是「Electron failed to install correctly」postinstall 环境问题（plan §当前进度本会话发现的 Python distutils 阻塞），与 Step 2.1 无关
  - commit `2e136e3` 在 worktree branch
- ✅ **P2 Step 2.2 完成（2026-05-18 by session 2060bb28）**：
  - **mini-spike acceptance test**（v4 M3）：写 `spike-reports/spike-p2-fastify5-mini.mjs`（111 行）端到端实跑 fastify 5.8.5 onRequest 写 `request.raw.auth` → mcp-sdk 1.29.0 `StreamableHTTPServerTransport.handleRequest` 读 `req.auth` → tool handler `extra.authInfo` 通路 ✅ PASSED（解 Spike 1 残留风险）。结论 `spike-reports/spike-p2-fastify5-mini.md`
  - mini-spike 用 mcp-sdk Client + StreamableHTTPClientTransport 真起 client 连本地 fastify server，双向断言（client-visible result.content + server-side outer scope 同步）防 client 缓存假阳性
  - mini-runner 通过绝对路径 import 解决 pnpm 严格模式下 mcp-sdk transitive dep 不 hoist 到顶层 node_modules 的问题（应用层 transport-http.ts:29-31 同款 dynamicImport 路径）
  - 改 `src/main/agent-deck-mcp/types.ts` 新增 `McpAuthInfo` interface（HookServer ↔ transport-http ↔ tools 共享契约，三态语义文档化）
  - 改 `src/main/hook-server/server.ts` /mcp 分支：新增 `checkMcpAuth` 私有方法替代 老 checkAuth 调用，实现三态分流 `(1) per-session token map 命中 → {resolvedSid, fallbackToGlobal:false} (2) 不命中但等于全局 mcpToken → {resolvedSid:null, fallbackToGlobal:true} (3) 都不 → 401`；timingSafeEqual 仍走全局 fallback 路径（与 /hook/ 对称）；per-session 走 Map.get
  - `mcpTokenRawBuf` 替代 `expectedMcpAuthBuf`（不带 Bearer 前缀，只比对 raw token，与 per-session token 解析后的 raw 字符串对齐）
  - `pnpm typecheck` 0 错；electron-free tests 108/108 (tools 46 + archive-plan-followup 50 + agent-deck-mcp-injector 12) 0 regression；mini-spike re-run 仍 PASSED
  - commit `161e509` 在 worktree branch
- ✅ **P2 Step 2.3 + 2.4 完成（2026-05-18 by session 2060bb28，合并 commit）**：
  - **Step 2.3** 改 `src/main/agent-deck-mcp/tools/index.ts`：
    - `BuildAgentDeckToolsDeps.callerSessionIdOverride` 类型 `(() => string | null) | null` → `((extra?: unknown) => string | null) | null`
    - `makeCtx(args, extra?)` 多接 extra 参数；调用 `callerSessionIdOverride?.(extra) ?? null`
    - 9 个 tool handler 改造 `async (args, extra) => handler(args, makeCtx(args, extra))`
    - 老 in-process callerSessionIdProvider 无参数 lambda 仍兼容（extra 是 optional 参数）
  - **Step 2.4** 改 `src/main/agent-deck-mcp/transport-http.ts`：
    - HTTP transport callerSessionIdOverride 实现 `(extra) => (extra as {authInfo?: McpAuthInfo})?.authInfo?.resolvedSid ?? null`
    - stdio transport 维持 null（stdio 无 HTTP auth，handler fallback args.caller_session_id）
  - **数据流闭环（Step 2.1-2.4 拼起）**：codex teammate 子进程 envOverride AGENT_DECK_MCP_TOKEN=<session-token> → CLI MCP client Bearer header → HookServer.checkMcpAuth 反查 mcpSessionTokenMap → request.raw.auth → mcp-sdk handleRequest 读 req.auth → tool handler extra.authInfo → transport-http callerSessionIdOverride 拿 resolvedSid → tools/index.ts makeCtx → HandlerContext.caller.callerSessionId
  - `pnpm typecheck` 0 错；electron-free tests 108/108 (tools 46 + archive-plan-followup 50 + agent-deck-mcp-injector 12) 0 regression
  - commit `c20b6f9` 在 worktree branch
- ✅ **P2 Step 2.5 完成（2026-05-18 by session 2060bb28，5 sub-step 全部落地）**：
  - **Sub-step 2.5a** 字段重组：删 `private codex: Codex | null` + 加 `private codexBySession: Map<string, Codex>` (per-session 实例)
  - **Sub-step 2.5b** `ensureCodex(sessionId, sessionToken)` signature 改造：cache 命中 return，否则 `new Codex({env: snapshotProcessEnv() + AGENT_DECK_MCP_TOKEN: sessionToken, ...})`；codex SDK 0.120.0 type 注释明示「env 传值后子进程不继承 process.env」（spike 2 line 222-234 实证），必须手工 spread 让子进程仍有 PATH/HOME 等基础 env；加 `AGENT_DECK_MCP_TOKEN_ENV` import（复用 agent-deck-mcp-injector 常量）；module-level `snapshotProcessEnv()` helper 过滤 undefined 值
  - **Sub-step 2.5c** sid 时序（v4 H2 关键修法）：createSession 顶部 `initialSid = opts.resume ?? randomUUID()` → `mcpSessionTokenMap.allocate(initialSid)` 拿 token → `ensureCodex(initialSid, sessionToken)` 起 Codex 实例（envOverride 注入子进程）；新建路径 `tempKey = initialSid` 复用（不再二次 randomUUID，避免 token/Codex/sessions Map 三处 key 不一致）
  - **Sub-step 2.5d** `closeSession` 末尾加 `codexBySession.delete + mcpSessionTokenMap.release`（覆盖 sessionId / internal.threadId 双 key 边角 noop 兼容）
  - **Sub-step 2.5e** `setCodexCliPath` 从 `this.codex = null` 改成 `this.codexBySession.clear()`（清整 Map，spike 2 §1 实证 envOverride 已 frozen 拷贝到子进程，Map 清空只影响下次 ensureCodex 重建）
  - 新增 `renameCodexInstance(oldId, newId)` public method（plan §不变量 7 / Step 2.8 sessionManager.renameSdkSession 函数体调用入口；caller 契约：禁散调；边角 noop）
  - 3 个 codex-cli sdk-bridge.*.test.ts 同步 mock：`vi.mock('@main/codex-config/agent-deck-mcp-injector')` 加 `AGENT_DECK_MCP_TOKEN_ENV: 'AGENT_DECK_MCP_TOKEN'` 常量
  - 📝 **遗留**：sdk-bridge/index.ts 723 行 > 500 行护栏（本步增量 +114 行，历史遗留 + 本步必须的字段重组），后续 follow-up 拆分（不在本步范畴）
  - `pnpm typecheck` 0 错；codex-cli adapter 51/51 + tools/archive-plan-followup/injector 108/108 = 159/159 通过；mini-spike re-run 仍 PASSED
  - commit `c6ec509` 在 worktree branch
- ✅ **P2 Step 2.6 + 2.7 完成（2026-05-18 by session 2060bb28，合并 commit）**：
  - **Step 2.6** 删 `setAgentDeckMcpTokenEnv` setter（D1 §(c) 全局 token 一次性设运行时不再 mutate）：
    - 删 `agent-deck-mcp-injector.ts` 内 `setAgentDeckMcpTokenEnv()` 函数
    - `main/index.ts:151` 改 inline `process.env[AGENT_DECK_MCP_TOKEN_ENV] = settings.mcpServerToken`（含 token 异常缺失走 `delete process.env[ENV]` fallback）
    - `main/index.ts:31` import 从 setter 改为 `AGENT_DECK_MCP_TOKEN_ENV` 常量
    - 重写 injector module-level 注释 + main bootstrap 5.5 阶段注释，明示 token 双轨道共存语义（per-session envOverride / 全局 fallback）
  - **Step 2.7** codex CLI MCP server entry 配置实地检查（**选项 A 命中**）：
    - 通过 `codex mcp add --help` 文档验证：codex CLI 原生支持 `--bearer-token-env-var <ENV_VAR>` flag（即 config TOML 里的 `bearer_token_env_var` 字段），codex CLI 内部读 env var 拼 HTTP `Authorization: Bearer <token>` 头连接 streamable HTTP MCP server，**应用层 zero code change**
    - spike report `spike-reports/spike-p2-codex-mcp-entry.md`（文档型 spike，不跑 dev runtime，pnpm install postinstall 受 Python distutils 阻塞）
    - P5 Step 5.4.5 pre-archive smoke test 可补端到端真测（不阻塞 Step 2.8/2.9 推进）
  - `pnpm typecheck` 0 错；electron-free + codex-cli tests 109/109 通过
  - commit `0f41681` 在 worktree branch
- ✅ **P2 Step 2.8 + 2.9 完成（2026-05-18 by session 2060bb28，合并 commit）**：
  - **Step 2.8** `sessionManager.renameSdkSession` 集成 `mcpSessionTokenMap.rename + sessionRenameHookFn` 派发：
    - 新增 `SessionRenameHookFn` 类型 + `setSessionRenameHookFn(fn)` setter（与 `setSessionCloseFn` 同款 hook 注入模式，避免反向依赖各 adapter bridge）
    - 函数体末尾加 `mcpSessionTokenMap.rename(fromId, toId)`（不变量 7：per-session mcp token 同步迁移）
    - 加 `sessionRenameHookFn?.(updated.agentId, fromId, toId)` 按 agentId 派发 hook（catch warn 不抛错）
    - codex adapter `private bridge` → `bridge`（可见性放开，让 main bootstrap hook cast access `adapter.bridge?.renameCodexInstance`；不加进 AgentAdapter interface 避免 claude adapter noop 实现污染契约）
    - main/index.ts 注入 hook (5.1.1)：agentId === 'codex-cli' → cast `adapter.bridge?.renameCodexInstance` 调用，其他 agentId noop
  - **Step 2.9** `sessionManager.close` 集成 `mcpSessionTokenMap.release`：函数体末尾加 `mcpSessionTokenMap.release(sessionId)`（双轨道清理：codex bridge.closeSession 已做过一次 release 走 noop fast-path；这里覆盖手动 close 路径，token map 不在则静默退出，保证幂等）
  - **数据流闭环**（Step 2.5 + 2.8 + 2.9 拼起）：codex bridge thread-loop firstId callback 触发（realId !== tempKey）→ sessionManager.renameSdkSession 函数体内同步 ① sessionRepo.rename + sdkOwned 转移 ② mcpSessionTokenMap.rename ③ sessionRenameHookFn 派发 → codex bridge.renameCodexInstance（codexBySession Map key 同步迁移）；4 处 key（sessions Map / sdkOwned / token map / codexBySession Map）原子一致
  - `pnpm typecheck` 0 错；codex-cli adapter 51/51 + tools 46 + archive-plan-followup 50 + injector 12 = 159/159 通过
  - commit `d35f06f` 在 worktree branch
- ✅ **P2 Step 2.10 完成（2026-05-18 by session 3022c75d，测试矩阵 29 cases ≥ 8 要求）**：
  - 新建 `src/main/agent-deck-mcp/__tests__/mcp-session-token-map.test.ts` (160 行) — **8 cases**：TC1 (allocate/get/release 双向 map 一致性) / TC2 (rename oldSid→newSid 后 get(token) 返 newSid) / TC3 (release 后 get 返 null) / TC3b (v4 M2 re-allocate same sid → 旧 token tokenToSession 清干净) / TC3c (并发 100 sid allocate token 唯一 randomUUID v4 collision-free) + 3 边角 (rename oldSid 不在 map noop / rename newSid 已在 map 不覆盖防丢已 spawn 子进程 ref / clearAll 测试 helper)
  - 新建 `src/main/agent-deck-mcp/__tests__/transport-http-extra-auth.test.ts` (133 行) — **9 cases**：TC4 (per-session 命中 → 返回 resolvedSid) / TC4b (fallback global token → resolvedSid=null fallbackToGlobal=true → 返 null) + 3 边角 (extra=undefined / extra={} 无 authInfo / extra.authInfo 缺 resolvedSid) + 4 集成 (lambda 返 null + args 缺省 → makeCallerContext 用 __external__ sentinel / makeCallerContext __external__ + spawn_session → denyExternalIfNotAllowed 拒绝 / __external__ + list_sessions 不拒 read-only / lambda resolvedSid + args 伪造 → resolvedSid 优先防 prompt 注入)
  - 新建 `src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts` (315 行) — **12 cases**：TC5 (多 sid allocate 不同 token 各自反查正确 sid + bridge.codexBySession Map 独立持各 session entry) / TC6 (未 allocate 的 random token → get 返 null 走全局 fallback / per-session + 外部双 token 隔离) / TC7 (mcpSessionTokenMap.rename token 字符串不变 + sid 切到 newId / bridge.renameCodexInstance Map key 同步迁移 / renameCodexInstance oldId 不在 Map noop / newId 已在 Map 不覆盖) / TC7b (closeSession 双轨清理 codexBySession.delete + mcpSessionTokenMap.release / sid != threadId fork 场景双 key 都 release / sid 不在 sessions Map 直接 return 不误删别 session) + TC8 bonus (setCodexCliPath 清整 Map)
  - 测试策略：mcpSessionTokenMap 是 module-level singleton 直接用真实模块（clearAll() beforeEach 复位）；TestCodexBridge 强制访问 private codexBySession Map + 注入 fake Codex 实例（不真 spawn 子进程）；transport-http lambda 单测对齐契约（inline 同款 lambda）+ 直接 unit-test 行为
  - **v3 L2 修法**：TC5 用中性变量名 `SPIKE_LABEL_A/B`（避 codex LLM 拒读 TOKEN 字样）— 此处单测不真起 codex 子进程,直接验 mcpSessionTokenMap.allocate per-session 独立 + bridge.codexBySession Map 各持各 entry
  - `pnpm typecheck` 0 错；新增 29/29 通过 + 现有 regression checkpoint (tools 46 / archive-plan-followup 50 / spawn-guards 12 / codex-cli adapter 51 = 159/159) 0 regression
  - commit `5ee5bfa` 在 worktree branch
- ✅ **P2 Step 2.11 完成（2026-05-18 by session 3022c75d，端到端 7 cases）**：
  - 新建 `src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts` (342 行) — **7 cases**
  - 验证 universal-message-watcher.buildWireBody 构造的双锚点 wire prefix `[from <name> @ claude-code][msg <id>][sid <senderSid>]\n<body>` 通过 codex receiveTeammateMessage → bridge.sendMessage → pendingMessages → codex SDK 子进程整条链路**字节级保留**
  - **TC8a**: bridge.sendMessage(sid, wireBody) → pendingMessages 末位 = wireBody verbatim (plain text Input 形态 / packCodexInput 直返 string)
  - **TC8b**: emit kind='message' / payload.text=wireBody verbatim / role='user' / source='sdk' / agentId='codex-cli'
  - **TC8c**: parseWirePrefix 端到端从 pendingMessages entry / emit text 提取 from/adapter/msgId/senderSessionId 四字段双向闭环
  - **TC8d**: 双锚点 charset 严格 v4 UUID lowercase hex + hyphen 36 字符（app CLAUDE.md §wire format id invariant）
  - **TC8e**: 多 codex teammate session 各自 pendingMessages 不串（wire prefix + sessions Map 双轨隔离）
  - **边角 1**: 含空格 / 中文 / 数字的合法显示名 wireBody 仍 verbatim 保留 + parseWirePrefix 可解
  - **边角 2**: attachments 透传 → packCodexInput 返 UserInput[]（[local_image, text] 顺序），wireBody 包 type:text item 字节级保留
  - 测试策略：TestCodexBridge 强制访问 private sessions Map 注入 fake InternalSession（turnLoopRunning=true 跳过启动 turn loop），直接调 bridge.sendMessage(sid, wireBody) 模拟 universal-message-watcher.deliver 下游路径；adapter.receiveTeammateMessage 是 thin wrapper（codex-cli/index.ts:122 `await this.bridge.sendMessage(sid, body)`），bridge 行为正确即等价 adapter 端到端正确
  - `pnpm typecheck` 0 错；7 新 + 188 regression checkpoint = 195/195 通过 0 regression
  - commit `0dc8fd7` 在 worktree branch
- ✅ **P2 Step 2.12 N/A 收口（2026-05-18 by session 3022c75d）**：
  - 检查 `spawn.ts` / `hand-off-session.ts` / `hand-off-session-impl.ts` / `schemas.ts` 确认 D6 deny **从未实施**（codex bridge P2 工作直接做对了，不需要先 deny 再撤）
  - schema 已接受 'codex-cli' enum 值（schemas.ts:305-309）；handler 直接 `adapter: args.adapter ?? 'claude-code'` 透传（hand-off-session.ts:282）；无 codex-cli reject 路径
  - Step 2.12 N/A 收口（plan 设计意图是 P2 落地后撤；实际 P2 Step 2.5+2.8+2.9 直接跑通 codex bridge per-session token + cwd resilience，hand_off_session adapter='codex-cli' 现可正常 spawn codex teammate）
- ✅ **P2 全 phase 完成（Step 2.1-2.12 全收口）**：HIGH-1 caller_session_id transport 注入解决；codex teammate per-session token + Codex 实例 + sandbox 4 字段 default + 不变量 7 (4 处 key 同步迁移) + wire prefix 端到端字节级保留全验证
- ✅ **P3 Step 3.1 完成（2026-05-18 by session c9a887bc）**：
  - mkdir `resources/codex-config/agent-deck-plugin/agents/`（skeleton dir, P4 Step 4.2/4.3 写 reviewer body 时填充；empty dir 不入 git 是 git 惯例，P4 写文件时 dir 自然进 tree）
  - 新建 `resources/codex-config/CODEX_AGENTS.md`（P3 阶段 placeholder，4 行说明文件角色 + P4 Step 4.1 计划；注入路径由 P3 Step 3.6 改造的 agents-md-installer 同步到 `~/.codex/AGENTS.md`）
  - 改 `package.json` `build.extraResources` 加 `resources/codex-config` 条目（与 claude-config / sounds 同款 from→to 1:1 + filter '**/*'，保证打包后 prod 路径 `<resourcesPath>/codex-config/` 找得到，详 plan §D5 fallback 策略）
  - `pnpm typecheck` 0 错；extraResources 解析 4 entries (bin / claude-config / codex-config / sounds) 顺序正确
  - commit `5a3ce96` 在 worktree branch
- ✅ **P3 Step 3.2 完成（2026-05-18 by session c9a887bc）**：
  - **Rename** `sdk-injection.getAgentDeckPluginPath` → `getClaudeAgentDeckPluginPath`（路径沿用 `claude-config/agent-deck-plugin`，仅改名让 claude 视角与 codex 视角并列）
  - **新建** `src/main/adapters/codex-cli/codex-config-paths.ts` (19 行) — `getCodexAgentDeckPluginPath()` dev/prod 自动分流；JSDoc 明示 codex SDK 不自动扫该目录，本路径仅由 bundled-assets multi-root scan 注册到 manifest 给 spawn handler 用
  - **新建** `src/main/adapters/agent-deck-plugin-paths.ts` (24 行) — `getAgentDeckPluginPathForAdapter(adapter)` switch 分发（exhaustive default `_exhaustive: never` 防加新 adapter 漏 case）；signature 限 'claude-code' / 'codex-cli' 两值（aider/generic-pty 无 plugin 注入概念）
  - **级联改用点**（rename cascade 5 处）：bundled-assets.ts (import + 2 calls + 2 JSDoc) / codex-config/skills-installer.ts:47 注释 / 2 个 test mock (sdk-bridge.consume-fork.test.ts:37 + sdk-bridge.recovery.test.ts:64) `getAgentDeckPluginPath` → `getClaudeAgentDeckPluginPath`
  - **不动**：`getAgentDeckPluginsForSession()` signature/行为不变（claude-code only，codex SDK 没 plugins[] 字段不通用化，加 JSDoc 注解 plan 决策）；bundled-assets.ts 仍单 root scan claude-config（Step 3.3 多 root 扩展）；spawn handler 仍单 root（Step 3.4 级联 adapter）
  - `pnpm typecheck` 0 错；electron-free regression 104/104 通过 (tools 46 + archive-plan-followup 50 + mcp-session-token-map 8) 0 regression；grep 确认 0 stale `getAgentDeckPluginPath\b` 残留
  - 📝 claude-code adapter 测试 (sdk-bridge.*) 因 worktree postinstall electron-rebuild Python distutils 阻塞 (§当前进度环境踩坑) 无法跑，但 typecheck 已校验 mock 真实 export name 一致
  - commit `66a31ac` 在 worktree branch
- ✅ **P3 Step 3.3 + 3.4 完成（2026-05-18 by session 7314d581，breaking change atomic wave）**：
  - **Step 3.3 — 双 root multi-adapter 数据模型**：
    - `bundled-assets.ts` 双 root scan + merge：`loadBundledAssets()` 遍历 claude root + codex root，结果按 (adapter asc, name asc) sort 合并到同 snapshot
    - export 新类型 `BundledAdapter = 'claude-code' | 'codex-cli'`（plugin root narrow key，与 args.adapter 4 enum 区分 — aider/generic-pty 无 plugin scope）
    - `getBundledAssetContent(kind, name, adapter)` / `getBundledAssetPath(kind, name, adapter)` **breaking change** 加第 3 参数（同名跨 adapter 内容不同必须 narrow，无 fallback）
    - `scanAgents(root, adapter)` / `scanSkills(root, adapter)` / `buildAgentMeta(name, absPath, fm, source, adapter)` / `buildSkillMeta` 内部 caller 串通
    - `qualifiedName` 升级：bundled = `agent-deck:<adapter>:<name>`（如 `agent-deck:claude-code:reviewer-claude` / `agent-deck:codex-cli:reviewer-claude`，防双 root 同名冲突）；user 不变 `<name>`
    - 新增 `compareAdapterThenName` 排序 helper（claude 排前 / codex 排后 / null user 资产由 user-assets 单独管不混入 bundled snapshot）
    - `shared/types/assets.ts` AssetMeta 加 `adapter: 'claude-code' | 'codex-cli' | null` 必填字段 + jsdoc 标 plan ref + 用途 3 项（spawn 路由 / fs 路径 narrow / UI 分组）；qualifiedName jsdoc 升级注明双 root 防冲突 + caller 影响面
    - `user-assets.ts` 调 `__metaBuilders.buildAgent/SkillMeta` 多传 `null` 作 adapter（user 资产无 plugin scope）
  - **Step 3.4 — 6 处 caller cascade**（plan 列 5 处实际 6 处，`AssetEditor.tsx:57` typecheck 揪出来补漏）：
    - `spawn.ts:90` `getBundledAssetContent('agent', args.agent_name)` → 加 args.adapter 第 3 参数；提前 reject `args.agent_name && args.adapter not in {claude-code,codex-cli}`（aider/generic-pty 无 plugin scope）
    - `ipc/assets.ts` 新增 `parseBundledAdapterOrNull(value)` helper；`AssetsGetContent` / `AssetsRevealInFolder` IPC handler 三参数 → 四参数（+adapterArg）；source==='bundled' + adapter===null reject；source==='user' 时 adapter 忽略
    - `preload/api/misc.ts` `getAssetContent` / `revealAssetInFolder` signature 加 adapter: 'claude-code'|'codex-cli'|null 第 4 参数 + jsdoc plan ref
    - `renderer/components/AssetsLibraryDialog.tsx` openViewer / onReveal 透传 `viewer.asset.adapter`
    - **`renderer/components/assets/AssetEditor.tsx:57`**（plan §P3 Step 3.4 漏列的 caller，typecheck 揪出来补漏）— user 资产编辑入口固定传 `null`（asset.source 必为 'user'）
    - `tools.test.ts:361` mock signature 加 `_adapter` 第 3 参数（noop 兼容 — 现有 case 仅按 kind+name 反查，新 D3 矩阵 4 行测试时再按需 narrow）
  - **验证**：`pnpm typecheck` 0 错（typecheck 揪出 AssetEditor.tsx:57 plan 漏列 caller，已补）；electron-free regression checkpoint **149/149 通过 0 regression**（tools 46 + archive-plan-followup 50 + archive-plan-cwd-marker 5 + mcp-session-token-map 8 + transport-http-extra-auth 9 + per-session-codex-env 12 + wire-prefix-e2e 7 + injector 12）
  - 📝 **breaking change atomic wave**：Step 3.3 + 3.4 数据模型 / IPC + UI 信号链层级耦合，合一原子 commit 维持 commit chain 永远 typecheck-clean
  - commit `634523d` 在 worktree branch
- ✅ **P3 Step 3.5 完成（2026-05-18 by session 7987aa82，spawn handler adapter routing + codex teammate default enforce 提到 options-builder 层）**：
  - 新建 `src/main/adapters/claude-code/resolve-bundled-claude.ts`：`resolveBundledClaudeBinary(): string | null` 委托 sdk-runtime `getPathToClaudeCodeExecutable()`，dev / packaged 双路径返非 null（dev 真实 node_modules 路径 / packaged unpacked 路径），让 codex sandbox 内 wrapper Bash `$AGENT_DECK_CLAUDE_PATH` 在双环境都直接可用
  - 改 `src/main/adapters/types.ts`：CodexCreateOpts 加 4 个可选字段 (approvalPolicy / networkAccessEnabled / additionalDirectories / envOverrideExtra)；CreateSessionOptionsRaw 加 agentName 字段（v4 D7 信号源）
  - 改 `src/main/adapters/options-builder.ts` narrowToCodexOpts：按 `raw.agentName in ['reviewer-claude', 'reviewer-codex']` 触发 4 字段 unsafe default spread + reviewer-claude 路径加 envOverrideExtra.AGENT_DECK_CLAUDE_PATH（v4 M7：wrapper Bash 用 env var）；普通 codex session 不进 default 分支不被污染（不变量 6 enforce 点 = options-builder 层）
  - 改 `src/main/agent-deck-mcp/tools/handlers/spawn.ts`：buildCreateSessionOptions raw 透传 `agentName: args.agent_name`
  - 改 `src/main/adapters/codex-cli/sdk-bridge/index.ts`：createSession opts + ensureCodex 接受 4 新字段；startThread / resumeThread 透传 3 字段（approvalPolicy ?? 'never' 沿用现状 default + networkAccessEnabled / additionalDirectories 仅 caller 显式传时写）；ensureCodex envOverrideExtra `Object.assign(envOverride, opts.envOverrideExtra ?? {})` 末尾 merge 优先级最高
  - 改 `src/main/adapters/codex-cli/index.ts`：adapter wrapper createSession 透传 4 新字段给 bridge
  - `pnpm typecheck` 0 错；regression checkpoint **253/253 通过 0 regression**（149 electron-free + 70 codex-cli adapter + 22 claude-code adapter passing tests + 12 spawn-guards）
  - 📝 关键修法：readonly string[] → bridge 用 `[...opts.additionalDirectories]` 拷贝转 mutable array 兼容 codex SDK ThreadOptions.additionalDirectories: string[]
  - commit `a7a9068` 在 worktree branch
- ✅ **P3 Step 3.6 完成（2026-05-18 by session 7987aa82，agents-md-installer 源切换 + D5 fallback 策略）**：
  - `src/main/codex-config/agents-md-installer.ts` getBuiltinAgentsMdContentPath 路径切换：claude-config/CLAUDE.md → codex-config/CODEX_AGENTS.md（codex 视角独立维护，P3 Step 3.1 已建 placeholder，P4 Step 4.1 写完整内容）；dev / packaged 双路径同款切换
  - readContentRaw fallback 链升级：旧 silent fallback（return ''+warn）→ 新显式 throw（D5：codex-config/CODEX_AGENTS.md 缺失即 throw，禁 silent fallback 到 claude-config/CLAUDE.md，避免 typecheck/build 过但 runtime 注入静默退化）
  - syncAgentDeckSection 加 try/catch 接住 getContent throw → console.error prominent log + return null 跳过同步（不阻断 main bootstrap 启动，但 error level 让用户立即看到错；log 文案明示 plan §D5 + 常见原因 extraResources 漏配 / 文件被误删）
  - `pnpm typecheck` 0 错；无现有测试改动需求
  - commit `7d9cbe9` 在 worktree branch
- ✅ **P3 Step 3.7 / 3.8 N/A 收口（2026-05-18 by session 7987aa82）**：
  - **Step 3.7**：skills-installer.ts multi-source — D3 决策 P3 阶段不动，保留单源 ~/.codex/skills/agent-deck/；P4 Step 4.4 决策是否真要 multi-source。本 step 无代码改动
  - **Step 3.8**：main bootstrap 启动顺序检查 — 验证发现 `getBundledAssetContent` (spawn.ts:102 唯一 caller) 直接 `readFileSync` **不依赖** cache（cache 只 hold snapshot 给 UI 用），所以 spawn handler 不依赖 loadBundledAssets 预热顺序。现有 startup order（step 6 hookServer.start → step 7 sync → step 8.5 loadBundledAssets）已正确，**Step 3.8 N/A 收口**，无代码改动
- ✅ **P3 Step 3.9 完成（2026-05-18 by session 66080da8，测试矩阵 16 cases ≥ 6 要求 + D3 矩阵 4 行严格对齐）**：
  - 新建 `src/main/__tests__/bundled-assets-multi-root.test.ts` (149 行) — **4 cases**：TC1 (loadBundledAssets 双 root scan 合并 snapshot，含 claude-code + codex-cli 各自 agents/skills，adapter 字段 + qualifiedName 形态 `agent-deck:<adapter>:<name>` + 排序 (adapter asc, name asc)) / TC2 (getBundledAssetContent('agent', 'reviewer-claude', 'claude-code') vs 'codex-cli' 双 adapter 返回**不同**文件内容) / TC2b (getBundledAssetPath narrow 各自 root 绝对路径) / TC2c (找不到时 ok:false + reason 含 adapter narrow 信息)
  - 新建 `src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts` (419 行) — **6 cases** (D3 矩阵 4 行 + 2 边角)：TC3 (D3 行 1, claude × claude wrapper → claude-config) / TC4 (**D3 行 4, v4 关键修正**:codex × claude wrapper → codex-config 不是 claude-config) / TC5 (D3 行 3, codex × codex teammate → codex-config) / TC6 (D3 行 2, claude × codex wrapper → claude-config) / TC7 (aider + agent_name → 提前 reject "agent_name not supported for adapter") / TC7b (generic-pty + agent_name → 同款 reject)
  - 新建 `src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts` (143 行) — **6 cases** (4 字段 spread + 2 边角)：TC8 (reviewer-codex → 4 字段 spread + envOverrideExtra 不含 AGENT_DECK_CLAUDE_PATH) / TC9 (reviewer-claude → 4 字段 spread + envOverrideExtra.AGENT_DECK_CLAUDE_PATH 有值) / TC10 (agentName undefined → 不 spread default，caller 显式 codexSandbox 仍透传) / TC10b (agentName="reviewer-typescript" 非 reviewer-* → 同款不 spread) / TC11 (reviewer-claude + resolveBundledClaudeBinary 返 null → envOverrideExtra 不注入,options-builder 不静默替换) / TC11b (claude-code adapter narrow filter 掉 agentName 字段，不进 codex default 分支)
  - 测试策略：bundled-assets 用 tmp fixture dir + mock 双 root path helper（P3 阶段 codex-config/.../agents/ 真实 fs 空，fixture-based 让 TC2 P3 即能 verify multi-root 数据模型）；spawn 全套 mock 复用 tools.test.ts 模板 + spy 记录 getBundledAssetContent (kind, name, adapter) 三参；options-builder 直接调 buildCreateSessionOptions 不过 spawn 链路（最直接验证 v4 D7 信号源 + 不变量 6 enforce 点 = options-builder 层）
  - `pnpm typecheck` 0 错；新增 16/16 通过 + electron-free regression checkpoint **142/142 通过 0 regression**（tools 46 + archive-plan-impl-core 12 + archive-plan-followup 50 + archive-plan-cwd-marker 5 + mcp-session-token-map 8 + transport-http-extra-auth 9 + spawn-guards 12）+ codex-cli regression **31/31 通过 0 regression** (per-session-codex-env 12 + wire-prefix-e2e 7 + injector 12)
  - 📝 **全 vitest run**：9 failed / 603 passed / 7 skipped，**9 failed 全部** 是 `Error: Electron failed to install correctly`（plan §当前进度 line 945 记载的 worktree 内 postinstall electron-rebuild Python distutils 阻塞预存问题，与本会话改动无关）— P5 Step 5.4.5 pre-archive smoke test 一起解
  - commit `4bf6534` 在 worktree branch
- ✅ **P4 Step 4.0 完成（2026-05-18 by session 419c5a8c，✅ PASS 结论）**：
  - 写 `<worktree>/spike-reports/spike4-runner.mjs`（仿 spike3-runner 架构 — codex SDK workspace-write + approvalPolicy=never + networkAccessEnabled=true + additionalDirectories 三目录 + claude -p `--permission-mode bypassPermissions`）
  - 写 `<worktree>/spike-reports/spike4-claude-nested-sandbox.md`（结论 + D3 矩阵更新 + 影响范围 + 残留风险 5 条）
  - **端到端 49.4s 单 sandbox mode (workspace-write) 跑 2 Test 全 PASS**：Test 1 (claude 内部 Bash → `cat /tmp/hello.txt` 拿 "say hi" + BASH_TOOL_OK) + Test 2 (claude 内部 Read → 读 /tmp/hello.txt 拿 "say hi" + READ_TOOL_OK)
  - **关键发现**：(a) additionalDirectories 必须包含 `/tmp`（spike3 不需,spike4 需 — reviewer wrapper 写中间文件路径）;(b) claude -p oneshot 必须传 `--permission-mode bypassPermissions`（不然内部工具撞默认 default 模式弹审批 SDK 无 UI 挂死）;(c) 双层 sandbox-exec 嵌套透明 — 外层 codex sandbox 不阻 spawn 行为本身（spike3 证），内层 claude 自己 sandbox 不阻 claude 内部工具调用（spike4 证）
  - **结论分流命中 PASS** → 进 Step 4.3 reviewer-claude.md (codex 视角) wrapper **正常写,不限「纯文本 review」**;wrapper Bash 模板可让 claude 真用 Bash + Read 读源码做 review
  - **D3 异构矩阵最终 4 种全部 feasible**：codex × reviewer-claude wrapper 不阉割
  - 残留风险 5 条（详 spike4-claude-nested-sandbox.md §残留风险）：bypassPermissions 与 user hook 互动 / Write/Edit/Glob/Grep 工具未实测 / claude SDK 版本依赖 / additionalDirectories `/tmp` 是否进 P3 options-builder default / wrapper body 是否 `--setting-sources ''` 排除 user hook 干扰 — 影响轻微,P5 Step 5.4.5 pre-archive smoke test 端到端补测
  - commit `19ccaab` 在 worktree branch
- ✅ **P4 Step 4.1 完成（2026-05-18 by session 419c5a8c）**：
  - 写 `resources/codex-config/CODEX_AGENTS.md`（178 行 codex 视角应用环境约定，等价 `resources/claude-config/CLAUDE.md` claude 视角）
  - 协议层完全对齐（Wire format / send_message / archive_plan / hand_off_session / shared-team 约束同款），纯 codex 工具差异处分别说明（`shell` vs `Bash` / `~/.codex/AGENTS.md` 加载点 / `sandboxMode`/`approvalPolicy` 而非 claude `--permission-mode` / 无 native EnterWorktree 必走 MCP tool）
  - 13 sections：§协议覆盖 / §codex 无 native EnterWorktree / §reviewer-claude 失败合规兜底 / §三个核心约定 / §send_message / §跨会话救火 / §Wire format invariant / §NO MSG ANCHOR fallback / §enter/exit_worktree / §archive_plan / §hand_off_session / **§plan cold-start protocol(codex 端 5 步)** / §codex SDK 特有 per-session token / §recoverer fallback
  - **§plan cold-start protocol(codex 端 5 步)** 关键新增节：codex 端无 user CLAUDE.md 自动加载机制（claude 端走 `settingSources` 自动加载），inline 5 步等价物（`shell: cat plan` / `mcp__agent-deck__enter_worktree` / `git rev-parse` 自检 / 按 §下一会话第一步 动手 / §设计决策修订需 user 确认）
  - 自检通过：约束 2 (deprecated/future) 0 hits;约束 3 (descriptive) 1 false-hit 是 reviewer 输出文本中的「建议 lead」（与 claude-config 同款 invariant 不动）
  - 与 P3 Step 3.6 已切的 agents-md-installer 源 (CODEX_AGENTS.md → ~/.codex/AGENTS.md) 配套生效
  - commit `88220bd` 在 worktree branch
- ✅ **P4 Step 4.2 + 4.3 + 4.3.5 完成（2026-05-18 by session 419c5a8c，3 step 合并 commit）**：
  - **Step 4.2**：写 `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md`（132 行 codex × codex 同源 teammate body — codex SDK 直接 spawn codex SDK 子 session 当 reviewer，无 wrapper）
    - 架构对偶 `claude-config/agent-deck-plugin/agents/reviewer-claude.md`（claude × claude direct）
    - 11 §核心纪律 + §使用形态 + §输入识别 (full_review/rebuttal) + §输出格式 + §重点维度 + §反模式 + §失败兜底
    - shell tool 替代 Bash + 引用 codex sandbox-exec / approvalPolicy=never / additionalDirectories spec
  - **Step 4.3**：写 `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md`（190 行 codex × claude wrapper body — codex SDK spawn codex SDK 子 + shell 起外部 claude -p）
    - 架构对偶 `claude-config/agent-deck-plugin/agents/reviewer-codex.md`（claude × codex wrapper）
    - **spike3 + spike4 实证 PASS 后**正常写不限「纯文本 review」 — wrapper Bash 模板可让 claude 真用 Bash + Read 读源码
    - §claude CLI 调用模板 关键 flag：`-p` / `--permission-mode bypassPermissions` (spike4 必需) / `--effort xhigh` / `-C <CWD>` + `< $IN > $OUT 2> $ERR`
    - §使用形态：`$AGENT_DECK_CLAUDE_PATH` env var（M7 helper-injected），严禁 hardcode binary 路径
    - §spike4 衔接 节内嵌 spike4 PASS 关键发现 + 详 file ref
    - §失败兜底 7 类：env var 未注入 / binary 缺失 / OAuth / sandbox 拒 / timeout / `$OUT` 空 / 其他
  - **Step 4.3.5（spike4 follow-up，本会话发现的 P3 default 缺陷修补）**：fix `src/main/adapters/options-builder.ts` `narrowToCodexOpts` default `additionalDirectories` 由 `['~/.claude','~/.codex']` 扩为 `['~/.claude','~/.codex','/tmp']`（spike4 实证 wrapper Bash 中间文件 `/tmp/<basename>.in.txt` 走必需路径，不含时 codex sandbox-exec 拒读 wrapper 输出）
    - 同步 `src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts` TC8/TC9 expect 列表 + 顶部 doc comment（3 dirs not 2）
    - typecheck 0 错；electron-free regression checkpoint **86/86 pass**（9 files: tools 46 + archive-plan-followup 50 + archive-plan-cwd-marker 5 + spawn-routing 6 + bundled-assets-multi-root 4 + teammate-spawn-defaults 6 + sdk-bridge.recovery 15 + injector 12 等）
  - 自检通过：约束 2 (deprecated/future) 0 hits 各 file，约束 3 (descriptive) 仅 false-hit 在 reviewer 输出文本「建议 lead」（与 claude-config 双 reviewer 同款 invariant）
  - commit `470e974` 在 worktree branch
- ✅ **P4 Step 4.4 placeholder（D3 决策，无代码改动）**：codex 视角 SKILL 差异处理当前阶段不写差异 SKILL 文件（D3 决策），留 placeholder。`skills-installer.ts` 仍走单源 `~/.codex/skills/agent-deck/`（P3 Step 3.7 已 N/A 收口）。**未来若有 codex 视角差异化 SKILL 需求**走独立 plan
- ✅ **P4 Step 4.5 完成（2026-05-18 by session 419c5a8c）**：
  - 改 `resources/claude-config/CLAUDE.md`（125 → 141 行）
  - 新增 §enter_worktree / exit_worktree（MCP 替代方案）节：claude 端首选 CLI builtin EnterWorktree/ExitWorktree;MCP 等价 tool 适用 3 场景（避 EnterWorktree CLI v2.1.112 stale base bug / 跨 adapter 测试 / archive_plan 4 态预检场景 C 需 cwd_release_marker）
  - 详细 cross-ref codex 端 protocol layer (`codex-config/CODEX_AGENTS.md §enter_worktree` 节)
  - §Agent Deck Universal Team Backend 章节 "MCP 7 tool" → "MCP 9 tool"（P1 加的 enter_worktree + exit_worktree）
  - commit `e2e3090` 在 worktree branch
- ✅ **P4 Step 4.6 内容自检通过（2026-05-18 by session 419c5a8c，无代码改动）**：4 file（CODEX_AGENTS.md / reviewer-codex.md / reviewer-claude.md / claude-config/CLAUDE.md）走「提示词资产维护」6 步：
  - 约束 2 (deprecated/future/compat): 0 hits 全部
  - 约束 3 (descriptive): 各 file 1 hit 都在 reviewer 输出文本「建议 lead」（与 pre-existing claude-config 同款 invariant 不动）
  - 约束 5 (示例克制): 0 hits 全部
  - 约束 1 / 4 / 6 mental simulation: 通过（cross-ref pattern + 节标题清单完备 + plugin self-contained per §约束 6 fine print "plugin 资产间共有协议抽到应用打包 CLAUDE.md 中间层"）
- ⏳ **P4 全 phase 完成**：Step 4.0 (spike4 PASS) + 4.1 (CODEX_AGENTS.md) + 4.2 (reviewer-codex codex 视角) + 4.3 (reviewer-claude codex 视角 wrapper) + 4.3.5 (P3 default /tmp follow-up) + 4.4 placeholder + 4.5 (claude-config 加 MCP enter/exit_worktree 引用) + 4.6 (4 file 自检) — 全部完成。HIGH-2 + HIGH-4 内容侧解决
- ✅ **P5 Step 5.1 N/A 收口（2026-05-18）**：
  - 4 file double-check 确认 D6 临时 schema deny **从未实施**（与 P2 Step 2.12 N/A 收口同款语义，line 887 已记录）
  - `spawn.ts:95` 仅 reject `aider/generic-pty + agent_name`（D3 规则 / P3 Step 3.4 落地），**不**针对 codex-cli
  - `hand-off-session.ts:282` `adapter: args.adapter ?? 'claude-code'` 直接透传 args.adapter
  - `hand-off-session-impl.ts` 仅 deny external caller（与 codex-cli 无关）
  - `schemas.ts:306-309` adapter enum 接受 `'codex-cli'`（hand_off_session schema 无 codex-cli reject 路径）
  - **结论**：P2 工作直接做对了 codex bridge per-session token + cwd resilience；hand_off_session 与 schema 一直接受 codex-cli。无需"先 deny 再撤"两步走，Step 5.1 N/A 收口
- 📝 **环境踩坑**（本会话发现）：worktree 内 `pnpm install` 主体成功（dependencies 装好可 typecheck），但 postinstall electron-rebuild 跑 node-gyp build node-pty 撞 Python 3.12+ 删 distutils 模块失败。影响后续 P1 Step 1.6 `pnpm dev` / P1 Step 1.5 vitest 真测。修法选项：(a) 装 setuptools 补 distutils → `python3 -m pip install setuptools`；(b) 切 Python 3.11 (pyenv / conda) 重跑 install；(c) 暂时跳过 native binary 验证（typecheck + unit test 优先）。
- 📝 **P5/P6 决策 checkpoint（v4.1 M5 修法）**：
  - P5 跑完后 user 需明示是否跑 P6（流程改进）
  - 选 "跑 P6" → P5 不立即 archive_plan，继续 P6.1-P6.8，archive_plan 时 changelog_id csv 含 P5+P6 两个
  - 选 "不跑 P6" → P5.6 直接 archive_plan，changelog_id 只 P5 一个；P6 留 stub 在归档 plan 内供未来独立 plan 接力
- ✅ **P5 收口（CHANGELOG_125，commit `3bab5e1`）**：fix(p5-batch-a/b/c) 4 commit + side-task settings + CHANGELOG/INDEX。3 ✅ HIGH (H1 archive_plan 4 态分流 / H2 codex bridge resume earlyErrCb 漏清 / H3 codex-config reviewer-claude wrapper claude -C 不存在) + 21 MED + 4 降级 MED + 多 LOW/INFO 全 inline fix。typecheck + build + 730/801 vitest 0 failed。Step 5.4.5 smoke test partial（component-level OK，codex SDK runtime macOS env block）
- ✅ **P6 收口（CHANGELOG_126，commit `88c94f1`）**：feat(p6) 单 commit 含 A user CLAUDE.md §复杂 plan v2 流程图 (RFC + spike + Deep-Review 前置) + B 应用 CLAUDE.md cross-ref + C 4 reviewer body §Sandbox 限制说明 + D deep-code-review → deep-review SKILL 改造 + 物理 git mv + deprecation stub + E .gitignore 加 .deep-review-cache/。**P6.5 meta-review 双对抗** (reviewer-claude HIGH 5 / reviewer-codex MED 9 / 双方 LOW/INFO 3 + 1 ❌ false positive) 全 inline fix。typecheck 0 错。
- 📝 **本 plan 整体收口**：P0-P6 全部完成；archive_plan 时 changelog_id csv = "125,126"

## 下一会话第一步（v4.1 + P1 + P2 + P3 + **P4 全 phase** 完成后接力到 P5 Step 5.1）

**当前位置**：P3 全 phase + **P4 全 phase**（Step 4.0/4.1/4.2/4.3/4.3.5/4.4/4.5/4.6 全部完成）完成（commit 链：`...c6ec509` → `0f41681` → `d35f06f` → `5ee5bfa` → `0dc8fd7` → `5a3ce96` → `66a31ac` → `634523d` → `a7a9068` → `7d9cbe9` → `4bf6534` → `19ccaab`（Step 4.0 spike4 PASS）→ `88220bd`（Step 4.1 CODEX_AGENTS.md）→ `470e974`（Step 4.2+4.3+4.3.5）→ `e2e3090`（Step 4.5）在 worktree branch）。**P4 关键产出**：HIGH-2 + HIGH-4 内容侧解决；codex 视角 4 资产文件落地（CODEX_AGENTS.md 178 行 + reviewer-codex.md 132 行 + reviewer-claude.md 190 行 + claude-config/CLAUDE.md 加 §enter/exit_worktree 节 + spike4 PASS 报告 + spike4 follow-up P3 default /tmp 修补）。进 **P5 收尾（~7 step + Step 5.4.5 pre-archive smoke test）**。

**P5 起手**（详 plan §P5 章节）：

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/codex-handoff-team-alignment-20260518.md` 读全 plan v4.1
2. `EnterWorktree(path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-handoff-team-alignment-20260518)` 进 worktree（用 `path` 不是 `name`）
3. 自检 `git rev-parse HEAD` 应是 `e2e3090`（Step 4.5）或之后
4. **进 P5 Step 5.1** — 撤 D6 临时 schema deny（如有）
5. **接 Step 5.2** — 双对抗 review P1-P4 改动：调 `mcp__agent-deck__spawn_session` × 2 起 reviewer-claude + reviewer-codex teammate（claude lead × claude/codex 异构对），scope = P1-P4 全部代码改动 + 4 个 codex 视角资产文件 + plan 关键节
6. **接 Step 5.3** — fix review finding（按 §决策对抗 三态裁决；HIGH 必修；user 确认后 commit）
7. **接 Step 5.4** — `pnpm typecheck`（必跑）+ `pnpm build`（大改动跑）
8. **接 Step 5.4.5** — pre-archive smoke test：(a) 先解 Python distutils 阻塞（`python3 -m pip install setuptools` 或 pyenv 切 3.11 重跑 pnpm install）;(b) `pnpm dev` 起应用 + spawn codex teammate（adapter:codex-cli, agent_name:reviewer-codex/reviewer-claude）端到端验证 per-session token / spawn options default / wrapper Bash 模板 / additionalDirectories /tmp 等链路
9. **接 Step 5.5** — 写 `<main-repo>/changelog/CHANGELOG_<next>.md`（详 §P5 Step 5.5 章节）
10. **接 Step 5.6** — archive_plan（推迟到 P6.8 — 见 §P5 Step 5.6 + §P5/P6 决策 checkpoint）
11. **P5/P6 决策 checkpoint**（v4.1 M5）：P5 跑完后 user 需明示是否跑 P6（流程改进）
    - 选 "跑 P6" → P5 不立即 archive_plan，继续 P6.1-P6.8（详 §P6 章节），archive_plan 时 changelog_id csv 含 P5+P6 两个
    - 选 "不跑 P6" → P5.6 直接 archive_plan，changelog_id 只 P5 一个；P6 留 stub 在归档 plan 内供未来独立 plan 接力

**P5 风险点 / 注意**：
- **Step 5.4.5 是阻塞项**：worktree 内 postinstall electron-rebuild Python distutils 阻塞（plan §当前进度环境踩坑）需先解;不解则 `pnpm dev` 跑不起,smoke test 无法做
- **Step 5.2 review scope 大**：P1-P4 累计 14 commit + 4 个新 codex 视角文档 + plan 关键节,reviewer prompt 要按主题拆批（每批 ≤ 10 文件 / ≤ 30 行）走 `run_in_background: true` 并发 + timeout: 600000;codex teammate 走 mcp spawn_session（lead 选 claude），不走外部 codex CLI Bash 路径（teammate 模式跨轮持久化 + reply 自动注入对话流）

**完成 P5 后**：进 P6 流程改进（若 user 选跑）→ archive_plan。

**自检**：
- agent 自主决定 hand-off 时机点（user 2026-05-18 明示授权,详 §Agent 自主 hand-off 授权 节）
- worktree 内 P1 + P2 + P3 + P4 全 phase 改动已 commit clean
- P5 Step 5.4.5 前需先解决 Python distutils 环境问题让 pnpm dev 能跑
- **mental model 切换**：P4 是"纯写作 + spike4"（codex 视角 protocol / agent body 文档化）;**P5 是"review + fix + smoke test + changelog 写 + archive_plan"**（review 编排 + 真实 vitest/typecheck 跑 + dev runtime 验证 + 归档动作）— 不同 mental model 适合在新会话起手保持 context 清爽

## 跨会话注意（必读）

- **路径前缀**（user CLAUDE.md §Step 1 末 callout）：进 worktree 后，所有指向**代码资产**的路径必须含 `.claude/worktrees/codex-handoff-team-alignment-20260518/` 前缀。**例外**：plan 文件本身在 `<main-repo>/.claude/plans/`，不需要 worktree 前缀
- **node_modules 没在 worktree 装**：P2 / P3 实施时读源码请读主 repo `node_modules/.pnpm/...` 路径；如需在 worktree 跑 `pnpm typecheck` / `pnpm test`，先 `pnpm install` 在 worktree
- **本会话 hand_off 时 archive_caller 默认 true**：caller 归档后 SDK 进程退出，worktree 留给新 session 用
- **plan v4 文件本身不在 worktree**：plan 文件路径是 `<main-repo>/.claude/plans/`（main repo 不是 worktree）

## Agent 自主 hand-off 授权（2026-05-18 user 明示）

> **授权范围**：user 明示 "你一路推进吧，自己决定 hand off 时机点，这个授权写入到 plan 里"。本 plan 全程 agent 可**自主决定** hand-off 时机（不需要每次问 user），按 user CLAUDE.md §Step 2.5 「何时主动 hand off」自检逻辑触发即可。

**自检触发信号**（任一即考虑 hand-off）：
- 完成一个独立 phase（与下一 phase mental model 重叠度低，如 P1 → P2）
- 用户语义信号（「告一段落」/「换个会话继续」/「context 太满了」）
- context 达到 ≥ 60%（host 通过 system reminder 明示 token usage 时启用）

**前置条件**（必须全满足）：worktree clean（`git status` 空）+ plan「下一会话第一步」+「当前进度」节已更新好

**默认动作**：调 `mcp__agent-deck__hand_off_session({plan_id: 'codex-handoff-team-alignment-20260518', phase_label: '<下一 phase 标签>'})` 一行完成 baton + 归档；无需问 user

**前置不满足时**：worktree dirty → 先 commit；plan 节空 / 偏离 → 先写。

**例外（仍需问 user）**：
- 想中止 plan（`status: abandoned`）
- 想改 plan §设计决策 / §不变量（plan 滚动文档但设计决策变更需 user 同意）
- 跑双对抗 review 出 HIGH finding 影响后续 phase（如 P5 review 出新 HIGH，按 plan §P5 Step 5.3 fix review finding 内的指引）
- 跑 destructive 命令（`git reset --hard` / `git worktree remove --force` 等）

> 授权理由：本 plan 是 v4.1 已 finalize 的滚动文档（P-1 spike + v3 + v4 + v4.1 累计 17 + 11 finding 都 inline 修补完），无 design 大方向疑问；P1-P5 step 已写到行级，agent 按 plan 推进即可。user 仍可在任意时刻主动介入（看 plan 进度 / 改 plan / 终止）。

## P6 流程改进（v4 user 新增需求，P5 后跑；RFC 已完成定 design）

> 本章节是 v4 user 反馈：本轮 plan v1→v2→v3→v4 暴露出**plan 写作流程本身**的问题，需要沉淀经验到流程资产（CLAUDE.md / reviewer agent body / deep-code-review SKILL）。
>
> RFC 已与 user 走完 3 轮 AskUserQuestion 对齐 design 大方向 + 实施细节（详 §P6 RFC 决策汇总 节）。本 P6 部分由「agent 驱动 → 写 step → 走 deep-review → user confirm 进 worktree → 实施」（即新流程 enforce 本 P6 自身）。

### §P6 RFC 决策汇总（来自本会话 3 轮 RFC）

**新流程图（落到 user CLAUDE.md §复杂 plan 节）**：

```
触发 (§触发条件)
  ↓
Step 0  §RFC 前置  (agent 主动起 AskUserQuestion 多轮对齐 design)
  ↓
Step 0.5 §spike 前置 (agent 写 mini-runner 实测,输出 spike-reports/)
  ↓
Step 1  §Plan 写作 (agent Write plan 文件,inline RFC + spike 结论)
  ↓
Step 1.5 §Deep-Review (agent invoke deep-review SKILL,reviewer 出 finding,fix 直到通过)
  ↓
Step 2  user confirm → §EnterWorktree (agent 进 worktree,不再是 plan 写作前置)
  ↓
Step 3-N 实施 / hand-off / 完成
```

**§复杂 plan §触发条件拓宽**（**保留现有 2 bullet 不动**，仅在 bullet 1 内扩展子条件 + 新增 bullet 3）：
- 现状 bullet 1 不变：「预计跨 ≥ 2 个会话才能收口」（≥ 5 个非 trivial step / 跨多模块 / ≥ 数百行代码 / 当前会话已吃 ≥ 40-50% 上下文）
  - **v4.1 M3 修法**：bullet 1 子条件追加 「OR 含不确定 design / SDK 行为未知 / 需 spike 才能完成设计」
- 现状 bullet 2 不变：「破坏性 / 实验性改动，希望失败时整片回退」
- **新增 bullet 3**：「跨 adapter / 跨 schema / 跨进程边界改造」（独立代码量不大但牵动多底层组件）

**§RFC 前置（user CLAUDE.md 新节）**：
- 触发：§复杂 plan §触发条件 命中 OR 重要 design 决策（架构 / 选型 / 重构方向）OR 用户明示「商讨」「rfc」
- 形式：agent 主动用 AskUserQuestion 多轮（3-4 个 / 轮，2-3 轮内对齐）对齐 design 大方向 / 不变量 / 边界
- 输出：design 结论 inline 到 plan §设计决策节（每条决策含 RFC 来源 reference）
- agent 责任：识别"什么是不确定 / 重要 design 决策"，主动起 RFC，**不**让用户先发起

**§spike 前置（user CLAUDE.md 新节）**：
- 触发：RFC 阶段发现 SDK / 三方 lib 行为未知 / 关键假设未验证（"我想这样 design 但不知 SDK 是否支持"）
- 形式：写 mini-runner（Bash `run_in_background` 起外部 CLI / Python script / Node script），输出 `<plan-dir>/spike-reports/spike<N>-<topic>.md`
- 输出：spike 结论 inline 到 plan §设计决策（含实测铁证 + 残留风险）
- 与 §决策对抗 主路径关系：正交。§决策对抗 = 评审结论（双 Bash 起异构 CLI）；spike = 实测假设（单 runner 跑 SDK）。两者可叠加（spike 实证后仍可走对抗 review）

**§应用 CLAUDE.md (resources/claude-config/CLAUDE.md)**：
- §应用环境差异 节加 cross-ref 一句（指向 user CLAUDE.md §复杂 plan / §RFC / §spike）
- 加 §应用环境 RFC / spike 差异 placeholder 节（未来如有差异再填）

**§reviewer agent body**（claude-config 与 codex-config 双 root 共 4 个 file，详 P6.3）：
- 加 "sandbox 限制说明" 节（self-documenting，caller / 第三方 spawn reviewer 时知道有限制）
- 实际处理走 caller / SKILL 责任（不在 reviewer 内 detect）

**§deep-review SKILL（改名）**：
- 重命名：`deep-code-review` → `deep-review`（**chicken-egg 时序处理**：物理 `git mv` 推到 P6.7 user confirm 后；P6.5 meta-review 仍用老名 `/agent-deck:deep-code-review`；改完后保留 deep-code-review/ 作 deprecation stub，详 P6.4 + P6.7）
- scope typed schema：`{kind: 'code' | 'plan' | 'mixed', paths: string[]}` —— **caller 显式传 kind**，不依赖 path 后缀启发
- SKILL 内分流 reviewer prompt 模板：
  - kind='plan' → 关注设计 / 不变量 / 流程矛盾 / step 行级 reference 正确性 / 测试矩阵覆盖度
  - kind='code' → 关注 race / leak / 安全 / 测试覆盖 / 边角 case
  - kind='mixed' → 双模板（reviewer 同时审 plan 设计与 code 实施一致性）
  - **v4.1 M6 修法 — kind='mixed' 成本 / 失败兜底**：
    - **成本明示**：spawn 4 reviewer = 2x token + 2x time，user 调用前自察是否真需要 mixed（典型仅复杂 refactor 同时含 plan 设计 + code 实施一致性 review 时才用）
    - **失败兜底**：任一 reviewer fail → SKILL 不阻塞，其他 reviewer 仍给 finding；缺失方所属 mode（plan / code）finding 降级为「单方」非 HIGH（遵循 §决策对抗 三态裁决约定）
- SKILL 内自动 sandbox 处理：scope paths 含 worktree 外路径 → SKILL 自动 cp 临时副本进 worktree（`<worktree>/.deep-review-cache/<sha8>-<sanitized-basename>.md`，**v4.1 M4 修法**：hash 防冲突 + basename 增可读性 + manifest 防 cleanup 误删）→ 改 reviewer scope 用 cache 内 path
- cleanup 走 manifest：SKILL 调用前生成 `<worktree>/.deep-review-cache/<invocation-id>.manifest.json` 记录本次 cp 的 cache file 路径列表 → review 完后按 manifest 精确 rm（**不**走 `rm cache/*` 通配，避免并发 review 互相踩同名 basename）
- SKILL 触发关键词扩：「深度 review / 双对抗 review / plan 评审 / code review 多轮 / RFC 评审 / 再 review 一轮」
- **deprecation stub**（P6.7 落地）：保留 `deep-code-review/SKILL.md` 作 deprecation pointer（frontmatter `description: 已重命名 → /agent-deck:deep-review，请改用新名`），让老 slash command + 老触发关键词仍 resolve 到 stub（不 cold-fail）

### P6 实施 step（agent 驱动 P6.1-P6.6，P6.7 user confirm 后归档）

#### Step P6.1: A user CLAUDE.md 改造（**v4.1 H1 修法**：拆 4 sub-step，含授权 + backup + dry-run diff）

**Files**: `~/.claude/CLAUDE.md`（**user 全局配置文件**，⚠️ **非本仓库 git tracked + 跨项目跨会话 super-shared 资产 + 无 git history 兜底**，risky 改动必须走授权 + backup + dry-run）

**Sub-step P6.1a — dry-run diff**：

- agent 在改 user CLAUDE.md 之前，先在 worktree 内生成一份**改动后的预览版本**：
  - `cp ~/.claude/CLAUDE.md <worktree>/.user-claude-md-preview.md` （拿当前版本副本）
  - 在副本上做所有修订（按 §P6 RFC 决策汇总 §复杂 plan §触发条件 / §RFC 前置 / §spike 前置 / §Step 1.5 Deep-Review / §Step 2 EnterWorktree user confirm 约束 / 其他 step 顺延编号）
  - `diff -u ~/.claude/CLAUDE.md <worktree>/.user-claude-md-preview.md > <worktree>/.user-claude-md-preview.diff` 生成 patch

**Sub-step P6.1b — user ack**：

- 展示 `<worktree>/.user-claude-md-preview.diff` 给 user 看（或 SessionList UI 等价）
- 用 `AskUserQuestion` 等待 user 明确 confirm「我看过 diff，授权 agent 写入 ~/.claude/CLAUDE.md」
- user reject / 提修订 → 回 P6.1a 调整 preview，再 P6.1b 重新 ack

**Sub-step P6.1c — backup**：

- `cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak-$(date +%Y%m%d-%H%M%S)`（timestamp 后缀方便多次 backup 不冲突）
- 验证 backup 文件存在 + 大小一致

**Sub-step P6.1d — Edit ~/.claude/CLAUDE.md**：

- 用 Edit 工具按 P6.1a preview 内容写入 `~/.claude/CLAUDE.md`
- 验证写入成功 + diff 与 P6.1b 展示的一致
- `rm <worktree>/.user-claude-md-preview.md` + `rm <worktree>/.user-claude-md-preview.diff`（cleanup）
- 失败回滚：如 Edit 失败 / 中断 → 显示 backup 路径 `~/.claude/CLAUDE.md.bak-<ts>` 给 user，手工 `cp` 恢复

#### Step P6.2: B 应用 CLAUDE.md 改造（最小动）

**Files**: `resources/claude-config/CLAUDE.md`（在仓库 git tracked，agent 直接 Edit worktree 内副本）

**改动**：

- §应用环境差异 节加 cross-ref 一句：
  > `RFC + spike + 复杂 plan 流程详 user CLAUDE.md §复杂 plan / §RFC 前置 / §spike 前置`
- 加占位节 `§应用环境 RFC / spike 差异`（仅 placeholder：「当前与 user CLAUDE.md 同款；未来如有应用 SDK 会话专属差异在此填充」）
- 不重复 user CLAUDE.md 内容

#### Step P6.3: C reviewer agent body 加 sandbox 限制说明（**v4.1 M1 修法**：覆盖 4 个 reviewer body — 含 P4 新建的 codex-config 2 个）

**Files**（4 个 reviewer body）：

- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`（现有 claude-config）
- `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`（现有 claude-config）
- `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md`（P4 Step 4.2 新建 codex-config）
- `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md`（P4 Step 4.3 新建 codex-config）

**改动**（4 个 file 各自加同款节，按 adapter 视角调整 sandbox 行为描述）：

- **claude-config 视角**（claude SDK spawn reviewer）：
  ```markdown
  ## ⚠️ Sandbox 限制说明
  
  本 reviewer 由 claude-code SDK spawn，受 sandbox 限制（**只能访 worktree 内文件**）。
  scope 路径含 worktree 外（如 `~/.claude/plans/<plan>.md`）→ Read / Bash cat 直接拒。
  caller (lead) 走 deep-review SKILL 时 SKILL 自动 cp 临时副本进 worktree（详 SKILL.md `§sandbox 处理`）；
  绕开 SKILL 直接 spawn reviewer-claude 时, caller 自己负责把 worktree 外文件 cp / mount 进 worktree。
  ```

- **codex-config 视角**（codex SDK spawn reviewer，sandbox 行为不同）：
  ```markdown
  ## ⚠️ Sandbox 限制说明
  
  本 reviewer 由 codex-cli SDK spawn，受 sandbox 限制（sandbox=workspace-write 默认能 spawn 外部 CLI
  但**跨目录写仍受限**）。scope 路径含 worktree 外（如 `~/.claude/plans/<plan>.md`）→ 默认 Bash cat / read fs
  撞 sandbox 拒。caller 走 deep-review SKILL 时 SKILL 自动 cp 临时副本进 worktree；
  绕开 SKILL 直接 spawn 时，caller 应在 startThread option 显式加 `additionalDirectories: ['~/.claude', '~/.codex']`
  扩 sandbox 允许范围，或把 worktree 外文件 cp 进 worktree。
  ```

#### Step P6.4: D deep-review SKILL 改造（**v4.1 H2 修法**：拆 P6.4a/b 解 chicken-egg，**P6.4 不做物理 mv** — 物理 mv 推到 P6.7）

**chicken-egg 背景**（reviewer-codex HIGH-1+2 + reviewer-claude H-P6-3）：

- bundled-assets.ts:90-108 skill 注册按 `skills/<dir>/SKILL.md` 扫目录，`qualifiedName = agent-deck:<dir>`
- 现有 deep-code-review/SKILL.md:82 有 `⚠ SCOPE PATH MISMATCH` 校验（scope 路径前缀必须与 spawn cwd 同前缀；worktree 内必须含 `.claude/worktrees/<plan-id>/`）— 老 SKILL 无 P6.4b 才新增的 auto cp 逻辑
- 如 P6.4 直接 `mv deep-code-review/ deep-review/` → P6.5 调老名 `/agent-deck:deep-code-review` 找不到目录卡死

**Sub-step P6.4a — 改 SKILL.md 内容（保留 deep-code-review/ 目录名，不 mv）**：

- **Files**：`resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`（目录名 + 文件名不变）
- 改动：
  - frontmatter `name` **暂保持 `deep-code-review`**（P6.7 才改 `deep-review`）
  - frontmatter `description` 加 plan 评审关键词（向后兼容含老关键词）
  - SKILL.md body 改造：
    - args schema 改 scope typed: `{kind: 'code' | 'plan' | 'mixed', paths: string[]}`
    - 内嵌 3 套 reviewer prompt 模板（kind=code / plan / mixed）
    - 加 §sandbox 处理 节：auto cp 实现细节（**v4.1 M4 修法 — cache 命名 + manifest**）
      - cache file 名：`<worktree>/.deep-review-cache/<sha8>-<sanitized-basename>.md`（sha8 = sha256(原 abspath)[0:8]）
      - manifest：`<worktree>/.deep-review-cache/<invocation-id>.manifest.json`（记本次 cp 的 cache file 路径列表）
      - cleanup：按 manifest 精确 rm，不走 `rm cache/*` 通配
    - 加 §kind='mixed' 成本与失败兜底 节（**v4.1 M6 修法**）：成本 2x token + 2x time；任一 reviewer fail 不阻塞、缺失方所属 mode finding 降级单方非 HIGH
- **此时 P6.5 调 `/agent-deck:deep-code-review` 仍能 resolve**（目录名没变 + SKILL.md 内 frontmatter name 没变 + 内容已升级到新协议）

**Sub-step P6.4b — auto sandbox cp 落地（在老 SKILL 目录内实现，P6.5 直接受益）**：

- 在 SKILL.md body 实现 auto cp 逻辑（caller invoke SKILL 后 SKILL 第一步处理）
- 关键：让 P6.5 meta-review 时 scope 含 `~/.claude/CLAUDE.md`（worktree 外）的情况下，SKILL 自动 cp，不让 reviewer 撞 SCOPE PATH MISMATCH
- **如 SKILL.md body 是纯 prompt 描述**（auto cp 实际由 caller 走 Bash 跑）：plan 文案明示 "caller 在 invoke SKILL 后 SKILL 第一步指令 = caller Bash cp scope 外 file 进 cache + 生成 manifest" — 即 caller 走 SKILL.md 内嵌的 Bash 命令模板
- 验证：P6.4b 完成后 ad-hoc 测试 — invoke `/agent-deck:deep-code-review scope={kind:'plan', paths:['~/.claude/CLAUDE.md']}` → reviewer 看到 cache 内路径而非原 abspath，不撞 SCOPE PATH MISMATCH

#### Step P6.5: P6 改动 self-review（meta-review，**v4.1 H3 修法**：明示老 SKILL 已升级 + caller 预处理 cp）

**Files**: 5 个改动文件（`~/.claude/CLAUDE.md` 直接 read + 4 个 worktree 内文件）

**chicken-egg 处理（v4.1 修法）**：

- 经 P6.4a/b 改造，**老目录名 `deep-code-review` 仍在**（P6.7 才物理 mv），但 SKILL.md body 已升级到新协议（含 scope kind / auto cp / 3 模板分流 / 失败兜底）
- 所以 P6.5 调 `/agent-deck:deep-code-review` 找得到目录 + 拿到的是升级后的 SKILL → 可正常跑 meta-review
- **scope 含 `~/.claude/CLAUDE.md`（worktree 外）**：依赖 P6.4b 落地的 auto cp 逻辑，SKILL 自动 cp 到 `<worktree>/.deep-review-cache/`

**meta-review 调用**：

- invoke `/agent-deck:deep-code-review`（**老触发关键词仍可用，因 P6.4 没物理 mv**）
- args: `{kind: 'mixed', paths: ['~/.claude/CLAUDE.md', '<worktree>/resources/claude-config/CLAUDE.md', '<worktree>/resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md', '<worktree>/resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md', '<worktree>/resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md', '<worktree>/resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md', '<worktree>/resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md']}`
- kind='mixed' 因 P6 涉及 plan 设计（user CLAUDE.md / 应用 CLAUDE.md / SKILL.md 改动 = 设计文档级）+ code 一致性（reviewer agent body 改动 = 即将注入 SDK system prompt 的 prompt asset，准 code 性质）
- **caller 责任**：scope 含 `~/.claude/CLAUDE.md`（worktree 外）→ 依赖 P6.4b auto cp 落地（如 P6.4b 验证未通过，caller 需手动 `cp ~/.claude/CLAUDE.md <worktree>/.deep-review-cache/manual-CLAUDE.md` 兜底）
- focus：
  - user CLAUDE.md 改动：触发条件拓宽措辞 / 新 step 顺序 / RFC + spike 节内容是否完备
  - 应用 CLAUDE.md 改动：cross-ref 是否充分 / placeholder 是否合理
  - 4 个 reviewer agent body 改动：sandbox 说明是否清晰 / claude vs codex 两视角是否对称
  - SKILL 改动：scope kind 分流 / auto cache cp + manifest / kind='mixed' 成本兜底 / 是否漏 edge case（特殊字符 basename / 大文件 / 并发同名）
  - 新流程整体一致性：RFC → spike → plan → review → user confirm → worktree → 实施 流程在所有资产中表述一致
- 修 finding → 进 Step P6.6

#### Step P6.6: typecheck + dev 验证（**v4.1 L1 修法**：加 3 条 smoke + dev 重启提示）

**typecheck**：

- CLAUDE.md / agent body / SKILL.md 是 .md，无 typecheck；SKILL.md 含 yaml frontmatter，跑 lint（如有 SKILL.md schema validator 自动跑）

**dev 重启**（**关键，agent body / SKILL 都是 spawn-time / load-time 注入，dev 不重启就跑老 cached 版本**）：

```bash
# kill 老 dev process（重启前必须）
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9
pkill -f "electron-vite dev" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null

# 重启 dev
pnpm dev
```

**3 条 smoke test**（dev 起好后跑）：

1. **新名触发**：在主会话调 `/agent-deck:deep-code-review` （**老名！P6.6 仍是老名，P6.7 才物理 mv 改新名**） + args `{kind:'plan', paths:[<worktree>/test-plan.md]}` → 验证 plan 评审模板生效（reviewer 输出含 plan-specific finding 维度，如「步骤行级 reference / 测试矩阵覆盖 / RFC 决策合理性」）
2. **auto cp**：调 SKILL 时 scope 含 worktree 外路径（如 `~/.claude/CLAUDE.md`）→ 验证 SKILL 自动 cp 进 `.deep-review-cache/` + manifest 生成 + cleanup 精确（不删别 review 文件）
3. **reviewer agent body sandbox 说明节生效**：起 reviewer-claude teammate 看 prompt 头是否含 §Sandbox 限制说明 节（自动注入到 first turn prompt）

**dev 重启** smoke 全 pass 后才进 P6.7 物理 mv + user confirm。

#### Step P6.7: user confirm 后写 CHANGELOG_<next+1> + **物理 mv + deprecation stub**（v4.1 H2 修法）

**Sub-step P6.7a — user confirm SKILL 改名**：

- 用 AskUserQuestion 等待 user 明确 confirm「`/agent-deck:deep-code-review` → `/agent-deck:deep-review` 改名 + 保留 deep-code-review 作 deprecation stub」
- user confirm 后才走 P6.7b 物理 mv

**Sub-step P6.7b — 物理 git mv 目录 + 改 SKILL.md 内 frontmatter name + 加 deprecation stub**：

```bash
# 在 worktree 内跑
git -C <worktree> mv resources/claude-config/agent-deck-plugin/skills/deep-code-review resources/claude-config/agent-deck-plugin/skills/deep-review
```

- 改 `<worktree>/resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md` frontmatter `name: deep-code-review` → `name: deep-review`
- **新建 deprecation stub**：`<worktree>/resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`（**重新建目录 + 同名 SKILL.md 当 stub**）：
  ```markdown
  ---
  name: deep-code-review
  description: ⚠️ 已重命名 → /agent-deck:deep-review，请改用新名（本 SKILL 仅作 backward-compat stub，未来版本将移除）
  ---
  
  本 SKILL 已重命名为 `deep-review`，请调用 `/agent-deck:deep-review` 替代。
  
  新 SKILL 支持 `scope: {kind: 'code' | 'plan' | 'mixed', paths: string[]}` typed args 与 auto sandbox cp，
  老的 `deep-code-review` 名仅保留作 deprecation pointer，6 个月后版本移除。
  ```
- 验证：bundled-assets.ts:90-108 重新 scan 后 plugin manifest 有 2 个 SKILL（`agent-deck:deep-review` 主 + `agent-deck:deep-code-review` stub），都能触发，stub 返回 deprecation 提示

**Sub-step P6.7c — 写 CHANGELOG_<next+1>**：

- CHANGELOG 写明：
  - user CLAUDE.md §复杂 plan 流程升级（RFC + spike 前置 + Deep-Review + user confirm 进 worktree 新流程图）
  - resources/claude-config/CLAUDE.md cross-ref 加
  - 4 个 reviewer agent body sandbox 说明加
  - **deep-code-review SKILL 改名 deep-review**（breaking change，保留 deep-code-review 作 6 个月 deprecation stub）
  - 新 SKILL args typed scope + auto cache cp + manifest + kind='mixed' 成本 / 失败兜底
- 同步 changelog/INDEX.md

**Sub-step P6.7d — dev 重启 + 老名/新名兼容 smoke**：

- 重启 dev（kill 老 process + pnpm dev）
- ad-hoc `/agent-deck:deep-code-review` → 收到 deprecation 提示 + 指向 `/agent-deck:deep-review`
- ad-hoc `/agent-deck:deep-review` 正常跑

user 看 CHANGELOG + smoke 通过后 confirm 进 P6.8 archive_plan。

#### Step P6.8: archive_plan（本 plan 真正收口，**v4.1 M2 修法**：加 ExitWorktree 前置 + cwd/marker 检查）

**注意时序调整**：P5 Step 5.6 原 archive_plan 移到此处 — 本 plan 现在覆盖 P1-P6 全部，archive_plan 一次性收口。

**Sub-step P6.8a — 预检 worktree 状态**：

- `git -C <worktree> status --porcelain` 必须为空（worktree clean）
- 如非空 → commit 剩余改动（P6 所有改动）或 abort 让 user 决策

**Sub-step P6.8b — ExitWorktree（caller 必须先退）**：

- 调 `ExitWorktree(action: 'keep')` 把 caller cwd 切出 worktree（应用 CLAUDE.md §plan hand-off 自动化 archive_plan 明示要求 + 本 plan §不变量 5 archive_plan 预检改读 sessionRepo.cwd + marker）
- 如 caller 走过 P1 落地的 mcp `enter_worktree` 设过 marker → 调 `exit_worktree(action: 'keep')` 清 marker；如未走 mcp（直接 builtin EnterWorktree）→ 仅调 builtin `ExitWorktree(action: 'keep')`

**Sub-step P6.8c — 调 archive_plan**：

```ts
mcp__agent-deck__archive_plan({
  plan_id: 'codex-handoff-team-alignment-20260518',
  worktree_path: '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-handoff-team-alignment-20260518',
  base_branch: 'main',
  changelog_id: '<X+1>,<X+2>',  // P5 + P6 两个 CHANGELOG（csv format）
});
```

预期返回：`{ archived_path, commit_hash, branch_deleted: true, worktree_removed: true, plans_index_action: 'updated', final_status: 'completed', warnings: [], archived: 'ok', teammatesShutdown: { ... } }`

**接力会话 cwd / marker 状态**（P6 由不同 session 接力时）：

- 同会话场景（P5 → P6 不切 session）：marker 不动，cwd 仍在 worktree → P6.8b ExitWorktree 即可
- 接力会话场景（hand_off_session 从 P5 切到 P6）：新 session cold-start `EnterWorktree(path:<worktree>)` 进 worktree（user CLAUDE.md §Step 3 cold-start 流程）→ 接力会话仍走 P6.8b ExitWorktree
- 任一场景，P6.8 调 archive_plan 时**必须**满足：caller cwd 不在 worktree 内（或 cwd_release_marker == worktreePath，详 plan §不变量 5）

---

## 已知踩坑

1. **EnterWorktree CLI v2.1.112 stale base bug**：P0 已用 Bash `git worktree add` 显式 HEAD 作 base 避开
2. **codex SDK sandbox 限制**：Spike 3 已实测；Step 4.0 mini-spike 待跑（claude 嵌套 sandbox）
3. **agent-deck plugin agent body 加载时机**：spawn 时一次性注入，无法运行时刷新
4. **codex SDK 不支持 systemPrompt**：用 ~/.codex/AGENTS.md 静态注入 + agent body spawn-time 注入两条路径
5. **better-sqlite3 binding ABI**（项目 CLAUDE.md）：P1 / P2 跑 vitest 真测 SQLite 需要遵守清理脚本
6. **bundled-assets cache 预热顺序**（main/index.ts step 8.5）：P3 加 codex-config 加载必须保证在 spawn handler 第一次调用前完成
7. **Bash tool cd 触发 GVM_ROOT shell init 报错**（Spike 2 实测）：不 cd，直接绝对路径
8. **codex SDK `modelReasoningEffort: 'minimal'` 与 webSearch 冲突**（Spike 2 实测）：用 `'low'` 以上 + 显式 `webSearchEnabled: false`
9. **codex LLM 安全 alignment 拒读 "TOKEN" 字样**（Spike 2 实测 + v3 L2）：测试用中性变量名如 `SPIKE_LABEL` / `SPIKE_TAG`
10. **fastify 5 req.raw.auth 注入**（Spike 1 残留 / v3 M3）：P2 Step 2.2 内嵌 mini-spike 实测
11. **codex CLI MCP server entry 配置**（Spike 2 残留）：P2 Step 2.7 实地检查
12. **reviewer-claude 在 sandbox 限制下无法读 plan 文件**（v3 review 教训）：plan 在 `.claude/plans/` 外，claude sandbox 限只能访 worktree 内。未来 reviewer 走 plan review 时**必须**先把 plan 文件 cp 进 worktree（plan-driven worktree 内本来就该有 plan 副本 / 或调整 reviewer prompt 让 reviewer 通过 worktree-relative path 读）
13. **SKILL.md 内嵌 reviewer prompt 模板 vs ~/.claude/templates/reviewer-{claude,codex}.sh.tmpl 关系**（v4.1 L2 修法）：两份独立维护。
    - SKILL.md（应用打包 plugin 资产，`resources/claude-config/agent-deck-plugin/skills/<name>/SKILL.md`）内嵌的 3 套模板（kind=code/plan/mixed）**仅在 plugin SKILL 调用路径用**。plugin self-contained 约束 6 要求 SKILL.md 关键操作能独立执行（模板 inline）。
    - `~/.claude/templates/reviewer-{claude,codex}.sh.tmpl` 是 user 全局 §决策对抗 主路径（双 Bash 单次决策对抗起外部 CLI）用的 shell 模板，独立维护。
    - 两者**不共享**：plugin 是 SDK in-process / mcp-managed reviewer；user 全局是单次外部 CLI 起 reviewer。改一份不需要同步另一份（如果某天发现协议需对齐，按 §提示词资产维护 §约束 1 抽到中间层引用，但当前两套作用不同保持独立）。
