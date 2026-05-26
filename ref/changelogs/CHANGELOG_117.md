# CHANGELOG_117

## 概要

cross-adapter-parity-20260515 plan 收口（REVIEW_40 R1 reviewer-codex MED-F + R2 MED parity 限制双 follow-up 独立 plan）—— `sessions.extra_allow_write` 持久化全链路 + recoverer waiter Promise<string> signature。共 7 commit(Phase A 6 + Phase B 1 + Phase C review-fix 1 inline) / 16 文件 / +693/-54 LOC / typecheck 双端 + vitest 531/595 全过(64 skipped 是 better-sqlite3 ABI 环境问题)。详 [REVIEW_41.md](../reviews/REVIEW_41.md)。

> ⚠️ **编号说明**:本 changelog 编号原计划用 `114`,但 plan 收口期间 main 已被并行 plan(`hand-off-mcp-archive-opt-20260515`)抢先用 114 + `codex-sdk-bridge-tests-20260515` 用 115 + sdk-bridge-tests follow-up 用 116。rebase main 后 rename 至 `117`。

## 变更内容

### Phase A: extraAllowWrite 持久化全链路（6 commit）

#### Commit 1 — Phase A.1 migration v019（commit 21cead1）

- 新建 `src/main/store/migrations/v019_sessions_extra_allow_write.sql` ALTER TABLE ADD COLUMN TEXT
- `src/main/store/migrations/index.ts` 注册 v019(version 19)
- 字段值:JSON.stringify(string[])(全绝对路径)/ NULL = 不指定(语义同 caller 不传 extraAllowWrite,sandbox.allowWrite 仅含 cwd + /tmp + cache)
- 实现 REVIEW_40 R1 reviewer-codex MED-F follow-up:adapters/types.ts 原 jsdoc 承诺持久化但实际未实现(commit 8b607a1 已 jsdoc reflect reality 标 FUTURE 5 步路线)→ 本 plan 实装

#### Commit 2 — Phase A.2+A.3 session-repo + SessionRecord 字段（commit d24a19b）

- `src/shared/types/session.ts` SessionRecord.extraAllowWrite?: string[] | null + 详尽 jsdoc(典型场景 / 跨 adapter 行为差异 / 持久化层)
- `src/main/store/session-repo/types.ts`:
  - Row.extra_allow_write: string | null
  - rowToRecord 加 extraAllowWrite 字段
  - 新加 `parseExtraAllowWriteJson(raw)` defense-in-depth helper(JSON.parse try/catch + Array.isArray + filter typeof 'string' && length > 0 + 空数组 → null,与 parseGenericPtyConfigJson 同款防脏)
- `src/main/store/session-repo/core-crud.ts`:
  - upsert INSERT/UPDATE 加 extra_allow_write 列 + 参数绑定(JSON.stringify if 长度 > 0)
  - 新加 `setExtraAllowWrite(id, paths)` setter
- `src/main/store/session-repo/rename.ts` INSERT 列扩 17→19:
  - 同步加 model + extra_allow_write 两列
  - **顺手补 v018 sessions.model 在 rename.ts INSERT 列遗漏 latent bug**(toExists=false fallback path 模型字段未带过来 → resume 拿不到 spawn 时 frontmatter 设的 model,与 permission_mode REVIEW_17 R2/H1-R2 同款风险)
  - toExists=true 分支补 model + extra_allow_write 覆盖

#### Commit 3 — Phase A.4+A.5+A.6 claude 全链路（commit 4c06008）

- `src/main/adapters/claude-code/sdk-bridge/session-finalize.ts`:
  - FinalizeSessionStartArgs 加 extraAllowWrite?: readonly string[]
  - setExtraAllowWrite 写库(紧跟 setModel 后,同款 try/catch 兜底)
- `src/main/adapters/claude-code/sdk-bridge/index.ts`:
  - createSession 把 opts.extraAllowWrite 透传给 finalizeSessionStart
- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts`:
  - CreateSessionThunk 类型加 extraAllowWrite?: readonly string[] + 详尽 jsdoc
  - fallback / resume 双路径都从 rec.extraAllowWrite ?? undefined 读回 createThunk 透传(与 claudeCodeSandbox / model 同款显式透传)

#### Commit 4 — Phase A.7 codex 端 parity（commit 200cebd）

- `src/main/adapters/codex-cli/sdk-bridge/session-finalize.ts`:
  - PersistSessionFieldsArgs 加 extraAllowWrite?: readonly string[]
  - setExtraAllowWrite 写库 + warn「codex SDK 不消费 extra writable roots,仅持久化保对称」(与 model 字段同款语义)
- `src/main/adapters/codex-cli/sdk-bridge/index.ts`:
  - createSession opts 加 extraAllowWrite + 透传给 persistSessionFields(resume + 新建两路径)
- `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts`:
  - CreateSessionThunk 加 extraAllowWrite + fallback / resume 双路径从 rec.extraAllowWrite ?? undefined 读回
- 决策(plan §4): codex bridge 当前不消费但持久化字段对称 + future codex SDK 加支持时零迁移成本(与 codex_sandbox 持久化但 codex SDK 不接受 model override 同款语义)

#### Commit 5 — Phase A.8+A.9 jsdoc 反映现实 + regression test（commit 5a545e1）

- `src/main/adapters/types.ts` CreateSessionOptions.extraAllowWrite jsdoc:
  - 删「未持久化 — 仅 transient」chunk + 5 步 FUTURE 路线段(已实施)
  - 改「持久化 / 全 adapter 透传」+ 跨 adapter 行为差异说明(claude 全链路实装 / codex 字段持久化 parity 但 runtime 不消费 / aider+pty 不接收)
- `src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts` 加 3 case:
  - jsonl 不存在 + record extraAllowWrite=[mainRepo] → fallback 透传
  - 正常 resume + record extraAllowWrite=[mainRepo, anotherrepo] → 透传
  - record extraAllowWrite=null → 透传 undefined(历史 NULL 兜底)
- `_setup.ts` CreateSessionCall 加 extraAllowWrite + TestBridge.createSession 接收/捕获

### Phase B: recoverer waiter Promise<string> signature（1 commit）

#### Commit 6 — Phase B.1+B.2+B.3+B.4（commit f95e09d）

- claude + codex `recoverer.recoverAndSend` signature 改 `Promise<string>` 返 final session id:
  - inflight 等待者 path: `try { finalId = await inflight as string } catch { finalId = sessionId }` → `sendThunk(finalId, text, atts)` 用 NEW sid 不再撞 OLD not found
  - IIFE 改 `Promise<string>`:fallback path 返 newRealId / resume path 返 sessionId
  - outer try/catch 改 `return await p` 返 finalId 给 caller
- `src/main/adapters/{claude-code,codex-cli}/sdk-bridge/index.ts` bridge sendMessage 调用方加注释说明 caller 不消费返回值但等待者 path 经 inflight 同款 finalId
- 实现 REVIEW_40 R2 reviewer-codex MED parity 限制治法:修前 Promise<void> waiter 等 inflight 后用 OLD sessionId 调 sendThunk → bridge.sendMessage(OLD) 内 sessions Map miss → 又进 recoverAndSend → sessionRepo.get(OLD)=null(rename DELETE OLD row) → throw "not found" 用户体感「第二条消息消失」
- regression test:加 1 case「parity-plan B.4: 2 并发 sendMessage + jsonl missing fallback rename → 第二条 waiter 拿 newRealId 不撞 not found」(配套 _setup.ts 加 interceptSidSet seam 让 caller 显式控哪些 sid 走 capture path)

### Phase C: 异构对抗 review × 3 MED fix（1 commit）

详 [REVIEW_41.md](../reviews/REVIEW_41.md)。**reviewer-claude sandbox 锁 cwd 失败**(应用 SDK 子进程沙箱 default deny 写,reviewer-claude 没读到任何源码)→ 6 条 *未验证* MED 全部 ❌ 不计入,严守 user CLAUDE.md「reviewer-codex 失败兜底」反向应用(严禁同源化降级)。reviewer-codex gpt-5.5 xhigh 4 finding 全部 lead grep 现场实证。

#### Commit 7 — REVIEW_41 MED-1+MED-2+MED-3 fix（commit 779a050）

- **MED-1** — codex `CodexCliAdapterImpl.createSession` 完全没接 extraAllowWrite 字段 → spawn handler / hand_off_session 透传给 codex adapter 的 extraAllowWrite **完全断档** → bridge 永远收 undefined → setExtraAllowWrite 永远 skip → codex 端 parity 完全没生效(plan §A.7 实施漏洞)。fix:
  - `src/main/adapters/codex-cli/index.ts` createSession opts 加 extraAllowWrite 字段 + 透传给 bridge.createSession
- **MED-2** — claude/codex recoverer resume path 固定 `return sessionId`,但 stream-processor implicit fork case (`if (resumeId !== realId)` 触发 renameSdkSession) 时 createSession 返 NEW realId,等待者拿 OLD sessionId 仍撞 not found(plan §B 主路径只覆盖 50%)。fix:
  - `src/main/adapters/claude-code/sdk-bridge/recoverer.ts` resume path 拿 handle.sessionId
  - `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts` 同款(codex 实测不 fork 但写法对称 future-proof)
  - regression test:`_setup.ts` 加 forkOnResumeOverride seam + 新 case「REVIEW_41 MED-2 fix:resume implicit fork → 第二条 waiter 拿 forked-id 不撞 not found」
- **MED-3** — claude restart-controller restartWithPermissionMode + restartWithClaudeCodeSandbox 冷重启路径调 createSession 时不带 extraAllowWrite → 用户切 acceptEdits/bypass / 切 OS sandbox 档冷重启后 SDK 子进程 sandbox.allowWrite 不含原 mainRepo 写 plan 文件静默失败。fix:
  - `src/main/adapters/claude-code/sdk-bridge/restart-controller.ts` RestartCreateOpts 加 extraAllowWrite + 两条冷切路径 createSession 透传 rec.extraAllowWrite ?? undefined(顺手补 restartWithPermissionMode 漏传 claudeCodeSandbox 也修上)

### LOW-1 / 6 条 reviewer-claude *未验证* MED 不修

- **LOW-1** (extra_allow_write 缺 path.isAbsolute runtime 校验):信任边界内不修留 follow-up plan
- **reviewer-claude 6 条 *未验证* MED**:全部 ❌ 不计入(详 REVIEW_41 三态裁决表 — lead grep 实证已覆盖每条 reviewer-claude 抽查方向,无需重修)

## Follow-up

- **path-isabsolute-validation**: extra_allow_write zod refine + reject 非绝对路径(LOW-1)
- **reviewer-claude sandbox 锁 cwd 修复**: 调研 `claude -p` 启动时为何 cwd 被锁到 node_modules/.pnpm/electron — 影响所有 claude reviewer 用本模板的场景
- **adapter-architecture-design-20260515**: R40 follow-up #1 P4 BaseAdapter / #3 跨 adapter sandbox 继承 / #2 scheduler 命名(后续 P2 design hand-off)
