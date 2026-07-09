# CHANGELOG_125 — codex-cli adapter 全面接入 hand_off / archive_plan / team mcp 编排（plan codex-handoff-team-alignment-20260518，6 路异构对抗 review × fix）

## 概要

让 codex-cli adapter 能完整使用 `hand_off_session` / `archive_plan` / team mcp 编排机制，解之前双对抗 review 发现的 3 个 HIGH 阻塞（HIGH-1 caller_session_id transport 注入 / HIGH-2 cold-start 协议 codex 不识别 / HIGH-4 NO MSG ANCHOR + Wire format 协议规约 codex 不可见 / HIGH-C archive_plan cwd_release_marker 4 态分流）。顺手解 EnterWorktree CLI v2.1.112 stale base bug + archive_plan 场景 C 解锁 + bundled assets 多 root 路由。

跨 5 phase + 22 commit + 71 file（6809+/167-）落地，最后 P5 收尾走 6 路异构对抗 review（3 batch × claude+codex 各 2 路 = 6 reviewer，含 1 路合规兜底 lead 自跑外部 codex CLI），裁决出 3 ✅ HIGH + 21 MED + 4 降级 MED + 多 LOW/INFO，全部 inline fix 落地（4 commit）。详 [REVIEW_46.md](../../reviews/history/REVIEW_46.md)（plan archive 后写）。

## 变更内容

### P1 — `cwd_release_marker` 数据流通解 HIGH-C

- 新增 `sessions.cwd_release_marker TEXT` 列（v020 migration）+ 双 setter (set/clear) + types + rowToRecord 映射
- `rename.ts` 19 → 20 列扩展 + toExists UPDATE 覆盖块同步 marker（fork 路径 + rename 路径两条 fallback 都不丢 marker；P5 Round 1 修法 toExists OLD null 也无条件覆盖防 stale 残留）
- 新增 2 个 MCP tool：`enter_worktree` / `exit_worktree`（codex / 跨 adapter caller 走 mcp 路径起 worktree → setMarker → archive_plan 4 态预检状态 (b) 放过）
- `archive-plan-impl.ts` 改 cwd 4 态分流（plan §不变量 5）— 完整支持 cwd valid / invalid 子状态：(a) cwd valid + !inWorktree + marker null → 放过 / (b) cwd invalid + marker==worktree → 放过 + release marker / (c) cwd valid + !inWorktree + marker present → warn + 放过 + release / (d) cwd invalid + marker null/mismatch → ERROR (cwd resilience guard rail)
- `archive-plan.ts` handler 加 `clearCwdReleaseMarker` thunk 注入 + cwd / marker 独立 fallback (LOW-5 修法)
- `sessionManager.markClosed/close` 加 hook 联动清 marker（防 stale marker 跟 SDK fork rename 路径）
- `exit-worktree-impl.ts` step 3 marker 比较前 realpath 解 symlink 与 archive-plan-impl 对称（M2 修法）
- `exit-worktree-impl.ts` 默认 `git branch -d` 拒删未合并 commit；`-D` 仅 discard_changes=true 强制（M4 修法）
- 测试矩阵 51 cases (29 P1 原 + 4 cwd-invalid TC11-14 H1 verification + 17 enter/exit + 1 LOW-6 polish)

### P2 — `caller_session_id` transport 注入解 HIGH-1（per-session token）

- 新建 `mcp-session-token-map.ts` per-session bearer token ↔ sessionId 双向 Map（spawn 时 allocate + 注入子进程 envOverride.AGENT_DECK_MCP_TOKEN）
- `HookServer.checkMcpAuth` 三态分流：per-session token map 命中 → resolvedSid + fallbackToGlobal=false / 不命中 → 比对全局 token → resolvedSid=null + fallbackToGlobal=true（视为 external caller deny 写）/ 都不 → 401
- `transport-http.ts` callerSessionIdOverride 走 `extra.authInfo.resolvedSid`（mcp-sdk 1.29 RequestHandlerExtra 链路；spike-p2-fastify5-mini 端到端实证）
- codex bridge `per-session Codex 实例`（替换原全局单例）+ sid 时序：initialSid → allocate(initialSid) → ensureCodex(initialSid, sessionToken) → envOverride frozen 注入子进程
- `sessionManager.renameSdkSession` 集成 `mcpSessionTokenMap.rename` + `sessionRenameHookFn` 派发 → codex bridge.renameCodexInstance 同步 4 处 key（sessions Map / sdkOwned / token map / codexBySession Map）原子一致
- **P5 Round 1 修法**：
  - **H2 (双方独立)**：createSession resume earlyErrCb 加 codexBySession.delete + mcpSessionTokenMap.release（防 recoverer 重试命中 dead Codex cache → MCP 401）
  - **B-claude M1**：thread-loop.ts resolveWithFallback 加 cleanupTempKey thunk（30s timeout / earlyErr 路径同款 leak）
  - **B-claude M3 / C-codex M3**：schemas.ts codex_sandbox 文案 + options-builder console.warn 让 reviewer-* override caller 显式值时不静默
  - **B-codex M1 / M2 clarify**：bridge approvalPolicy fallback 是 in-process 安全基线（与 reviewer-* unsafe default 语义不同）+ 4-key 不原子时 console.error prominent 提示 codex agent + hook 缺失严重 bug

### P3 — adapter routing + multi-root assets cascade 解 D3 矩阵

- `getAgentDeckPluginPath` 拆 adapter-aware（claude/codex 各自 helper）
- `bundled-assets.ts` 双 root scan（claude-config + codex-config）+ qualifiedName 升级 `agent-deck:<adapter>:<name>`（防同名冲突）+ AssetMeta `adapter` 字段 (breaking change, 6-caller cascade)
- `spawn.ts` agent_name 按 args.adapter 路由（D3 4 行矩阵；H4 关键修正：codex × claude wrapper → codex-config root）
- `agents-md-installer.ts` 源切到 `codex-config/CODEX_AGENTS.md`（D5 fallback 策略：缺失 throw 显式 error 不静默 fallback）
- `package.json` extraResources 同步加 `resources/codex-config`
- `options-builder.ts narrowToCodexOpts` 按 agentName='reviewer-*' 触发 4 字段 unsafe default spread（不变量 6 enforce 点）+ envOverrideExtra 注入 `AGENT_DECK_CLAUDE_PATH`（M7 reviewer-claude wrapper bundled claude binary）
- **P5 Round 1 修法**：
  - **C-claude MED**：删 `agent-deck-plugin-paths.ts` dispatcher 死代码（grep 0 production caller，违反 user CLAUDE.md §提示词资产维护 约束 2）
  - **C-claude LOW**：`compareAdapterThenName` `null → 2` dead branch narrow signature 删
- 测试矩阵 16 cases（D3 4 行 + multi-root + cascade exhaustiveness）

### P4 — codex 视角内容资产解 HIGH-2 + HIGH-4

- 写 4 个 codex 视角资产文件：
  - `resources/codex-config/CODEX_AGENTS.md` (178 行) — 应用环境总协议层（codex 视角，与 claude-config/CLAUDE.md 协议层完全对齐 + codex 工具差异）
  - `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md` (132 行) — codex × codex 同源 teammate body
  - `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md` (190 行) — codex × claude wrapper body（spike4 PASS 后不限「纯文本 review」）
  - `resources/claude-config/CLAUDE.md` 加 §enter/exit_worktree MCP 替代方案节
- spike4 mini-spike：claude -p `--permission-mode bypassPermissions` 嵌套 sandbox 实证 PASS（D3 矩阵 4 行全 feasible）
- options-builder default `additionalDirectories` 加 `/tmp`（spike4 follow-up — wrapper Bash 中间文件路径必需）
- **P5 Round 1 修法**：
  - **H3 (codex 单方 + spike runner 对照 + 实跑 claude --help 验证)**：reviewer-claude.md wrapper 删错误 `claude -C "<CWD>"` 参数（claude CLI 无 -C），改 `( cd "<CWD>" && claude -p ... )` 子 shell cd
  - **C-codex M1**：`CODEX_AGENTS.md enter_worktree 协议错 args + 返回字段对齐实际 schema（5 态 baseSource enum + branchName / markerSet 字段）
  - **C-codex M2**：两份文档 (CODEX_AGENTS.md + claude-config/CLAUDE.md)「archive 无条件」改「archive 默认 true,可 opt-out」与 schema archive_caller:false 对齐
  - **C-claude INFO**：CODEX_AGENTS.md 「严禁用 codex 自带 Read tool」措辞改 positive (codex CLI 默认无 Read tool 不构成 anti-pattern) + claude-config NO MSG ANCHOR adapter_filter 不对称加注释 (异构对偶设计意图)

### Settings 默认值调高（side task）

- `mcpSpawnRatePerMinute: 10 → 20`（deep-review 多 batch 并发场景留 buffer）
- `mcpMaxFanOutPerParent: 5 → 10`（6 reviewer 撞顶 + 反驳轮溢出修法）

## 不变量

- **不变量 5** — archive_plan 4 态分流 (cwd valid/invalid × marker null/match/mismatch)
- **不变量 6** — codex teammate spawn options enforce 点 = options-builder.narrowToCodexOpts（不在 bridge.startThread hardcode）
- **不变量 7** — `mcpSessionTokenMap.rename` 必须由 `sessionManager.renameSdkSession` 函数体调（不能让 caller 散调）

## Migration 路径

- `pnpm install` 自动跑 v020 migration（`PRAGMA user_version` 版本追踪幂等）
- 现有 sessions 记录 cwd_release_marker DEFAULT NULL 不破坏

## 验证

- `pnpm typecheck`：0 错
- `pnpm build`：成功
- `pnpm exec vitest run`：730 passed / 71 skipped (env binding limit 非 bug) / **0 failed**
- Step 5.4.5 smoke test (**部分通过**)：
  - ✅ codex-cli adapter spawn 链路（sessionId 返回 + adapter routing + agent_name resolution + agent body 注入正确）
  - ✅ options-builder reviewer-* 4 字段 unsafe default spread 触发（不变量 6 enforce 落地）
  - ✅ Codex bridge per-session Codex 实例 + envOverride.AGENT_DECK_MCP_TOKEN 注入子进程
  - ⚠ **runtime env block**：codex SDK 子进程 `failed to initialize in-process app-server client: Operation not permitted (os error 1)` → 在调 mcp tool 前 exit；macOS sandbox / TCC 权限层问题，非 P5 fix bug；per-session token 反查通路 + mcp tool 调用未实测（推到独立环境跑 fresh `pnpm dev` 验证或 follow-up plan）

## 关联 plan

- 主 plan：`plans/codex-handoff-team-alignment-20260518.md`（archive 后落 plans/ 入 git）
- 前置 spike：spike1（mcp-sdk extra.authInfo） / spike2（codex SDK 子进程 envOverride frozen） / spike3（codex sandbox-exec workspace-write） / spike4（claude -p 嵌套 sandbox PASS） / spike-p2-fastify5-mini（fastify 5 onRequest req.raw.auth 端到端）
- 后续：P6 流程改进（user checkpoint 决策）
