---
plan_id: "deep-review-batch-a1-b-followup-r3-20260519"
created_at: "2026-05-19T15:00:00+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-batch-a1-b-followup-r3-20260519"
status: "completed"
base_commit: "074782eb5101adf320716ad6e3fdf16f908e55ce"
base_branch: "main"
final_commit: "9ed55c4f349431aa23f6efe0c1dd189ea3c6f171"
completed_at: "2026-05-19"
---
# Plan: R3 follow-up — 5 HIGH + 9 真 MED + F1/F2 用户反馈

## 总目标

上轮 plan `deep-review-batch-a1-b-fixes-20260519` (commit `074782e` 已归档) 完成 fix + R3 verify 重 spawn 4 reviewer fresh review 发出的 **5 HIGH + 9 真 MED + 2 用户反馈**，按双对抗 + RFC + spike 实证，全量 follow-up 处理 + R3 reviewer fresh review 兜底。

## 不变量

1. **SDK first-id race 不再有覆盖窗口** — H1+H2 修法后 fallback fire / createSession throw 路径 SDK 真发的 first id frame **不能** 覆盖 fallback 已设的 fallbackId / 已 mutate 的 sessions Map（即使 SDK 仍 emit first id frame in-flight，consume guard 也必须挡住）
2. **DB/UI ↔ internal cache 单一源（跨字段约束）** — 凡 internal cache 镜像 sessionRepo 字段（permissionMode / cwd / claudeCodeSandbox / extraAllowWrite / model），任一方向 update 必同时更新两边。**本轮 fix 只修 permissionMode 路径（D7 / Phase 3）**；其他字段 cache split 风险作为后续 review focus 立项，不在本 plan 修
3. **P0 regression test 端到端断言真实生产代码** — H4+H5 修法后 SAFETY 路径 test 必须**调真实 production lambda**（B-HIGH-1 / B-HIGH-2 / B-HIGH-4 / A1-HIGH-1），不能 inline 复制合约；不引入 inline 合约漂移 bug 类（H4 教训）
4. **archive_plan commit 隔离** — F2 修法后 `git commit -- <pathspec>` 显式只包含 plan / INDEX / changelog 三类归档文件，不吞 mainRepo 预存 staged
5. **archive_plan precheck 务实但保留 fail-fast 兜底** — mainRepo dirty 不再全场 fail-fast；只 reject 三个具体路径 `archivedPath / indexPath / planFilePath` 的 modified（X 列**或** Y 列任一非空，即 staged-only / unstaged-only / 双侧 modified 都拦下）+ untracked 状态 `??` 命中三具体路径也 reject；其他 dirty 降 warning + commit message 注脚
6. **hand_off / archive_plan teammate 收口对称 + 软约束防绕过** — F1 修法后两个 tool 在 caller archive 时同款行为：shutdown 同 team 同 lead 的 active+dormant teammate + `team_member.left_at` 软退出；default `keep_teammates: false`；archive_plan precheck 失败时**软约束引导** caller 走 escape hatch tool 跑完 baton-cleanup（user CLAUDE.md §Step 4 手工归档仍是合法 fallback；本 plan 提供 escape hatch + 错误返回 hint + 应用 CLAUDE.md 文档同步引导，**不硬技术阻断**）。R2 plan-review MED-G 修订：「禁止」是软约束 hint，硬性禁手工归档会破坏 user CLAUDE.md §Step 4 合法 fallback 语义

## 设计决策（已对齐，不再争论）

### D1: 范围 — 一个 plan 全做（含 F1 + F2）

来源：RFC 第一轮 Q1。

理由：16 项跨 race / cache / test debt / archive_plan / baton / 杂项 6 类，phase 化推进可控；拆 5 子 plan 会导致 5 次 EnterWorktree+收口循环 + 跨 plan mental model 丢失。

### D2: H1+H2 race 修法 = (C) 双保险（spike 升级）

来源：RFC 第一轮 Q2 选 (A) → spike1 实证 (A) 单独不够 → RFC 升级到 (C)。

实证铁证（`.claude/plans/<plan-id>/spike-reports/spike1-sdk-interrupt.md`）：
- `internal.query.interrupt()` **不阻止** SDK 一波 in-flight first session_id frame burst（case A interrupt @ 50ms，SDK 仍 emit 7 frame 含 first id @ 2759ms）
- interrupt() resolve 时机在 hook frames 之后（不是立即）
- result frame 类型变 `error_during_execution`（替代 success）—— `sdk-message-translate.ts:159` 现有 `if (internal.expectedClose) return;` **已经覆盖** result frame 整段静默路径（不需要本 plan 新增 skip 逻辑，复核确认 expectedClose 已 land）

修法 (C) 双保险 — 必须 **atomic baton**（详 Phase 2 顶部约束）：

- **(A) abort consume**：fallback fire / createSession throw 路径在「最早入口」set `internal.expectedClose=true` + `void internal.query?.interrupt?.()`（fire-and-forget，不 await，避免阻塞 fallback fire 同步路径），减少 detached SDK 子进程继续跑 LLM 调用的 token cost。**R2 plan-review MED-A 行级精确化**：fallback 在 `if (resolved) return;` 之后 / `resolved = true;` 之前；createSession throw catch 块入口立刻 set + fire interrupt 然后 throw。**R2 plan-review *未验证* U-A 加 idempotency guard**：避免 fallback fire 与 caller 手动 interrupt 并发触发 N round-trip — `internal.interruptFired = true` flag 守门
- **(B) consume L221 first-id 路径 guard**：真正的 race 护栏 — guard **插入位置：现 L221 `if (!realId && typeof m.session_id === 'string' && m.session_id)` 入口块顶部，赋值 `realId` 之前**；guard 用临时 `incomingId` 局部变量（**R2 plan-review HIGH-A 修订**：不能直接 `realId = m.session_id` 再 guard — late id 写入 realId 后 continue 跳出当前 frame，但后续 frame `sid = realId ?? ...` 三档链仍选 late id，finally cleanup 同款撞 race）：

  ```ts
  if (!realId && typeof m.session_id === 'string' && m.session_id) {
    // R2 HIGH-A 修订：临时变量,guard 命中时不能写入 realId（否则 sid 三档链仍选 late id）
    const incomingId = m.session_id;
    // (B) guard: fallback 已经 set internal.realSessionId 且 ≠ first-id 来值 → skip mutation
    if (internal.realSessionId !== null && internal.realSessionId !== incomingId) {
      console.warn(
        `[sdk-bridge] late first-id arrived after fallback; ` +
        `incoming=${incomingId} fallback=${internal.realSessionId}; skipping mutation`,
      );
      // continue 外层 for-await 让 translate 仍 emit 后续 frame（用 sid 三档链 → fallbackId）
      // 关键：realId 保持 null,后续 sid = realId ?? internal.realSessionId ?? tempKey 选 fallbackId
      continue;
    }
    realId = incomingId;
    internal.realSessionId = realId;
    if (tempKey !== realId) { ... }
    // ...其余 first-id 路径不变
  }
  const sid = realId ?? internal.realSessionId ?? tempKey;  // (B+) translate sid 三档链兜底
  translateSdkMessage(this.ctx.emit, sid, m, internal);
  ```

- **finally cleanup 三档链**：`stream-processor.ts:302` `const sid = realId ?? tempKey;` 改 `const sid = realId ?? internal.realSessionId ?? tempKey;` 确保 sessions.delete + releaseSdkClaim 拿正确 sid（fallback 路径 realId 仍 null，但 internal.realSessionId 已经是 fallbackId）

### D3: F2 archive_plan logic gap = (b) commit pathspec + mainRepo precheck 精确化（不放任意 warning）

来源：RFC 第一轮 Q3 + reviewer plan-review HIGH-A 真根因诊断。

**真根因复诊**（lead 现场验证）：本会话上轮归档撞 mainRepo 9 staged + 4 untracked → B-HIGH-4 precheck fail-fast 拦下 → **用户走手工归档绕过 archive_plan tool**（user CLAUDE.md §Step 4 5 步）→ runBatonCleanup 没被调到 → 6 旧 reviewer 自然衰减成 dormant 但**没** closed。这就是 F1 表征「dormant teammate 未 shutdown」的真根因。F1 修法本质就是 F2 修法 + 防绕过。

修法：
- `archive-plan-impl.ts:760-772` `git add ...filesToAdd` + `git commit -m <msg> -- ...filesToAdd` 显式 pathspec — 即使 mainRepo 有其他 staged，commit 只包含 3 个归档路径（plan file / INDEX / archived plan path）
- `archive-plan-impl.ts:229-266` mainRepo dirty precheck **精确化**（不是全降 warning）：仅 reject path ∈ `{archivedPath, indexPath, planFilePath}` 三个具体路径 + status 满足以下任一：
  - X 列非空（staged，如 `M  path` / `A  path`）
  - Y 列非空（unstaged modified，如 ` M path`）
  - status `??` 命中（untracked 撞归档路径会导致 git add 后混入）
  - 三具体路径以外的 dirty → 降 warning + commit message 注脚（如 `archive plan <id> (mainRepo had N unrelated dirty files)`）
- **不**新增 `allow_mainrepo_dirty` opt-out 字段（防 caller 滥用变「永远传 true」）

### D4: F1 hand_off baton + archive_plan teammate 修法 = 重新诊断

来源：RFC 第一轮 Q4 + 第二轮 Q4 + reviewer plan-review HIGH-A 现状校验。

**关键复诊**（lead 现场验证 + reviewer 双方独立 cross-cite 验证）：
- `agent-deck-team-repo/member-query.ts:47-57` `listActiveMembers` SQL 已经**不过滤** lifecycle（仅过滤 `m.left_at IS NULL AND s.archived_at IS NULL`），dormant teammate **已在候选**内
- `session/manager.ts:303-329` `sessionManager.close(sid)` 对任意存在 session 都 `setLifecycle(sid, 'closed')` + `leaveTeamsAndAutoArchive(sid, 'closed')` 软退 team_member
- `agent-deck-mcp/tools/handlers/archive-plan.ts:181-191` archive_plan handler 已经调 `runBatonCleanup` + 支持 `keep_teammates`
- `shutdown-teammates-on-baton.ts:70 + :87` 双层 `caller-not-lead` 早返

**所以**原 F1a 描述「shutdown helper 漏 dormant」**不成立**（lifecycle 过滤已不存在）。R3 实证「6 reviewer dormant 未 closed」真根因 = F2 precheck fail-fast 拦下 archive_plan tool → 手工归档绕过 → runBatonCleanup 没被调到。

修法（在 F2 修法基础上）：

- **F1a（确认 + 加防御性 audit）**：F2 修法落地后跑一次 inline 实测验证：手动起一个 SDK lead session + 起 2 个 teammate（让 teammate 自然 dormant，如 60s 无 lifecycle scheduler tick）→ 调 archive_plan tool → 实测 2 个 teammate 被 close（lifecycle='closed'）+ team_member.left_at 被 set。**作为 Phase 5 验收 step 而非新加 SQL 修法**。
- **F1b（软引导防绕过 — 不硬技术阻断）**：archive_plan precheck 失败时返回错误**软引导** caller 走 escape hatch tool。修法：错误 payload 内显式提示 caller「不建议手工 commit + mv 绕过 archive_plan tool；优先 fix precheck 命中项后重 invoke archive_plan tool；若必须手工归档（precheck 命中项无法立即修），手工 commit + mv 后调 escape hatch tool `mcp__agent-deck__shutdown_baton_teammates` 把 baton-cleanup 跑完」。**R2 plan-review MED-G 修订**：「禁止」改「不建议 / 优先 / 必须时」三档软约束 — user CLAUDE.md §Step 4 5 步手工归档仍是合法 fallback 不能硬阻断
- **F1c（escape hatch）**：新增 mcp tool `mcp__agent-deck__shutdown_baton_teammates`（仅供 archive_plan precheck 失败 fallback / 历史 dormant 残留清理使用）：args `{caller_session_id, plan_id?}` → 调 runBatonCleanup helper Phase 1（teammate shutdown）但不调 Phase 2（caller archive）。让手工归档场景 caller 显式恢复 baton-cleanup 语义。**R2 plan-review MED-D 修订**：详 Phase 5.3 拆 5.3a-5.3e 行级注册步骤；EXTERNAL_CALLER_ALLOWED=false / withMcpGuard / findMemberships 空 reject 错误契约
- **F1d（archive_plan 启用同款）**：archive_plan 当前已支持 `keep_teammates: boolean` opt-out（confirm 行为不需新加 — 与 hand_off_session 对称已经成立）

> ⚠️ **F1d 不是 BREAKING CHANGE**（lead 现场 grep 验证 archive_plan.ts:181-191 已经在调 runBatonCleanup，default 即 shutdown teammate）— changelog 不标 BREAKING；INFO 标注「archive_plan 默认行为 teammate auto-shutdown 已经是当前行为，本 plan 仅补 F1b 软引导 hint + F1c escape hatch」

### D5: R3 verify 需要重 spawn reviewer fresh review

来源：RFC 第二轮 Q1。

理由：上轮 R3 实证 fresh reviewer 能抓 R2 漏的 finding（5 HIGH + 9 MED 都是 R3 发现）；本轮修法量也大（含 race 高风险区 + test 工程化补全），fix 过程可能引入新 finding，必须 R3 兜底。

### D6: H5 P0 test 补全策略 = export production lambda（根除 inline 漂移）

来源：RFC 第二轮 Q3。

修法：
- `transport-http.ts:98-109` lambda export 命名 `resolveCallerSidForReadOnly`，test 导入调真实代码
- `archive-plan-impl.ts:229-266` mainRepo dirty check 抽 lambda export `assertMainRepoCleanForArchive`
- `hand-off-session.ts:335` `batonRole` 决策抽 lambda export `resolveBatonRoleForSpawn`
- test 文件 import production lambda，不再 inline 复制合约
- **唯一例外**：A1-HIGH-1 / A1-HIGH-2 SDK race 类 — 详 Phase 1.4 mock 策略（spike1 实证 single-thread mock 不能模拟 SDK in-flight burst race，需 controllable async generator + fake timers）

> ⚠️ export 出去的三个 lambda **仅供本模块 `__tests__/` import**；严禁其他 production 文件 import 用造成事实标准扩散。修法 land 时在每个 export 顶上加 `/** @internal Only for __tests__/. Do NOT import from other production files. */` JSDoc 标注；若 lint / arch-test 能 enforce 边界优先用。

### D7: H3 translateSdkMessage 同步顺序

修法：`sdk-message-translate.ts:175-188` 白名单校验通过后在 **L181 `}` 之后（白名单 if 块的第一句）** 插入 `internal.permissionMode = next;`，使其先于 L182 `const cur = sessionRepo.get(sessionId);` 执行。

完整 patch（before/after 对比）：

```ts
// before:
175:    const next = msg.permissionMode;
176:    if (
177:      next === 'default' ||
178:      next === 'acceptEdits' ||
179:      next === 'plan' ||
180:      next === 'bypassPermissions'
181:    ) {
182:      const cur = sessionRepo.get(sessionId);
183:      if (cur && cur.permissionMode !== next) {
184:        sessionRepo.setPermissionMode(sessionId, next);
185:        const updated = sessionRepo.get(sessionId);
186:        if (updated) eventBus.emit('session-upserted', updated);
187:      }
188:    }

// after:
175:    const next = msg.permissionMode;
176:    if (
177:      next === 'default' ||
178:      next === 'acceptEdits' ||
179:      next === 'plan' ||
180:      next === 'bypassPermissions'
181:    ) {
181a:     // H3 修法：先同步 internal cache，再走 DB 比对路径（canUseTool 通过 internal cache 读 permissionMode）
181b:     internal.permissionMode = next;
182:      const cur = sessionRepo.get(sessionId);
183:      if (cur && cur.permissionMode !== next) {
184:        sessionRepo.setPermissionMode(sessionId, next);
185:        const updated = sessionRepo.get(sessionId);
186:        if (updated) eventBus.emit('session-upserted', updated);
187:      }
188:    }
```

---

## Phase 划分（按风险升序 + 依赖关系）

### Phase 1 — Test debt 工程化补全（H4 + H5 + M4 + M6 + M8）

**优先级**：先做，让 Phase 2-6 的修法都能基于真实 P0 regression test 验证。

Phase 1.1 — `transport-http.ts` 安全路径 export lambda + test 重写（H4 + B-HIGH-1）：
- [x] 1.1a `src/main/agent-deck-mcp/transport-http.ts:98-109` 抽 lambda export 为 `resolveCallerSidForReadOnly`（加 `/** @internal */` JSDoc）— done commit `034efea`
- [x] 1.1b `src/main/agent-deck-mcp/__tests__/transport-http-extra-auth.test.ts:40-100` TC4b 更新：调真实 lambda + 断言 fallbackToGlobal=true → SENTINEL / non-fallback per-session → resolvedSid / 缺 authInfo → SENTINEL — done commit `aa35c1c`（10 test pass）
- [x] 1.1c 新建 `src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts`：B-HIGH-1 反驳轮 5 场景 1:1 重写（REVIEW_47 §B-HIGH-1 反驳轮）— done commit `aa35c1c`（11 test pass）
- [x] 1.1d 新建 `src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts`：B-HIGH-1 5 场景 deny — done commit `aa35c1c`（32 test pass）

Phase 1.2 — `archive-plan-impl.ts` precheck export lambda + test 补全（H5 + B-HIGH-3 + B-HIGH-4 + M8）：
- [x] 1.2a `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:229-266` mainRepo dirty check 抽 lambda export `assertMainRepoCleanForArchive`（加 `/** @internal */` JSDoc）；签名接收 `{mainRepoAbsPath, archivedPath, indexPath, planFilePath}` 返回 `{ok, conflicts: Array<{path, status}>, warnings: Array<{path, status}>}` — done commit `d82fa60`（精确化实现 NUL parser + R/C 双 path + repo-relative；step 5 plan 路径解析挪到 step 3.5a）
- [x] 1.2b `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts` base_branch 校验逻辑抽 lambda export `assertBaseBranchIsNamedBranch`（B-HIGH-3 tag/SHA/不存在 reject）— done commit `d82fa60`
- [x] 1.2c 新建 `src/main/agent-deck-mcp/__tests__/archive-plan.base-branch-named-only.test.ts`：B-HIGH-3 tag/SHA/不存在 branch reject 3 case — done commit `d82fa60`（7 test pass）
- [x] 1.2d 新建 `src/main/agent-deck-mcp/__tests__/archive-plan.mainrepo-clean.test.ts`：B-HIGH-4 + Phase 4 精确化路径覆盖 — staged-only / unstaged-only / 双侧 modified / untracked / **rename 类型 R/C**（R2 plan-review MED-C 加 5 种 status）× 命中三具体路径 reject、不命中三具体路径 warn pass — done commit `d82fa60`（21 test pass）

Phase 1.3 — `hand-off-session.ts` baton 条件 lambda export + test 补全（B-HIGH-2 + M12）：
- [x] 1.3a `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:335` `batonRole` 决策抽 lambda export `resolveBatonRoleForSpawn`（加 `/** @internal */` JSDoc）；签名 `(args: {archive_caller, team_name?}) => {batonRole: 'lead' | 'teammate' | undefined, batonMode: boolean}` — done commit `80cba1f`（路径修订：lambda 落 hand-off-session.ts module-level + spawn 调用处 omitUndefined 滤 undefined batonRole）
- [x] 1.3b 新建 `src/main/agent-deck-mcp/__tests__/hand-off-session.archive-caller-false.test.ts`（路径修订：放 `__tests__/` 与现有 hand-off test 同目录，非子目录）：断言 `archive_caller=false → opts.batonMode === false`（B-HIGH-2 实际机制）+ M12 修法（条件化 batonRole 传入）— done commit `80cba1f`（4 lambda unit + 4 handler 集成 = 8 test pass）

Phase 1.4 — A1-HIGH-1/2 SDK race 类 test 补全（**spike1 mock 策略升级**）：

**核心挑战**（spike1 case A 实证）：interrupt() 后 SDK 仍 emit in-flight 7 frame burst。Phase 1.4 test 必须 mock 出「fallback fire 后 late first-id 到达」的完整 race 场景，否则覆盖不到 Phase 2 修法的核心 guard 路径。

**mock 策略**（controllable async generator + fake timers，**R2 plan-review MED-B 完整补全 3 处 contract**）：

```ts
// stateful mock SDK Query — 三态机：open / closed
class MockSdkQuery implements AsyncGenerator<SDKMessage, void> {
  private buffer: SDKMessage[] = [];
  private waiter: ((value: IteratorResult<SDKMessage, void>) => void) | null = null;
  private done = false;
  private interrupted = false;

  pushFrame(msg: SDKMessage) {
    // (1) R2 MED-B + codex LOW-1 修订：closed-stream 状态机 — endStream 后静默 ignore + warn
    if (this.done) {
      console.warn('[mock] pushFrame after endStream — ignored');
      return;
    }
    if (this.waiter) {
      const w = this.waiter; this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  endStream() {
    if (this.done) return;  // idempotent
    this.done = true;
    // drain buffer first (consumer 仍能拿 trailing values),然后 done=true 终止
    if (this.waiter && this.buffer.length === 0) {
      const w = this.waiter; this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  // (2) R2 MED-B 修订：next() 实现完整 — done=true 后 drain buffer 再 done
  async next(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.buffer.length > 0) {
      return { value: this.buffer.shift()!, done: false };
    }
    if (this.done) {
      return { value: undefined, done: true };
    }
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  // (3) R2 MED-B 修订：interrupt() 不 auto-end,与 spike1 实测行为一致 — 仅标记
  // SDK 实测 interrupt() 后仍 emit in-flight burst（hook ×4 + init + user + result_error），
  // caller test 后续 explicit endStream 模拟 SDK 自然终止
  async interrupt(): Promise<void> {
    this.interrupted = true;
  }
  async return() { this.endStream(); return { value: undefined, done: true as const }; }
  async throw(e: unknown) { throw e; }
  [Symbol.asyncIterator]() { return this; }
}

// test 1.4b — 完整 race 场景（fallback fire 后 late first-id 到达）：
it('1.4b setttimeout fallback then late first-id should not overwrite fallbackId', async () => {
  vi.useFakeTimers();
  const mockQuery = new MockSdkQuery();
  // ... 注入 mock 到 sdk-bridge createSession 内
  // step 1: 不 push 任何 frame，让 fallback @ 30s fire
  await vi.advanceTimersByTimeAsync(30_000);
  // step 2: assert sessions Map has fallbackId entry + internal.realSessionId === fallbackId
  expect(bridge.sessions.has(fallbackId)).toBe(true);
  expect(internal.realSessionId).toBe(fallbackId);
  // step 3: late first-id frame 到达（stream 仍 open，finally 还未跑）
  mockQuery.pushFrame({ type: 'system', subtype: 'hook_started', session_id: 'late-real-id' });
  await vi.runAllTimersAsync();
  // **R3 codex MED-3 修订**：拆两段断言 — endStream 前断言 Map 仍指向 fallbackId
  // step 4 (BEFORE endStream): assert (B) guard 生效 — sessions Map 仍是 fallbackId，没切到 late-real-id
  expect(bridge.sessions.has(fallbackId)).toBe(true);
  expect(bridge.sessions.has('late-real-id')).toBe(false);
  expect(internal.realSessionId).toBe(fallbackId);
  // step 5: explicit endStream 让 consume for-await 退出 + finally cleanup 跑
  mockQuery.endStream();
  await vi.runAllTimersAsync();
  // step 6 (AFTER endStream): finally cleanup 三档链 — sessions 删 fallbackId（用 sid 三档链选 fallbackId 删除）
  expect(bridge.sessions.has(fallbackId)).toBe(false);
  expect(bridge.sessions.has('late-real-id')).toBe(false);
  vi.useRealTimers();
});
```

- [x] 1.4a 新建 `src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts`：A1-HIGH-1 失败语义（mock SDK 1 frame 无 session_id → createSession throw + catch 内 interrupt + delete sessions + releasePending）— done commit `d99592f`（3 pass + 1 skip 等 Phase 2.5 修法 land 后 unskip）
- [x] 1.4b 新建 `src/main/adapters/claude-code/sdk-bridge/__tests__/setttimeout-fallback-symmetry.test.ts`：(I) fallback fire 后 Map 切换正确；(II) **late first-id 到达不覆盖 fallbackId**（核心 race 场景）；(III) interrupt() after fallback fire 不阻止 SDK 仍 emit init/user/result frame（spike1 铁证补 mock 兼容性 invariant）— done commit `d99592f`（2 pass + 1 skip 等 Phase 2.2 (B) guard land 后 unskip）
- [x] 1.4c 新建 `src/main/__tests__/_shared/mocks/sdk-query.ts` `MockSdkQuery` stateful 三态机 helper — done commit `d99592f`（R2 plan-review MED-B + codex LOW-1 完整补全 3 处 contract）

Phase 1.5 — `file-change-intent-delay.test.ts` 补 finally clear（M6）：
- [x] 1.5a `src/main/adapters/claude-code/sdk-bridge/__tests__/file-change-intent-delay.test.ts` 加 case：mock SDK 流终止前 push intent 但 tool_result 没回 → 验证 finally clear 清掉 pendingFileChangeIntents（断言 `internal.pendingFileChangeIntents.size === 0`）— done commit `9e31276`（2 新 case，含部分 completed + 部分没回的 finally clear；总 8 test pass）

Phase 1.6 — `set-permission-mode-rollback.test.ts` 改为调真实 bridge（M4）：
- [x] 1.6a `src/main/adapters/claude-code/sdk-bridge/__tests__/set-permission-mode-rollback.test.ts` 三个 case 改用 import 真实 ClaudeSdkBridge factory + mock SDK Query stateful（拒绝 inline try/catch 复制）— done commit `9e31276`（4 case 改真 bridge + manual inject InternalSession + 1 skip Phase 2.7 待 land；总 4 pass + 1 skip）

**Phase 1 验收**：所有新建 / 改写的 9+ test 文件 `pnpm exec vitest run <files>` 通过；现有 826 测试无 regression。**Phase 1 已完成**：6 sub-phase（1.1+1.2+1.3+1.4+1.5+1.6）全 land + 3 skip case 等 Phase 2 修法 land 后 unskip。

### Phase 2 — Race 修法 (C) 双保险（H1 + H2 + M1 + M2 + M3 + M5）

**⚠️ Atomic 强约束**（plan-review HIGH-E 升级）：
- **2.1 + 2.2 + 2.3 + 2.4 必须同一 commit**：单做 2.1 不做 2.2 会让 fallback emit fallbackId 但 sessions Map 被 first-id 路径切走，race 仍然发生**且更糟**（因 interrupt() 加速 SDK 提前 emit first id frame burst — spike1 case A 铁证）
- **2.5 + 2.6 必须同一 commit**：createSession throw 路径（H2）与 result frame skip 路径对称（实际 2.6 已经 land，详 D2 注释）
- 其他 step（2.7 / 2.8 / 2.9）可独立 commit

依赖 Phase 1.4 SDK race test 先就位（保证修法回归 test 覆盖）。

**R2 plan-review INFO-A 修订** — Phase 2 修法时必跑 inline manual verification 兜底 spike1 残留风险：
- (R1) 跑应用实测 5 分钟 + send + close + restart + dormant resume 4 个动作，对比 toolUseNames Map / pendingFileChangeIntents Map 大小演进 + finally cleanup 是否 clear
- (R2) 触发 fallback fire 之后另起 createSession({resume: tempKey})，确认 renameSdkSession 不清错 row（toExists=false 路径走 INSERT 复制 OLD_ID 内容 + 迁子表 + DELETE OLD_ID）

- [ ] 2.1 + 2.2 + 2.3 + 2.4 **同一 commit**：
  - 2.1 `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:140-176` setTimeout fallback fire 路径：**R2 plan-review MED-A + *未验证* U-A 行级精确化** — 在 `if (resolved) return;` (L141) 之后 / `resolved = true;` (L142) 之前插入 `if (!internal.interruptFired) { internal.expectedClose = true; internal.interruptFired = true; void internal.query?.interrupt?.(); }`（idempotency guard 防 caller 也手动 interrupt 触发 N round-trip）。`interruptFired: boolean` 字段加进 `InternalSession` 接口（types.ts）+ `makeInternalSession` factory 默认 false。**R3 plan-review codex LOW-1 + claude INFO 收窄文案** — `interruptFired` flag **仅作用** fallback fire / createSession throw 双路径（防自身重复 fire）；public `interrupt(sessionId)` (`index.ts:487-491`) + `closeSession(sessionId)` (`index.ts:522-527`) 仍独立 await SDK interrupt **不读** 此 flag（设计内 — caller 显式调用应当直通 SDK，与 spike1 实证 interrupt() 幂等 SDK 行为一致）。修法时 inline 注释明确作用域
  - 2.2 `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:221-271` consume L221 first-id 路径加 guard（**详 D2 完整 patch — 用临时 `incomingId` 局部变量,guard 命中时不写入 realId**），命中时 console.warn + `continue` 外层 for-await
  - 2.3 `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:273` `const sid = realId ?? tempKey;` 改 `const sid = realId ?? internal.realSessionId ?? tempKey;`（translate sid 三档链）
  - 2.4 `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:302` finally cleanup sid 同款三档链
- [ ] 2.5 + 2.6 **同一 commit**：
  - 2.5 `src/main/adapters/claude-code/sdk-bridge/index.ts:307` createSession throw 路径：**R2 plan-review MED-A 行级精确化** — catch 块入口立刻 set `internal.expectedClose = true; if (!internal.interruptFired) { internal.interruptFired = true; void internal.query?.interrupt?.(); }`（idempotency guard 同 2.1，**R3 codex LOW-1 + claude INFO 收窄文案** flag 仅作用 fallback fire / createSession throw 双路径不覆盖 public interrupt / closeSession 入口）再 throw（H2 codex A1 HIGH-3）
  - 2.6 `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts:159` `if (internal.expectedClose) return;` — **已 land**（D2 注释复核确认），本 step 仅加 inline comment 关联 H1+H2 修法 + **R2 plan-review INFO-B 跑 confirm 命令**：`pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/ -t "expectedClose"` 确认 result frame 仍正确 gate
- [ ] 2.7 `src/main/adapters/claude-code/sdk-bridge/index.ts:557` setPermissionMode rollback：**R2 plan-review MED-F 修订 + R3 plan-review codex MED-2 修订** — sequence guard 改 per-session（不能用 bridge 全局 seq 否则跨 session 干扰；不能用「当前值 guard」否则同 session same-mode 并发会误回滚 — 实证：A 设 plan 后 await → B 设 plan 成功 → A 失败 catch 当前=plan 按当前值 guard 错误回滚成 default 把 B 已成功的 plan 改回去）。**强制 per-session seq**（删除备选当前值 guard）+ 补同 session same-mode 并发 test case。完整 skeleton：

  ```ts
  // InternalSession 接口加字段（types.ts）：
  permissionModeSeq: number;  // per-session counter, makeInternalSession 默认 0

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const seq = ++s.permissionModeSeq;  // ← per-session 计数,A/B 互不干扰
    const oldMode = s.permissionMode;
    s.permissionMode = mode;
    try {
      await s.query.setPermissionMode(mode);
    } catch (err) {
      // 仅当本次 seq 仍是该 session 最新（无后续 setPermissionMode 推进 seq）时回滚
      if (s.permissionModeSeq === seq) s.permissionMode = oldMode;
      throw err;
    }
  }
  ```

  补 test case：`set-permission-mode-rollback.test.ts` 加同 session same-mode 并发 case — A 设 plan await SDK 失败 + B 设 plan await SDK 成功 → assert s.permissionMode === plan（A catch 因 s.permissionModeSeq !== seq 不回滚）。

- [ ] 2.8 `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts:139` + `:285` 图片工具 file-changed 路径加 status gate（M2 codex A1 MED-2，与 Step 3.5 修法对称）：
  - L126 计算的 `status` 透传给 maybeEmitImageFileChanged 调用方
  - L285 函数签名加 `status: 'completed' | 'failed'` 参数
  - L298 emit 之前 `if (status === 'failed') return;` 早返
- [ ] 2.9 `src/main/adapters/claude-code/sdk-bridge/restart-controller.ts:99` `const rec = sessionRepo.get(sessionId);` 路径修（M3 codex A1 MED-3）：listen `session-renamed` event 在 inflight wait 期间 fork rename 后更新 local sessionId ref。修法 skeleton：

  ```ts
  // line 89 inflight wait 前后增量：
  let currentSid = sessionId;  // 替换原始 sessionId 当作本次操作目标
  const renameListener = (oldId: string, newId: string) => {
    if (oldId === currentSid) currentSid = newId;
  };
  eventBus.on('session-renamed', renameListener);
  try {
    let inflight = this.ctx.recovering.get(currentSid);
    while (inflight) {
      try { await inflight; } catch { /* */ }
      inflight = this.ctx.recovering.get(currentSid);  // fork rename 后 lookup 新 sid
    }
    const rec = sessionRepo.get(currentSid);  // 用更新后的 sid 查 repo
    // ... 后续 close + createSession 都用 currentSid
  } finally {
    eventBus.off('session-renamed', renameListener);
  }
  ```

**Phase 2 验收**：Phase 1.4 新建 race test pass + 现有所有 SDK / stream-processor 测试 pass；手工跑 dev 应用 5 分钟 / 含 send + close + restart + dormant resume 4 个动作，确认无 session ghost。

### Phase 3 — Cache 同步（H3）

- [ ] 3.1 `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts:181-188` 在 L181 `}` 之后插入 `internal.permissionMode = next;`（详 D7 完整 patch）
- [ ] 3.2 新建 `src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-status-permission-mode-sync.test.ts` 验证 internal cache 与 DB 同时更新：translate SDK status frame {permissionMode: 'default'} → assert internal.permissionMode === 'default' && sessionRepo.get(sid).permissionMode === 'default' && eventBus 收到一条 session-upserted

### Phase 4 — archive_plan logic gap + F2（D3 + M9）

依赖 Phase 1.2 precheck lambda export 已就位。

- [ ] 4.1 `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:760-772` `git add ...filesToAdd` + `git commit -m <msg> -- ...filesToAdd` 显式 pathspec；filesToAdd 三具体路径 `[archivedPath, indexPath, planFilePath]`
- [ ] 4.2 `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:229-266` mainRepo dirty precheck **精确化**（实现详 D3 / 不变量 5）：**R2 plan-review MED-C 修订** — 改用 `git status --porcelain=v1 -z`（NUL 分隔，可靠处理 rename / 含空格 path / quoted path）+ rename/copy 类型同时检查 old/new path 是否命中三具体路径。**R3 plan-review codex MED-1 修订** — 三具体路径必须转 repo-relative 才能与 git status 输出比对（archive-plan-impl.ts:648 实证 archivedPath 是绝对路径 `path.join(mainRepo, 'plans', ...)`；git status --porcelain 输出 repo-relative 如 ` M README.md\0`；绝对 vs relative 比对**永不命中**）

  parsing 示例（NUL 分隔 + rename/copy 兼容 + path 转 repo-relative）：

  ```ts
  // R3 codex MED-1 修订：critical path 转 repo-relative 与 git status 输出对齐
  const criticalPaths = new Set([
    path.relative(mainRepoAbsPath, archivedPath),
    path.relative(mainRepoAbsPath, indexPath),
    path.relative(mainRepoAbsPath, planFilePath),
  ]);
  const conflicts: Array<{path: string, status: string}> = [];
  const warnings: Array<{path: string, status: string}> = [];

  // 用 -z NUL 分隔（避免 path 含空格/中文/quoted 错解析）
  // git status --porcelain=v1 -z 格式：
  // - 普通: "XY filename\0"
  // - rename/copy: "RC newname\0oldname\0"（两段 NUL 分隔；X/Y 同行）
  // 用 readline-style state machine 解析
  const entries = parsePorcelainZ(porcelainOutputZ);
  for (const entry of entries) {
    const {status, paths} = entry;  // paths = [newname] 或 [newname, oldname]（R/C），全部 repo-relative
    // 检查所有 path（new + old）是否命中 critical（已是 repo-relative）
    const hitCritical = paths.some(p => criticalPaths.has(p));
    const isDirty = status[0] !== ' ' || status[1] !== ' ' || status === '??';
    if (hitCritical && isDirty) {
      // rename/copy 类型直接 reject（即使只 old path 命中也 reject — 重命名 plan/INDEX/archived 路径有风险）
      conflicts.push({path: paths.join(' -> '), status});
    } else if (isDirty) {
      warnings.push({path: paths.join(' -> '), status});
    }
  }

  // 备选 (b) 简化版：检测 status[0] === 'R' || 'C' 且 path 含 ' -> '
  //   → 直接 reject + 提示 caller fix（rename 周围归档风险高，简单兜底）
  ```

  实施时选 (a) NUL 分隔解析（更鲁棒）或 (b) rename/copy 直接 reject（更简单）；推荐 (a) 否则 plan path 重命名场景会撞 reject。

- [ ] 4.3 Phase 1.2a `assertMainRepoCleanForArchive` lambda 实现配合 4.2 精确化逻辑同步更新（lambda 是真实 implementation，handler 调它）
- [ ] 4.4 Phase 1.2d test 覆盖 5 种 status × 命中三具体路径 reject、不命中三具体路径 warn pass（含 R rename / C copy 场景）

### Phase 5 — F1 baton + archive_plan teammate + exit_worktree 收口（D4 + L2 + M10 + M11）

依赖 Phase 1.3 baton 条件 lambda export 已就位 + Phase 4 mainRepo precheck 精确化 land。

- [ ] 5.1 **F1a inline 实证**（confirm 而非新加 SQL 修法）：写 `src/main/adapters/claude-code/sdk-bridge/__tests__/dormant-teammate-shutdown.test.ts` 模拟流程：
  - mock 起 lead session A + 2 个 teammate B/C
  - lifecycle scheduler tick 让 B/C 转 dormant（或手动调 sessionRepo.setLifecycle(sid, 'dormant')）
  - 调 archive_plan handler (mainRepo clean precheck pass)
  - assert B/C lifecycle === 'closed' + B/C team_member.left_at !== null
- [ ] 5.2 **F1b 软引导 — archive_plan precheck 失败返回 hint 增强**：`src/main/agent-deck-mcp/tools/handlers/archive-plan.ts` 错误返回 payload 增强：
  - 旧 `{error: 'mainRepo dirty', conflicts: [...]}` 
  - 新 `{error: 'mainRepo dirty', conflicts: [...], hint: '不建议手工 commit + mv 绕过 archive_plan tool；优先 fix conflicts 后重 invoke archive_plan，或调 mcp__agent-deck__shutdown_baton_teammates 完成 baton-cleanup'}`
- [ ] 5.3 **F1c escape hatch — 新增 mcp tool `mcp__agent-deck__shutdown_baton_teammates`** — **R2 plan-review MED-D 拆 5.3a-5.3e**：
  - [ ] 5.3a `src/main/agent-deck-mcp/tools/schemas.ts` 加 `ShutdownBatonTeammatesArgs` / `ShutdownBatonTeammatesResult` 类型 + tool description string（应用 build 时注入 SDK system prompt 的 tool definitions）
  - [ ] 5.3b `src/main/agent-deck-mcp/tools/index.ts` 加 `shutdown_baton_teammates` 注册 entry 到 tool registry + handler import + **R2 plan-review LOW-A + codex MED-4 修订** `EXTERNAL_CALLER_ALLOWED.shutdown_baton_teammates = false` deny external（与 archive_plan / hand_off_session 对称）
  - [ ] 5.3c 新建 `src/main/agent-deck-mcp/tools/handlers/shutdown-baton-teammates.ts` handler 实现：
    - 入口 `denyExternalIfNotAllowed('shutdown_baton_teammates', caller)` 早返 deny
    - `withMcpGuard` 包装
    - 调 `runBatonCleanup` helper 仅 Phase 1（teammate shutdown）跳过 Phase 2（caller archive）
    - **R2 plan-review codex MED-4 错误契约**：`findMemberships(callerSid)` 返空（caller 不在任何 team 是 lead）→ 不能 silent return success skipped`'caller-not-lead'`（与 archive_plan 内部 baton-cleanup 不同 — escape hatch 是 caller 显式请求 cleanup，no-op 是 buggy 行为）；改为返回 error + hint「caller 不在任何 team 是 lead；如需清理特定 team 的 dormant teammate，请用 IPC TeamShutdownAllTeammates 或 UI Team 面板手动操作」
  - [ ] 5.3d 新建 `src/main/agent-deck-mcp/__tests__/shutdown-baton-teammates.handler.test.ts` 覆盖：
    - external sentinel → reject deny external
    - caller-not-lead → error + hint（非 silent success）
    - happy path: caller is lead → runBatonCleanup Phase 1 only → 同 team 其他 teammate 全 close + left_at set
  - [ ] 5.3e `resources/claude-config/CLAUDE.md` 同步加 tool 用法说明 — 「archive_plan tool precheck fail 时手工归档 fallback 流程：手工 commit + mv 后调 mcp__agent-deck__shutdown_baton_teammates tool 完成 baton-cleanup」
- [ ] 5.4 **F1d confirm 加可重跑 grep**（R2 plan-review LOW-B 修订）：
  - [ ] 5.4a 跑 `grep -n "keep_teammates" src/main/agent-deck-mcp/tools/handlers/archive-plan.ts` 确认 ≥ 1 处命中（archive-plan.ts:184 `keepTeammates: args.keep_teammates === true`）
  - [ ] 5.4b 跑 `grep -n "runBatonCleanup" src/main/agent-deck-mcp/tools/handlers/archive-plan.ts` 确认 archive_plan handler 已调 runBatonCleanup（L181-191）
  - [ ] 5.4c handler jsdoc 加 inline comment 引用 D4 F1d + grep 步骤
- [ ] 5.5 **F1b team_member 软退行为校验 — 保留 rejoin 复活语义**（**R2 plan-review HIGH-B 修订**）：现有 leaveTeamsAndAutoArchive 已经在 sessionManager.close 内调，软退所有同 team 成员。**enrollMember 显式 team_name 加入旧 team 是 rejoin 复活老 row**（schema PK `(team_id, session_id)` 单一复合主键无 surrogate id 字段；member-crud.ts:66-90 已实现 rejoin UPDATE 同 PK row + left_at 重置 NULL + joined_at 更新；现有 agent-deck-team-repo.test.ts:156 "rejoin 复用同 PK 行" 测试已 pass）。
  - 修法：D4 F1b 不变量 6 不要求「起新 row」（schema 不支持，需 migration + 改 API 远超本 plan scope）；本 step 仅 confirm rejoin 复活语义符合预期
  - 写 `src/main/store/agent-deck-team-repo/__tests__/rejoin-after-soft-exit.test.ts` 验证：
    - 起 lead + teammate → close teammate → team_member.left_at !== null
    - lead 调 addMember(team, teammate-sid) rejoin → assert: 同一 PK row 被 UPDATE，left_at 重置 NULL + joined_at = new ts；row 总数不变（仍是 1 条 row，不是新加 1 条 = 2 条）
  - D4 F1b 不变量 6 语义校准：「default 不传 team_name 不进任何旧 team」（trivial 当前行为）+「显式传 team_name 让 caller 加入旧 team 是 rejoin 复活（重置 left_at）」与软退是「caller close 时刻状态镜像」不冲突 — rejoin 是新一轮加入的合理需求
- [ ] 5.6 `src/main/agent-deck-mcp/tools/handlers/exit-worktree-impl.ts:274` retry hint 改可执行（M10 codex B MED-2）：partial-success 时清晰告诉 caller 「worktree 已删但 branch 未删，请手动 `git -C <main-repo> branch -D <branch-name>`」
- [ ] 5.7 `src/main/agent-deck-mcp/tools/handlers/exit-worktree-impl.ts:198` action:keep 路径在 .git 损坏时仍能清 marker（M11 codex B MED-3）：用 try/catch 包 rev-parse + 失败时直接清 marker 兜底
- [ ] 5.8 `src/main/agent-deck-mcp/tools/handlers/exit-worktree-impl.ts` markerCleared 语义在 happy / early-return path 对称（L2 claude B LOW-1）

### Phase 6 — 杂项收口（M5 + M7 + L1-L4 + I1-I2 + U1-U5 选优）

- [ ] 6.1 M5 已在 Phase 2.3 修（consume `resolve(realId ?? tempKey)` → 三档链）— 本 step 仅 close out 引用
- [ ] 6.2 `src/main/agent-deck-mcp/tools/index.ts:73-84` `BuildAgentDeckToolsDeps.callerSessionIdOverride` 类型 + JSDoc 同步（M7 claude B MED-1）：lambda 永不返 null，注释删除 fallback chain 提及；同步删 `src/main/agent-deck-mcp/tools/index.ts:108-109` dead fallback（I2）
- [ ] 6.3 LOW + INFO 顺手清：
  - L1 (by-design 时序窗口 setPermissionMode write-then-await) 在 index.ts:557 加注释解释 by-design 而非 bug
  - L3 `src/main/agent-deck-mcp/transport-http.ts:110` `: null` dead code (transport='http' 永远 true) 删
  - L4 `src/main/agent-deck-mcp/helpers.ts` stdio sentinel 兜底扩展非 sentinel stdio caller（接受不带 sentinel 的 stdio caller 兜底 sentinel）
  - I1 reviewer-claude.md AGENT_DECK_CLAUDE_PATH hardcode 暂留 by-design（不改）
- [ ] 6.4 codex U2-U5 4 个未验证：plan-review 阶段抽样 1-2 个验证（如 planId path traversal）；其余如果 plan-review 不抓就 skip

### Phase R3 — R3 verify reviewer fresh review

依赖 Phase 1-6 全部 pass。

**为什么 fresh pair 而非复用 R1/R2 dormant pair**（R2 plan-review LOW-C 修订）：R1 修订量 16 项 + R2 修订量 14 项跨 race / cache / test debt / archive_plan / baton 5 大类，超过 R1/R2 reviewer 单轮可消化的边界变更阈值；fresh pair 完全独立 review 避免 mental model 错位 — token 成本（重建 mental model）小于 mental model 错位风险（漏 finding）。Phase R3 后再考虑是否额外 dormant resume R1/R2 pair 给「reviewer 自评 fresh pair finding」补充对照（按 SKILL Round 4+ focus）。

- [ ] R3.1 重 spawn 一对 reviewer-claude / reviewer-codex teammate。完整 spawn args 模板：
  
  ```ts
  // reviewer-claude
  mcp__agent-deck__spawn_session({
    adapter: 'claude-code',
    agent_name: 'reviewer-claude',
    cwd: '<worktree-abs-path>',  // 即 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/<plan-id>
    display_name: 'reviewer-claude · R3 verify',
    prompt: '<完整 prompt — scope + focus + skip 详 R3.2/3.3/3.4>',
    team_name: 'r3-verify-followup-20260519',
    claude_code_sandbox: 'off',  // 避免 sandbox 拦内部 app-server
  });
  
  // reviewer-codex 同款,仅 agent_name 改 'reviewer-codex' / display_name 改 'reviewer-codex · R3 verify'
  ```

- [ ] R3.2 全量 review scope = **以 worktree git diff --name-only 为准**（不写死文件数）：
  
  ```bash
  git -C <worktree-abs-path> diff --name-only main...HEAD
  ```
  
  把 output 全部文件路径（含新建 test 文件）转换为 worktree 内绝对路径（前缀 `<worktree-abs-path>/`）作为 reviewer prompt scope。

- [ ] R3.3 reviewer prompt focus（base 模板）：
  - 重点维度：(1) Phase 1 test 是否真实覆盖 SAFETY 路径；(2) Phase 2 atomic commit 是否生效（race window 不存在）；(3) Phase 3 H3 同步顺序是否正确；(4) Phase 4 mainRepo precheck 精确化逻辑是否漏边界；(5) Phase 5 F1b/F1c escape hatch + 不变量 6 防绕过；(6) Phase 6 杂项是否引 regression
  - skip = Phase 1-6 commit hash + 一句话改动摘要（按 user CLAUDE.md §Finding 输出契约 skip 字段格式）

- [ ] R3.4 reviewer prompt skip 字段 LOW/INFO 已清条目（避免 reviewer 重复列）：
  - `已修：src/main/agent-deck-mcp/tools/index.ts:73-84 callerSessionIdOverride 类型 + JSDoc 同步 (commit <hash>)`
  - `已修：src/main/agent-deck-mcp/transport-http.ts:110 : null dead code 删 (commit <hash>)`
  - `已修：src/main/agent-deck-mcp/helpers.ts stdio sentinel 兜底扩展 (commit <hash>)`
  - 其余按 Phase 6.3 列表填

- [ ] R3.5 收两份独立 finding → 三态裁决（双方独立强冗余直接 ✅；单方 HIGH 走反驳轮；纯推理标 *未验证* 降级）→ HIGH 必修 + MED 现场验证修 + LOW/INFO 顺手清 → 写 REVIEW_48.md 落归档清单 → R3 修法完成后再跑 typecheck / 全量 test / build

### 收口（user CLAUDE.md §Step 4 + archive_plan 自动化）

⚠️ **顺序关键**：plan-review HIGH-C 实证收口顺序必须「先 commit changelog/review 在 worktree → 再 ExitWorktree → 再 archive_plan tool」。archive_plan tool 只 stage/commit 三个归档路径（plan / INDEX / archived plan path），**不会** auto-commit changelog/review。如果先调 archive_plan 后写 changelog/review，changelog/review 会留在 main HEAD working tree 未 commit 形态。

- [ ] C1 **在 worktree 内**写 `changelog/CHANGELOG_X.md` 引用归档（agent 自己写，archive_plan tool 不做） + 同步 `changelog/INDEX.md`
- [ ] C2 **在 worktree 内**写 `reviews/REVIEW_48.md` 含 R3 finding + 修法清单 + 同步 `reviews/INDEX.md`
- [ ] C3 **在 worktree 内** `git add changelog/ reviews/` + `git commit -m "docs(changelog/review): R3 follow-up CHANGELOG_X + REVIEW_48"`
- [ ] C4 ExitWorktree(action: "keep")
- [ ] C5 检查 base_branch (= main)；如有冲突先 rebase 解
- [ ] C6 archive_plan tool 一行原子完成：
  
  ```ts
  mcp__agent-deck__archive_plan({
    plan_id: 'deep-review-batch-a1-b-followup-r3-20260519',
    worktree_path: '<worktree-abs-path>',
    base_branch: 'main',
    changelog_id: 'X',  // 与 C1 写的 X 一致
    keep_teammates: false,  // 自动 shutdown reviewer pair
  });
  ```
- [ ] C7 验证：
  - `git log --oneline -5` 看 main 上有 2 commit（docs 文档 commit + chore plan 归档 commit）
  - `git -C <main-repo> worktree list` 不含本 plan worktree
  - `ls .claude/plans/` 不含本 plan 文件（已 mv 到 `plans/<plan-id>.md`）
  - `mcp__agent-deck__list_sessions({status_filter: 'all'})` 查 R3 reviewer pair lifecycle === 'closed'

---

## 当前进度

> **执行授权（用户 2026-05-19 confirm）**：自主推进所有 Phase + 自主决定 hand-off 时机；进度同步通过 commit / plan checklist 更新 + 关键决策点（如 design 变更 / Phase 偏离 plan / Phase R3 finding 决策）必须先 ask 再做。本授权对接力会话同样有效（new session cold start 后无需重新 ask 推进许可）。

- ✅ Step 0 RFC 第一轮 + 第二轮 8 个 design 决策对齐
- ✅ Step 0.5 spike1 SDK query.interrupt() 三边界行为实测完成，结论入 spike-reports/spike1-sdk-interrupt.md，race 修法升级 (A) → (C) 双保险
- ✅ Step 1 plan 文件写作完成
- ✅ Step 1.5 plan-review Round 1 完成（claude 3 HIGH + 5 MED + 3 LOW + 2 INFO + 1 *未验证* / codex 3 HIGH + 3 MED；三态裁决合并 16 修订点）
- ✅ Step 1.5 plan-review Round 2 完成（claude 1 HIGH + 5 MED + 3 LOW + 2 INFO + 1 *未验证* / codex 2 HIGH + 4 MED + 1 LOW + 1 *未验证*；合并 14 修订点）
- ✅ Step 1.5 plan-review Round 3 完成（claude ✅ 可合 + 1 INFO trivial / codex ❌ 暂不可合 + 0 HIGH + 3 真 MED + 1 LOW；合并 4 修订点）
- ✅ Step 1.5 plan-review Round 4 完成（codex 1 真 MED + 2 LOW；合并 1 修订点）
- ✅ Step 1.5 plan-review Round 5 完成（codex ✅ 可合，双方达成 SKILL 收口标准 0 HIGH + 0 真 MED 共识，reviewer pair 已 shutdown）
- ✅ Step 2 EnterWorktree 完成（worktree HEAD = 074782e = base_commit，无 stale base bug）
- ✅ Phase 1.1a transport-http.ts 抽 lambda export `resolveCallerSidForReadOnly` (commit `034efea`)
- ✅ Phase 1.1bcd transport-http test debt 收口 (commit `aa35c1c`):
  - 1.1b: transport-http-extra-auth.test.ts 改调真实 lambda + 断言新合约（10 test pass）
  - 1.1c: 新建 spoofing-attack-paths.test.ts — B-HIGH-1 4 段防御链 5 场景端到端集成（11 test pass）
  - 1.1d: 新建 helpers.deny-external.test.ts — denyExternalIfNotAllowed 5 场景 unit + read-only 例外 + invariant 兜底 + 矩阵（32 test pass）
  - Phase 1.1 三 test 文件合计 53 test pass + typecheck pass
- ✅ Phase 1.2 archive-plan-impl 抽 2 lambda + 精确化 + test 补全 (commit `d82fa60`):
  - 1.2a: 抽 `assertMainRepoCleanForArchive` lambda + 精确化实现（NUL parser + R/C 双 path + repo-relative）+ step 5 plan 路径解析挪到 step 3.5a
  - 1.2b: 抽 `assertBaseBranchIsNamedBranch` lambda（B-HIGH-3 refs/heads namespace 校验）
  - 1.2c: 新建 archive-plan.base-branch-named-only.test.ts（7 test）
  - 1.2d: 新建 archive-plan.mainrepo-clean.test.ts（21 test，5 status × 命中/不命中 矩阵 + 边界 + 兜底）
  - Phase 1.2 archive-plan 全套 130/130 pass + typecheck pass
  - **副作用**: Phase 4.2/4.3 精确化 implementation 提前 land（lambda 签名要求精确化否则无意义），Phase 4 阶段后面仅剩 4.1 commit pathspec
- ✅ Phase 1.3 hand-off-session 抽 lambda + B-HIGH-2/M12 端到端 test (commit `80cba1f`):
  - 1.3a: 抽 `resolveBatonRoleForSpawn` lambda export module-level + handler 调 lambda + spawn 传参 omitUndefined 滤 undefined batonRole
  - 1.3b: 新建 hand-off-session.archive-caller-false.test.ts（4 lambda unit + 4 handler 集成 = 8 test pass）
  - Phase 1.3 typecheck pass + agent-deck-mcp 363 全 pass + sdk-bridge 17 全 pass + 0 regression
  - **路径修订**: 1.3b test 路径修为 `__tests__/hand-off-session.archive-caller-false.test.ts` 与同目录其他 hand-off test 对齐（非 plan 原签的子目录）
- ✅ Phase 1.4 SDK race test 补全 (commit `d99592f`):
  - 1.4c: 新建 `_shared/mocks/sdk-query.ts` MockSdkQuery stateful 三态机（open / closed / interrupted）— R2 plan-review MED-B + codex LOW-1 完整补全 3 处契约（pushFrame after endStream 静默 ignore / endStream idempotent + drain / interrupt 不 auto-end）
  - 1.4a: 新建 `createsession-fail-fast.test.ts` A1-HIGH-1 失败语义（3 pass + 1 skip 等 Phase 2.5 修法 catch 内 fire-and-forget interrupt unskip）
  - 1.4b: 新建 `setttimeout-fallback-symmetry.test.ts` (I) fallback fire Map 切换 + (III) interrupt 不 auto-end mock contract pass + (II) skip 等 Phase 2 step 2.2 (B) guard 修法 land 后 unskip 验证 late first-id 不覆盖 fallbackId
  - Phase 1.4 typecheck pass + claude-code 9 file 71+2skip pass + 0 regression
  - **设计决策**: it.skip + jsdoc 说明等待 Phase 2 修法 unskip 时机（test-first，让 Phase 1 验收 pass + Phase 2 修法 commit 中同步 unskip 自动验证）
- ✅ Phase 1.5+1.6 test debt 收口 (commit `9e31276`):
  - 1.5 (M6): file-change-intent-delay.test.ts 补 2 case — SDK 流终止前 push intent + finally clear 防 leak（与 toolUseNames / pendingPermissions 同款保险）+ 部分 completed + 部分没回的 finally clear 收口
  - 1.6 (M4): set-permission-mode-rollback.test.ts 4 case 改用真 ClaudeSdkBridge factory + MockSdkQuery + manual inject InternalSession 进 bridge.sessions Map (private cast)；删除原 inline try/catch 复制合约；加 Phase 2.7 待 land 的 per-session seq guard skip case
  - Phase 1.5+1.6 typecheck pass + claude-code 9 file 74+3skip pass + 0 regression
  - **Phase 1 整体完成** (1.1+1.2+1.3+1.4+1.5+1.6 共 9 个 test 文件 / 11 个 commit case + 3 个 skip 等 Phase 2 land unskip)
- ✅ Phase 2 race 修法 (C) 双保险全部 land — 共 5 commit
  - 2.1+2.2+2.3+2.4 atomic (commit `1f43302`): setTimeout fallback fire 路径 fire-and-forget interrupt + consume L221 first-id (B) guard + translate sid 三档链 + finally cleanup 三档链；types.ts 加 `interruptFired` 字段 (双路径 idempotency)
  - 2.5+2.6 atomic (commit `f2184df`): createSession throw catch 块加 fire-and-forget interrupt + set expectedClose；sdk-message-translate.ts:159 expectedClose result frame skip 已 land 加 inline comment 关联
  - 2.7 (commit `7aa6103`): setPermissionMode per-session `permissionModeSeq` guard 防同 session same-mode 并发回滚污染 (R3 codex MED-2)；types.ts 加字段 + makeInternalSession factory 默认 0；can-use-tool.test.ts inline makeInternal() 补字段
  - 2.8+2.9 (commit `b8a2961`): 图片工具 file-changed `status` gate (M2) + restart-controller fork rename listener (M3 — listen `session-renamed` event 用 currentSid ref 替代 sessionId 入参防 inflight wait 期间 fork 让 close/setPermissionMode/createSession 操作走 stale id)
  - **3 个 skip case 全 unskip + pass**: 1.4a Phase 2.5 case (catch interrupt) / 1.4b case II (late first-id (B) guard) / 1.6 Phase 2.7 case (per-session seq race)
  - **不变量 1 兑现**: SDK first-id race 不再有覆盖窗口
  - typecheck pass + claude-code 9 file 78 pass + 0 regression
- ✅ Phase 3 H3 translateSdkMessage 同步 internal cache + DB (commit `7e68a17`):
  - sdk-message-translate.ts:181 在白名单 if 块第一句插入 `internal.permissionMode = next;` 让 canUseTool bypass 短路立刻按新 mode 判断
  - 新建 sdk-status-permission-mode-sync.test.ts 3 case 验证: bypassPermissions 同步 / cur=next no-op DB 跳过但 cache 仍同步 / 非白名单 mode 不变 + DB 不写
  - **不变量 2 兑现** (limited scope): permissionMode 路径 internal cache ↔ DB 单一源；其他字段 cache split (cwd / claudeCodeSandbox / extraAllowWrite / model) 作为后续 review focus 立项
  - typecheck pass + claude-code 10 file 81 pass + 0 regression
- ✅ Phase 4 archive_plan commit pathspec 显式隔离 mainRepo 预存 staged (commit `8fa571c`):
  - 4.1 archive-plan-impl.ts:980 `git commit -m <msg>` → `git commit -m <msg> -- <pathspec>` 显式指定 filesToAdd 三类归档文件（archivedPath / indexPath / planFilePath）
  - postFfMergeErr hint 同步更新：手工 fallback 命令也加 `-- ${filesToAdd.join(' ')}` 引导 caller 走同款 pathspec
  - **4.2/4.3/4.4 已在 Phase 1.2 lambda 抽出时 land**（mainRepo precheck 精确化 + lambda 实现 + 21 test 覆盖；commit `d82fa60`）
  - **不变量 4 兑现**：archive_plan commit 隔离 — pathspec 显式只包含 plan / INDEX / changelog 三类归档文件，不吞 mainRepo 预存 staged
  - typecheck pass + agent-deck-mcp 363 + archive-plan 130 全 pass + 0 regression
- ✅ Phase 5 F1 baton + escape hatch + exit_worktree 收口全部 land — 共 2 commit
  - 5.1+5.2+5.3 atomic (commit `50490f5`):
    - 5.1 F1a inline 实证 — 新建 dormant-teammate-shutdown.test.ts 2 case 实证 listActiveMembers SQL 不过滤 lifecycle、helper 不读 lifecycle 字段直接串行 closeFn(sid)，dormant teammate 同款被 close
    - 5.2 F1b 软引导 — archive-plan-impl.ts mainRepo dirty precheck 失败时 hint 加 escape hatch 引导（不建议手工绕过 / 优先 fix conflicts / 必须时调 mcp__agent-deck__shutdown_baton_teammates 补跑 baton-cleanup phase 1）
    - 5.3 F1c escape hatch — 新增 shutdown_baton_teammates mcp tool（schemas + types + handler + test + 应用 CLAUDE.md 同步 5 sub-step 全 land）；R2 codex MED-4 错误契约 caller-not-lead → error + hint 非 silent success；deny external
  - 5.4-5.8 atomic (commit `9c09c8a`):
    - 5.4 F1d confirm grep + jsdoc — archive-plan.ts handler jsdoc 加 D4 F1d confirm 段（含可重跑 grep keep_teammates / runBatonCleanup 命中行号 + 行为 confirm，default 已是当前行为非新加 BREAKING）
    - 5.5 rejoin-after-soft-exit.test.ts 3 case 加强 schema PK (team_id, session_id) 复合主键 rejoin 复活 invariant + row 总数不变 + 多轮 leave/rejoin 仍是 same PK row + active 重复 add throw（注：bindingAvailable=false 时 skip 同 task-repo / agent-deck-team-repo test 同款 pattern）
    - 5.6 exit-worktree-impl.ts step 5d branch 失败 error 加 "partial-success:" 前缀 + clear marker 后 markerCleared 透传 caller
    - 5.7 step 4 .git rev-parse 失败 catch 块加 action='keep' partial-success cleanup 分支（不依赖 git ops 仍清 marker）
    - 5.8 ExitWorktreeError 类型加 optional `markerCleared?: boolean` 字段，所有关键 partial-success error path 透传 marker 状态（与 happy/early-return 对称）
  - **不变量 6 兑现**：hand_off / archive_plan teammate 收口对称 + 软约束防绕过；user CLAUDE.md §Step 4 5 步手工归档仍是合法 fallback 不硬阻断
  - typecheck pass + agent-deck-mcp __tests__ 25 file 371 test pass + sdk-bridge 全套 + 0 regression（含新加 dormant-teammate-shutdown.test.ts 2 + shutdown-baton-teammates.handler.test.ts 6 + rejoin-after-soft-exit.test.ts 3 skipped binding ABI）
- ✅ Phase 6 杂项收口 — 注释精确化模式（commit `e24e335`）
  - 6.2 tools/index.ts callerSessionIdOverride JSDoc 同步明确生产 3 transport 永不返 null + fallback chain 标注 test seam（M7 + I2 注释精确化模式不删 dead code 避免破坏 test seam）
  - 6.3 L1 setPermissionMode index.ts:557 加 by-design 时序窗口标注（防 reviewer fresh review 后续轮次重提同款 finding）
  - 6.3 L3 transport-http.ts ternary 注释精确化（保留 future-proof，dead branch 防未来扩展 stdio external transport）
  - 6.3 L4 跳过 — 与 B-HIGH-1 (C) 修法严格 deny 矛盾，反向修改会破坏 spoofing 防御
  - 6.4 codex U2-U5 跳过 — plan-review Round 5 已 ✅ 0 HIGH 0 真 MED 共识收口未抓即 skip
  - typecheck pass + agent-deck-mcp + sdk-bridge 31 file 403 test pass + 0 regression
- ⏳ Phase R3 + 收口待推进

## 下一会话第一步

接力会话 cold start（hand_off_session plan-driven mode 自动发 `按 <plan-abs-path> 接力`）：

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-review-batch-a1-b-followup-r3-20260519.md` 全文（cwd 已是 mainRepo，详 user CLAUDE.md §Step 3）
2. 从 frontmatter 拿 `worktree_path` → `EnterWorktree(path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-batch-a1-b-followup-r3-20260519)` 进 worktree
3. 自检：worktree 内 `Bash: pwd; git log --oneline -19` 确认 HEAD 含 `e24e335 docs(p6):` commit + `074782e` base_commit（Phase 1+2+3+4+5+6 共 15 commit chain：`034efea` → `aa35c1c` → `d82fa60` → `80cba1f` → `d99592f` → `9e31276` → `1f43302` → `f2184df` → `7aa6103` → `b8a2961` → `7e68a17` → `8fa571c` → `50490f5` → `9c09c8a` → `e24e335`）
4. **从 Phase R3 起手**（Phase 1+2+3+4+5+6 已完成）：
   - **Phase R3 详细 step**（plan §Phase R3 完整模板）：
     - R3.1 重 spawn 一对 reviewer-claude / reviewer-codex teammate（plan §Phase R3 完整 spawn args 模板，含 cwd / display_name / team_name / claude_code_sandbox: 'off' 等）
     - R3.2 全量 review scope = `git -C <worktree-abs-path> diff --name-only main...HEAD` output 全部文件转 worktree 内绝对路径作 reviewer prompt scope
     - R3.3 reviewer prompt focus base 模板 — 6 维度（Phase 1 test 真实覆盖 SAFETY 路径 / Phase 2 atomic commit race window / Phase 3 H3 同步顺序 / Phase 4 mainRepo precheck 精确化 / Phase 5 F1b/F1c escape hatch + 不变量 6 防绕过 / Phase 6 杂项无 regression）
     - R3.4 skip = Phase 1-6 commit hash + 一句话改动摘要（按 user CLAUDE.md §Finding 输出契约 skip 字段格式）+ LOW/INFO 已清条目（Phase 6 改动）
     - R3.5 收两份独立 finding → 三态裁决（双方独立强冗余直接 ✅ / 单方 HIGH 走反驳轮 / 纯推理标 *未验证* 降级）→ HIGH 必修 + MED 现场验证修 + LOW/INFO 顺手清 → 写 REVIEW_48.md
   - 然后按 plan checklist 收口 C1-C7 推进
5. **Phase R3+ 推进策略**（继承本会话执行授权）：自主推进 + 自主决定下次 hand-off 时机；进度同步通过 commit / plan checklist 更新；**关键决策点（如 design 变更 / Phase R3 finding 决策）必须先 ask 再做**
6. Phase R3 reviewer fresh review 完成且 HIGH 修法 land 后再走 C1-C7 收口（先 worktree 内 commit changelog/review → ExitWorktree → archive_plan tool）

**重要约束**：
- 所有指向代码资产的 Read/Edit/Write 路径必须含 `.claude/worktrees/deep-review-batch-a1-b-followup-r3-20260519/` 前缀（详 user CLAUDE.md §worktree 路径陷阱）
- node_modules 已 symlink 到 main repo（worktree 内 `ln -s /Users/apple/Repository/personal/agent-deck/node_modules node_modules`），typecheck / vitest 直接用，**不要** pnpm install（防 better-sqlite3 ABI 重 build）
- 22 条「已知踩坑」必须读全（plan 末尾），特别是踩坑 #2 atomic boundary / #8 F1 真根因 / #11 mock 策略局限 / #14 enrollMember 复活语义 / #19 critical path repo-relative
- 预存 sandbox flaky test：`src/main/session/__tests__/hand-off.test.ts > summariseSessionForHandOff > uses settings.handOffModel` 在 base commit `074782e` 上同款 fail（写 `/Users/apple/Library/Preferences/electron-store-nodejs/...` EPERM），与本 plan 修法无关；Phase 验收时该 test 失败可忽略
- Phase 5.5 rejoin-after-soft-exit.test.ts 3 case 在 better-sqlite3 binding ABI mismatch 时 skip 是设计内（与 task-repo / agent-deck-team-repo test 同款 bindingAvailable 守门），typecheck pass 即可
- Phase 6 注释精确化模式不删 dead code — 仅明确 fallback chain 是 test seam（callerSessionIdOverride: null 路径），生产 3 transport 永不命中（reviewer 后续轮次再发同款 finding 应直接引 plan §Phase 6 注释 skip）

## 已知踩坑

1. **spike1 实证 SDK query.interrupt() 不阻止 in-flight first id frame**（spike-reports/spike1-sdk-interrupt.md）— 修法务必走 (C) 双保险，不能只靠 (A) abort
2. **Phase 2 atomic boundary 不可拆 commit**：2.1+2.2+2.3+2.4 必须 same commit / 2.5+2.6 必须 same commit；中间状态比未修更糟（plan-review HIGH-E）
3. **base_branch 必须是 main**（plan 起手时主仓库 HEAD 所在分支），archive_plan 用此 ff-merge — 本 plan base_branch 恰好 = main（commit `074782e`）
4. **EnterWorktree CLI v2.1.112 stale base bug** — 不要用 `EnterWorktree(name: ...)` 单步创+进，必走 `git worktree add -b ... <path>` + `EnterWorktree(path: ...)` 两步（详 user CLAUDE.md §EnterWorktree CLI stale base bug callout）
5. **mainRepo 上 9 staged + 3 untracked 是 main 上预存的 CHANGELOG_124 + REVIEW_45 工作（用户的窗口尺寸快捷键 plan）**：本 follow-up 走 worktree 隔离不会撞上；archive_plan 用 commit pathspec 隔离后也不会被吞
6. **worktree 路径陷阱** — 凡指向代码资产的 Read/Edit/Write 路径都必须含 `.claude/worktrees/deep-review-batch-a1-b-followup-r3-20260519/` 前缀（详 user CLAUDE.md §worktree 路径陷阱）
7. **spike1 残留风险 R1/R2**（spike md 末尾）— Phase 2 修法时必跑 inline manual verification step（详 Phase 2 顶部）
8. **F1 真根因 ≠ lifecycle 过滤**（plan-review HIGH-A） — 真根因是上轮 archive_plan precheck fail-fast → 用户手工归档绕过 runBatonCleanup → 6 reviewer dormant 未 closed。本 plan F1 修法本质 = F2 修法 + 软引导 escape hatch（不硬阻断）+ 测试验证
9. **F1d 不是 BREAKING CHANGE**（lead grep 验证 archive_plan.ts:181-191 已支持 keep_teammates default false 自动 shutdown teammate）— changelog 不标 BREAKING
10. **D6 export production lambda 仅供本模块 __tests__ import**（plan-review LOW-A） — 严禁其他 production 文件 import 用造成事实标准扩散；每个 export 加 `/** @internal */` JSDoc 标注
11. **Phase 1.4 mock 策略局限**：spike1 实证 single-thread mock 不能模拟 SDK frame burst race；Phase 1.4b 必须用 controllable async generator + fake timers 同时模拟 fallback fire + late first-id；不够时 Phase 2 修法 inline 实测（dev 应用跑 5 分钟 + send + close + restart + dormant resume 4 个动作）补充验证
12. **收口顺序不可颠倒**（plan-review HIGH-C）— archive_plan tool 不会 auto-commit changelog/review；必须 worktree 内先 commit docs → ExitWorktree → archive_plan tool
13. **archive-plan-impl.ts 路径是 handlers/ 直接下**（R2 plan-review MED-E）— 不是 `handlers/archive-plan/archive-plan-impl.ts`（无子目录）；test 在 `__tests__/archive-plan.*.test.ts` 而非 `__tests__/archive-plan/`
14. **Phase 5.5 enrollMember 复活 vs 起新 row**（R2 plan-review HIGH-B）— schema PK (team_id, session_id) 复合主键无 surrogate id 字段；addMember 实现是 rejoin 复活 UPDATE 同 PK row（reset left_at = null）。本 plan **不**改 rejoin 行为；F1b 不变量 6 中「不再继承幽灵 team」语义 = default 不传 team_name 不进任何旧 team + 显式传 team_name 是 rejoin（rejoin 与软退状态语义不冲突）
15. **Phase 2.7 必须 per-session `s.permissionModeSeq`**（R2 plan-review MED-F + R3 plan-review codex MED-2 + R4 plan-review codex MED-1）— bridge 全局 seq 会被跨 session 干扰；**「当前值 guard」已被 R3 否决**（同 session same-mode 并发会误回滚 — 实证 A 设 plan 失败 + B 设 plan 成功 → A 当前值 guard 看 plan 错误回滚成 default 把 B 已成功 mode 改回去）。**唯一可接受实现** = per-session `s.permissionModeSeq`（InternalSession 接口字段）+ catch 内 `if (s.permissionModeSeq === seq)` 才回滚
16. **Phase 4.2 porcelain parser 必须处理 rename/copy**（R2 plan-review MED-C + codex MED-3）— git status `R  oldname -> newname` 格式 `line.slice(3)` 拿到 "oldname -> newname" 不命中 criticalPaths.has。改用 `git status --porcelain=v1 -z` NUL 分隔 + 同时检查 old/new path
17. **F1c escape hatch 错误契约**（R2 plan-review codex MED-4）— findMemberships 返空时不能 silent return success skipped'caller-not-lead'（是 buggy 行为给 caller 假象成功）；改 error + hint
18. **F1b 不硬技术阻断手工归档**（R2 plan-review MED-G）— user CLAUDE.md §Step 4 5 步手工归档仍是合法 fallback；本 plan 仅软引导 hint + escape hatch 不强阻断
19. **Phase 4.2 critical path 必须 repo-relative**（R3 plan-review codex MED-1）— archivedPath / indexPath / planFilePath 是绝对路径；git status --porcelain=v1 -z 输出 repo-relative；必须 path.relative(mainRepo, ...) 转换后比对，否则 set.has(p) 永不命中导致 plan/INDEX 变更降为 warning
20. **Phase 2.7 必须 per-session seq 不能用「当前值 guard」**（R3 plan-review codex MED-2）— setPermissionMode 无锁 async；同 session same-mode 并发 A 设 plan 失败 + B 设 plan 成功 → A 当前值 guard 看到 plan 错误回滚成 default 把 B 已成功的 mode 改回去。强制 per-session seq + 补 same-mode 并发 test
21. **Phase 1.4b 测试断言顺序**（R3 plan-review codex MED-3）— consume finally 在 endStream 后删除 sid + tempKey；「Map 仍指向 fallbackId」断言必须在 endStream **之前**；cleanup 断言（fallbackId 被 delete）必须在 endStream **之后**。两段必须明确分开
22. **idempotency `interruptFired` flag 收窄作用域**（R3 plan-review codex LOW-1 + claude INFO） — 仅作用 fallback fire / createSession throw 双路径防自身 N round-trip；public `interrupt(sessionId)` + `closeSession(sessionId)` 入口独立 await SDK interrupt 不读此 flag（设计内）— 修法时 inline 注释明确
