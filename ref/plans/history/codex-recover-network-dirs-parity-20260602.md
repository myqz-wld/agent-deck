---
plan_id: "codex-recover-network-dirs-parity-20260602"
created_at: "2026-06-02"
status: "completed"
base_branch: "main"
base_commit: "0d2bb1d"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-recover-network-dirs-parity-20260602"
issue_id: "30ca35a9-77a9-44cb-9c94-3578e4581f0f"
final_commit: "95caa4a3938399a649f5e6aec7136a97b546d2d4"
completed_at: "2026-06-02"
---
# codex recover 重建 thread 丢失 reviewer spawn-time 的 networkAccessEnabled + additionalDirectories

## Context（为什么做这个改动）

**问题**：reviewer-codex teammate spawn 时，`options-builder.ts` 的 `narrowToCodexOpts` 在 `isReviewerAgentName` 分支注入 4 个 unsafe default。其中 `networkAccessEnabled: true` + `additionalDirectories: [~/.claude, ~/.codex, /tmp]` **既不持久化到 sessions 表、也无 bridge fallback default**。

**后果**：app 重启 / dev hot reload / main crash 后 → sessions Map miss → recover 路径（`recover-and-send-impl.ts` 正常 resume + `codex-jsonl-fallback.ts` jsonl-missing fallback）的 createSession 不重传这俩 → `create-session-impl.ts` 读到 `undefined` → `buildCodexThreadOptions` 条件 spread 跳过 → SDK 走默认（无网络访问 + 无额外可读写目录）→ recover 后的 reviewer-codex **失去 web search + 跨目录读 plan/config + /tmp 中间文件能力**，与 reviewer body 的长会话契约不一致。

**来源**：deep-review-project Batch 3（REVIEW_101 R1，reviewer-codex MED-2，反驳轮双方共识收窄为 recover-only follow-up）。

**对比现状（4 字段存活矩阵）**：

| 字段 | spawn 注入 | 持久化 | bridge fallback | recover 后存活 |
|---|---|---|---|---|
| `codexSandbox` | ✅ | ✅ v008 | — | ✅ recover 透传 `rec.codexSandbox` |
| `approvalPolicy` | ✅ | ❌ | ✅ `buildCodexThreadOptions ?? 'never'` | ✅ 兜底 |
| **`networkAccessEnabled`** | ✅ | ❌ | ❌ | **❌ 丢失** |
| **`additionalDirectories`** | ✅ | ❌ | ❌ | **❌ 丢失** |

**修法**：采用 issue 方案 (a) —— 持久化两字段 + recover/restart 读回透传，**完全镜像现有 `extraAllowWrite`(v019, CHANGELOG_114/117, REVIEW_40/41) 的 cross-adapter parity 模式**。

**预期结果**：recover/restart 后 reviewer-codex 从 sessions 表读回这俩 spawn-time default 重新交还 codex SDK，长会话能力一致。

## 设计决策（已对齐，不再争论）

1. **存储格式**：`network_access_enabled INTEGER`（NULL=未设 / 0=false / 1=true，3 态，**不加 DEFAULT**——保留 unset vs explicit-false 区分）；`additional_directories TEXT`（JSON.stringify(string[])，与 `extra_allow_write` 同款）。boolean 走 INTEGER 是 SQLite 惯用法，DB 中无其它 boolean 列先例（migrations grep 确认 INTEGER 全是 timestamp/count）。
2. **better-sqlite3 boolean 转换（关键坑，Plan agent 交叉验证发现）**：better-sqlite3 **拒绝 raw boolean bind**（运行时 throw，typecheck 抓不到）。所有**写入 bind** 必须 `boolean → 0/1` 手转：`rec.networkAccessEnabled == null ? null : (rec.networkAccessEnabled ? 1 : 0)`。`rename.ts` 的 bind 用 `fromRow.network_access_enabled` 是 `SELECT *` 拿到的 **raw int**，无需转换。
3. **additional_directories 解析**：重命名 `parseExtraAllowWriteJson` → `parseStringArrayJson`（已是通用 `string[]` JSON 解析器，唯一问题是名字偏 extraAllowWrite），两列共用。同 commit 同步更新现有 `rowToRecord` extraAllowWrite 调用点（否则 typecheck 断）。
4. **migration**：一个文件两 `ALTER TABLE`（先例 v009 `spawned_by`+`spawn_depth`；`db.ts` `db.exec` 支持多语句）。版本 v029（v028 token_usage 为当前 max，无冲突）。
5. **persist 不抄 extraAllowWrite 的 warn**：`extraAllowWrite` 对 codex runtime 不消费故只 warn；这俩**是 runtime 真消费**的（经 `buildCodexThreadOptions` → startThread/resumeThread）→ 用 `setModel` 同款 plain try/catch，**不要 warn**。
6. **persist guard 用 `!== undefined` 不用 truthy**：`networkAccessEnabled=false` 是文档化合法值（`thread-options-builder.test.ts` 已覆盖），truthy guard 会漏掉显式 false。`additionalDirectories` 同 extraAllowWrite 用 `!== undefined && length > 0`。
7. **recover 透传用 `?? undefined`**：`false ?? undefined === false`（保留）、`null ?? undefined === undefined`（跳过→SDK 默认）。`??` 只收敛 unset(null) 态。
8. **restart 路径对称补齐**（用户确认）：`restart-controller.ts` 已透传 model+extraAllowWrite+codexSandbox，且 `CodexJsonlFallbackOpts` 是 recover/restart 共用类型。补这俩成本极低 + 这俩在 restart 是 runtime 真生效（不像 extraAllowWrite no-op），用户手动切 sandbox 档时真正恢复 reviewer 能力。
9. **claude-code adapter 零改动**（已验证）：`ClaudeCreateOpts`/`narrowToClaudeOpts`/claude recoverer 都不含这俩；共享 sessions 表的 upsert/rowToRecord/rename 对 claude 行透明（恒 NULL）。
10. **rename.ts 改动定性 = 防御性 parity（不是 spawn 救命）**：Plan agent 纠正——spawn 路径 persist 在 `await startNewThreadAndAwaitId`（内含 tempKey→realId rename）**之后**跑且写 `internal.applicationSid`(=realId)，所以 rename 拷不拷新列 spawn 都不丢值。rename 仍要改两分支，理由是「OLD 整迁 NEW」不变量 + 与 model/extra_allow_write 对称（toExists=true 分支当前对 recoverer 已 dead，纯防御）。

## 不变量

1. **普通 codex session / claude session 不被污染**：这俩 default 仅 reviewer-* spawn 由 options-builder 注入；持久化层对非 reviewer 行恒 NULL。
2. **applicationSid 稳定**：本改动只加列 + 透传，不动 sessions.id / rename 的 id 迁移语义。
3. **persist 永不阻塞会话启动**：set 调用 try/catch 兜底（同 setModel）。
4. **SDK 消费层已就绪零改动**：`create-session-impl.ts` 两分支已 spread 这俩进 `buildCodexThreadOptions`，`thread-options-builder.ts` 已条件 spread。本 plan 不碰 Layer 5。

## 改动清单（按实施顺序 + checkpoint）

> **实施完成**（2026-06-02）：全 9 步落地，typecheck node+web 双绿 + build 三端绿 + **1752 tests 全绿**
> （较基线 1736 +16：v029 migration 9 + recovery 透传 4 + rename 3）。worktree 隔离验证（worktree dirty /
> main repo clean）。Plan agent 交叉验证捕获 better-sqlite3 boolean-bind 坑 + 纠正 rename 定性。

### Step 1 — Migration v029（Layer 1）✅
- 新建 `src/main/store/migrations/v029_sessions_network_dirs.sql`：
  - `ALTER TABLE sessions ADD COLUMN network_access_enabled INTEGER;`（注释：3 态 NULL/0/1，无 DEFAULT）
  - `ALTER TABLE sessions ADD COLUMN additional_directories TEXT;`（注释：JSON string[]，同 extra_allow_write）
  - 头部注释说明：reviewer-codex spawn-time default 持久化，cross-adapter parity，镜像 v019
- `src/main/store/migrations/index.ts`：import v029 + push `{ version: 29, name: 'sessions_network_dirs', sql: v029 }`
- **checkpoint**：`zsh -i -l -c "pnpm typecheck"`（无行为变化）

### Step 2 — 持久化类型 + 解析（Layer 2a）
- `src/shared/types/session.ts` `SessionRecord`：加 `networkAccessEnabled?: boolean | null` + `additionalDirectories?: string[] | null`。jsdoc 注明：**仅 codex reviewer-* spawn 写，claude + 普通 codex 恒 null；与 extraAllowWrite 不同——这俩 codex runtime 真生效**（经 buildCodexThreadOptions → startThread/resumeThread），future 维护者勿当 extraAllowWrite no-op 语义而删 recover 透传。
- `src/main/store/session-repo/types.ts`：
  - `Row` 加 `network_access_enabled: number | null` + `additional_directories: string | null`
  - `rowToRecord`：`networkAccessEnabled: r.network_access_enabled == null ? null : r.network_access_enabled === 1` + `additionalDirectories: parseStringArrayJson(r.additional_directories)`
  - **重命名** `parseExtraAllowWriteJson` → `parseStringArrayJson`（jsdoc 更新为通用 string[] 解析）；同步改本文件内 extraAllowWrite 调用点

### Step 3 — core-crud upsert + setter（Layer 2b）
- `src/main/store/session-repo/core-crud.ts` `upsert`：
  - INSERT 列清单 + VALUES 占位 + ON CONFLICT UPDATE SET 各加 `network_access_enabled` / `additional_directories`
  - binds：`network_access_enabled: rec.networkAccessEnabled == null ? null : (rec.networkAccessEnabled ? 1 : 0)`（**boolean→int**）；`additional_directories: rec.additionalDirectories && rec.additionalDirectories.length > 0 ? JSON.stringify(rec.additionalDirectories) : null`
  - 加注释（同现有 codex_sandbox 注释风格）：不带列会被 lifecycle 复活 spread 静默丢弃
- 加 setter `setNetworkAccessEnabled(id, enabled: boolean | null)`（bind `enabled == null ? null : (enabled ? 1 : 0)`）+ `setAdditionalDirectories(id, dirs: string[] | null)`（镜像 setExtraAllowWrite）
- **checkpoint**：typecheck

### Step 4 — rename 两分支（Layer 2c，防御性 parity）
- `src/main/store/session-repo/rename.ts`：
  - toExists=false INSERT：列清单 21→23 + 占位 + binds（用 `fromRow.network_access_enabled` / `fromRow.additional_directories` **raw int/string，不转换**）
  - toExists=true：加覆盖块（镜像 L263 `extra_allow_write` 块）：`if (toExists && fromRow.network_access_enabled != null)` + `if (toExists && fromRow.additional_directories)`
  - 注释定性：防御性 parity（参 Plan agent 纠正，不写「spawn 丢值」错误理由）

### Step 5 — persist 写入点（Layer 3）
- `src/main/adapters/codex-cli/sdk-bridge/session-finalize.ts`：
  - `PersistSessionFieldsArgs` 加 `networkAccessEnabled?: boolean` + `additionalDirectories?: readonly string[]`
  - 函数体加：`if (networkAccessEnabled !== undefined) { try { sessionRepo.setNetworkAccessEnabled(sessionId, networkAccessEnabled) } catch ... }`（**无 warn**，jsdoc 注明 runtime 真生效）；`if (additionalDirectories !== undefined && additionalDirectories.length > 0) { ... setAdditionalDirectories([...additionalDirectories]) }`
- `create-session/create-session-new.ts` + `create-session/create-session-resume.ts` 的 `persistSessionFields(...)` 调用：补 `networkAccessEnabled: opts.networkAccessEnabled, additionalDirectories: opts.additionalDirectories`
- **checkpoint**：typecheck

### Step 6 — recover 读回透传（Layer 4）
- `src/main/adapters/codex-cli/sdk-bridge/recoverer/_deps.ts` `CreateSessionThunk`：加 `networkAccessEnabled?: boolean` + `additionalDirectories?: readonly string[]`（这是 recover 路径**唯一类型瓶颈**——facade `CreateSessionOpts` 已有这俩，bridge `createSession(opts)` 整体透传 `createSessionImpl` 无白名单丢弃，thunk wiring `(createOpts) => this.createSession(createOpts)` 也无需改）
- `recover-and-send-impl.ts` 正常 resume 的 `createThunk(...)` 调用（L392 区，挨着 codexSandbox/model/extraAllowWrite L405-407）：加 `networkAccessEnabled: rec.networkAccessEnabled ?? undefined, additionalDirectories: rec.additionalDirectories ?? undefined`
- `recover-and-send-impl.ts` 调 `maybeCodexJsonlFallback(...)` 的 opts（L326 区，挨着 L354-356）：传 `networkAccessEnabled: rec.networkAccessEnabled ?? undefined, additionalDirectories: rec.additionalDirectories ?? undefined`
- `codex-jsonl-fallback.ts`：`CodexJsonlFallbackOpts` 加这俩字段 + 内部 `ctx.createSession(...)` 调用（L208 区，挨着 `extraAllowWrite: opts.extraAllowWrite` L217）透传

### Step 7 — restart 对称（Layer 4'，用户确认补齐）
- `src/main/adapters/codex-cli/sdk-bridge/restart-controller.ts`：
  - `RestartCreateOpts` 加这俩字段
  - `maybeCodexJsonlFallback(...)` 调用（L236 区）传 `networkAccessEnabled: rec.networkAccessEnabled ?? undefined, additionalDirectories: rec.additionalDirectories ?? undefined`
  - 直接 `createSession(...)` 调用（L293 区，挨着 model/extraAllowWrite L302-303）透传同款
- **checkpoint**：typecheck

### Step 8 — 测试 mock 基建（必做，否则真 createSession 测试 crash）
- `src/main/__tests__/_shared/mocks/session-repo.ts` `makeSessionRepoMock`：加 `setNetworkAccessEnabled: vi.fn()` + `setAdditionalDirectories: vi.fn()`（**load-bearing**：`create-session-thread-id-init.test.ts` / consume-fork / early-err-cleanup 跑真 `createSessionImpl` → 真 `persistSessionFields`，缺 stub 会 "setNetworkAccessEnabled is not a function" crash）
- `src/main/adapters/codex-cli/__tests__/sdk-bridge/_setup.ts`：`CreateSessionCall` interface + `TestCodexBridge.createSession` override 的 opts 类型 + `createCalls.push({...})` 捕获，都加这俩字段（否则 recovery test 断言读不到新字段）
- **checkpoint**：`zsh -i -l -c "pnpm typecheck"` + `zsh -i -l -c "pnpm test"`（mock 缺失在此暴露）

### Step 9 — 新增/扩展测试（Layer 测试矩阵）
见下方测试矩阵。
- **checkpoint**：`zsh -i -l -c "pnpm typecheck && pnpm test"` 全绿

## 测试矩阵

| 区域 | 文件 | case |
|---|---|---|
| migration | 新建 `v029-migration.test.ts`（仿 in-memory migration 测试模式，参 `session-repo/__tests__` 或现有 migration 测试） | 列存在；老行 → NULL；0/1/NULL 经 rowToRecord round-trip 为 false/true/null |
| persist(new) | 扩 recovery mock 断言或 `create-session-thread-id-init.test.ts` | reviewer spawn → `setNetworkAccessEnabled(realId, true)` + `setAdditionalDirectories(realId, [...])` 被调；普通 codex → 不调（undefined 跳过） |
| persist(resume) | `sdk-bridge.recovery.test.ts` | record 带这俩 → createCalls 携带 |
| recover normal-resume | `sdk-bridge.recovery.test.ts` | record network=true+dirs=[...] → createCalls[0] 有这俩；network=null/dirs=null → 两者 undefined |
| recover jsonl-fallback | `sdk-bridge.recovery.test.ts`（jsonlExistsOverride=false） | 两字段经 fresh-cli-reuse-app createSession 透传 |
| restart 对称 | restart 相关测试（如有）/ 新 case | restart createSession + fallback 携带这俩 |
| rename INSERT/override | `agent-deck-team-repo.test.ts` 或 `session-repo/__tests__`（renameWithDb） | toExists=false 拷两列；toExists=true 覆盖 fromRow 值 |
| teammate-spawn-defaults | `teammate-spawn-defaults.test.ts` | **无需改**——它断 options-builder 输出（未变），持久化是下游。确认 out of scope |
| thread-options-builder | `thread-options-builder.test.ts` | 已覆盖条件 spread + false 合法值，**无需改** |

## 已知坑（实施时盯紧）

1. **better-sqlite3 boolean bind throw**（最高）：upsert bind + setter 必须 boolean→0/1；rename 用 raw row int 不转。typecheck 抓不到，只在 runtime 炸。
2. **persist guard `!== undefined` 不用 truthy**：否则 explicit false 被吞。
3. **`?? undefined` 别"修"成 `||`**：`||` 会把 false 当 falsy 误丢。
4. **测试 mock 2 setter 必加**：真 createSession 测试在 test-run 才暴露（非 typecheck）。
5. **parse 重命名连带改**：`parseStringArrayJson` 改名后同 commit 更新 rowToRecord 现有 extraAllowWrite 调用，否则 typecheck 断。
6. **jsdoc 准确性**：`SessionRecord` / `session-finalize` jsdoc 必须标明这俩 **runtime 真生效**（区别 extraAllowWrite persist-only no-op），防未来误删 recover 透传。
7. **rename 定性别写错理由**：是防御性 parity，不是 spawn 救命（persist ordering 已保 spawn 不丢）。

## 验证（end-to-end）

```bash
# 0. typecheck + 全量测试（worktree 内绝对路径）
zsh -i -l -c "cd <worktree> && pnpm typecheck"
zsh -i -l -c "cd <worktree> && pnpm test"

# 1. 重点跑改动相关测试
zsh -i -l -c "cd <worktree> && pnpm exec vitest run src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts"
zsh -i -l -c "cd <worktree> && pnpm exec vitest run src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts"
# migration / rename 测试按 Step 9 落点跑
```

**手动 e2e（可选，需打包验证 reviewer-codex recover）**：起 simple-review/deep-review spawn reviewer-codex teammate → 重启 app → lead send_message → 确认 recover 后的 reviewer-codex 仍能 web search + 读 ~/.claude plan（日志看 `buildCodexThreadOptions` 收到 networkAccessEnabled=true + additionalDirectories）。属重型验证，单测矩阵已覆盖核心链路，e2e 视情况。

## 收尾

- changelog：`ref/changelogs/CHANGELOG_X.md`（功能/parity 修复）+ 同步 INDEX
- 完成走 archive_plan（base_branch=main，传 changelogId）
- 关联 issue：处理完调 `update_issue_status({ issueId: "30ca35a9-77a9-44cb-9c94-3578e4581f0f", status: "resolved", note: ... })`

## 下一会话第一步（若需接力）

1. `Bash: cat <plan-abs-path>` 全文
2. `EnterWorktree(path: <worktree_path>)`
3. 按改动清单 Step 1 起（migration v029）；所有代码路径加 `.claude/worktrees/codex-recover-network-dirs-parity-20260602/` 前缀
4. 每个 Step 后跑对应 checkpoint
