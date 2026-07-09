# CHANGELOG_198 — codex recover/restart 还原 reviewer spawn-time networkAccessEnabled + additionalDirectories

## 概要

修复 codex-cli adapter 断连恢复链的 cross-adapter parity 缺口：reviewer-codex teammate spawn 时
options-builder 注入的 `networkAccessEnabled: true` + `additionalDirectories: [~/.claude, ~/.codex, /tmp]`
两个 unsafe default **既不持久化也无 bridge fallback**，导致 app 重启 / dev hot reload / main crash
后 recover 重建 thread 丢失这俩 → reviewer-codex 失去 web search + 跨目录读 plan/config + /tmp 中间
文件能力。修法持久化两字段（v029）+ recover / restart 读回透传，完全镜像现有 `extraAllowWrite`(v019)
的 per-session resilience 模式。

来源：deep-review-project Batch 3（REVIEW_101 R1，reviewer-codex MED-2，反驳轮双方共识收窄为
recover-only follow-up）。plan `codex-recover-network-dirs-parity-20260602`（worktree 隔离 +
Plan agent 交叉验证全流程）。issue `30ca35a9-77a9-44cb-9c94-3578e4581f0f`。

## 设计要点

- **4 字段存活矩阵**：reviewer-codex spawn 注入 4 个 unsafe default —— `codexSandbox` 已 v008 持久化、
  `approvalPolicy` 有 `buildCodexThreadOptions ?? 'never'` fallback，唯独 `networkAccessEnabled` +
  `additionalDirectories` 既不持久化也无 fallback → recover 后丢失。
- **与 extraAllowWrite 关键区别**：extraAllowWrite 对 codex SDK runtime **不消费**（persist-only no-op，
  写入打 warn）；这俩 **runtime 真消费**（经 `buildCodexThreadOptions` → startThread/resumeThread 的
  ThreadOptions），故 persistSessionFields 写入**不打 warn**（同 setModel）。SessionRecord jsdoc 显式
  标明此区别，防 future 维护者误当 no-op 删 recover 透传。
- **存储格式**：`network_access_enabled INTEGER`（3 态 NULL=未设 / 0=false / 1=true，**不加 DEFAULT**
  保留 unset vs explicit-false 区分）；`additional_directories TEXT`（JSON string[]，同 extra_allow_write）。
- **better-sqlite3 boolean bind 坑**：better-sqlite3 拒绝 raw boolean bind（运行时 throw，typecheck
  抓不到）。所有写入 bind boolean→0/1 手转（upsert binds + setNetworkAccessEnabled）；rename 用
  `fromRow.*` SELECT * 拿到的 raw int 不转。DB 此前无任何 boolean 列先例。
- **recover 透传 `?? undefined`**：`false ?? undefined === false`（保留显式关网络）/ `null ?? undefined
  === undefined`（跳过走 SDK 默认）。`??` 只收敛 unset(null) 态，不误吞 false。
- **persist guard `!== undefined`**：networkAccessEnabled=false 是合法值，truthy guard 会漏掉显式 false。
- **restart 对称补齐**（用户确认）：restart-controller 已透传 model+extraAllowWrite+codexSandbox，
  本字段在 restart 是 runtime 真生效（用户手动切 reviewer-codex sandbox 档时恢复其能力），对称补齐。
- **rename 定性 = 防御性 parity**（非 spawn 救命）：spawn 路径 persistSessionFields 在
  startNewThreadAndAwaitId（内含 tempKey→realId rename）**之后**跑且写 realId 行，rename 拷不拷新列
  spawn 都不丢值；recoverer jsonl-missing 已改 fresh-cli-reuse-app + updateCliSessionId（不走 rename
  toExists=true 分支）。rename 仍改两分支纯为「OLD 整迁 NEW」不变量 + 与 model/extra_allow_write 对称。
- **claude-code adapter 零改动**：ClaudeCreateOpts / narrowToClaudeOpts / claude recoverer 都不含这俩；
  共享 sessions 表的 upsert / rowToRecord / rename 对 claude 行透明（恒 NULL）。

## 变更内容

### Layer 1 — Migration
- **新建 `src/main/store/migrations/v029_sessions_network_dirs.sql`** + 注册 `migrations/index.ts`：
  `ALTER TABLE sessions ADD COLUMN network_access_enabled INTEGER` + `additional_directories TEXT`
  （一文件两 ALTER，先例 v009）。

### Layer 2 — 持久化层
- `src/shared/types/session.ts`：`SessionRecord` 加 `networkAccessEnabled?: boolean | null` +
  `additionalDirectories?: string[] | null`（jsdoc 标明 runtime 真生效，区别 extraAllowWrite）。
- `src/main/store/session-repo/types.ts`：`Row` 加两列；`rowToRecord` int→bool 3 态映射
  （`== null ? null : === 1`）+ additional_directories 复用解析；**重命名** `parseExtraAllowWriteJson`
  → `parseStringArrayJson`（两列共用，去 extraAllowWrite 偏向）。
- `src/main/store/session-repo/core-crud.ts`：upsert INSERT/VALUES/UPDATE/binds 加两列（boolean→int
  手转）+ 新增 setter `setNetworkAccessEnabled` / `setAdditionalDirectories`（镜像 setExtraAllowWrite）。
- `src/main/store/session-repo/rename.ts`：toExists=false INSERT 列扩 21→23（raw int 不转）+
  toExists=true 覆盖块（network 用 `!= null` guard 让显式 0 也覆盖 / dirs truthy guard 同 extra_allow_write）。

### Layer 3 — persist 写入点
- `src/main/adapters/codex-cli/sdk-bridge/session-finalize.ts`：`PersistSessionFieldsArgs` 加两字段 +
  函数体 set 调用（**无 warn**，`!== undefined` guard 保留显式 false）。
- `create-session/create-session-new.ts` + `create-session-resume.ts`：persistSessionFields 调用补传。

### Layer 4 — recover 读回透传
- `recoverer/_deps.ts`：`CreateSessionThunk` 加两字段（recover 路径唯一类型瓶颈 — facade
  CreateSessionOpts 已有 + bridge createSession 整体透传无白名单丢弃）。
- `recoverer/recover-and-send-impl.ts`：normal-resume createThunk + maybeCodexJsonlFallback 调用透传
  `rec.* ?? undefined`。
- `codex-jsonl-fallback.ts`：`CodexJsonlFallbackOpts` 加两字段 + 内部 createSession 透传。

### Layer 4' — restart 对称
- `restart-controller.ts`：`RestartCreateOpts` 加两字段 + maybeCodexJsonlFallback 调用 + 直接
  createSession 调用透传（recover/restart 共用 CodexJsonlFallbackOpts）。

### Layer 5 — SDK 消费（零改动，已就绪）
- `create-session-impl.ts` 两分支已 spread 这俩进 `buildCodexThreadOptions`，`thread-options-builder.ts`
  已条件 spread —— 本 plan 不碰。

## 测试

- **新建 `v029-migration.test.ts`**（9 tests）：post-v029 两列存在 / 不传默认 NULL；v028→v029 升级老行
  NULL；rowToRecord int→bool 3 态 round-trip（1→true / 0→false / NULL→null）+ additional_directories
  JSON round-trip + parseStringArrayJson 防脏（非法 JSON / 空数组 → null）。
- **扩 `sdk-bridge.recovery.test.ts`**（+4 tests）：normal-resume 带 network/dirs → createCalls 携带 /
  null → undefined / **false 保留不被 ?? undefined 误吞** / jsonl-missing fallback fresh-cli-reuse-app 携带。
- **扩 `agent-deck-team-repo.test.ts`**（+3 tests）：renameWithDb toExists=false INSERT 跟列 /
  toExists=true 覆盖 / network 显式 0(false) 也覆盖（验 `!= null` guard 非 truthy）。
- 改测试 fixture：`makeSessionRepoMock` 加两 setter stub（load-bearing — 真 createSession 测试缺 stub
  会 crash）；`_setup.ts` (codex sdk-bridge) CreateSessionCall + override + capture 加两字段；两个 DB
  fixture `agent-deck-repos/_setup.ts`（→v029）+ `session-repo/__tests__/_setup.ts`（v026→v029）补 migration。
- 全量 **1752 tests 全绿**（Electron-as-node ABI 130，0 skip 0 regression，较 1736 +16）；typecheck
  node+web 双绿。

## Plan agent 交叉验证

实施前 Plan agent 独立 5 层 trace + grep 验证，捕获关键修正：
- **better-sqlite3 boolean bind throw**（lead 草案漏 — DB 无 boolean 列先例，typecheck 抓不到）。
- **rename 定性纠正**：lead 草案误写「spawn 丢值」，实际 persist ordering 已保 spawn 不丢，rename 是
  防御性 parity。
- 确认 CreateSessionThunk 是 recover 路径唯一类型瓶颈（facade/bridge 透传链无白名单丢弃）+ 测试 mock
  两 setter 必加 + claude adapter 零改动。
