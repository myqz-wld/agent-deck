---
plan_id: "cross-adapter-parity-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/cross-adapter-parity-20260515"
status: "completed"
base_commit: "d635dad"
base_branch: "main"
parent_review_id: "REVIEW_40"
parent_plan_id: "codex-claude-adapter-symmetry-20260515"
final_commit: "78c0ef969dfc8b0cbc59a0d8039e27b535bac3ae"
completed_at: "2026-05-15"
---
# cross-adapter-parity-20260515 — extraAllowWrite 持久化 + recoverer waiter Promise<string>

## 总目标 & 不变量

REVIEW_40 follow-up P1 跨 adapter parity 收口 2 个真问题:

### A. extraAllowWrite 持久化(REVIEW_40 R1 reviewer-codex MED-F)

**修前现状**:`adapters/types.ts:78-95` jsdoc 写「持久化:spawn 路径下由 finalizeSessionStart 写 sessions.extra_allow_write;recoverer 从 sessionRepo 读回」是 **fictional aspirational claim**(REVIEW_40 commit 8b607a1 已 jsdoc reflect reality 改成「未持久化」+ 列「FUTURE 持久化方案」)。

**用户场景**:hand_off_session 外置 worktree(cwd=worktreePath 不在 mainRepo subtree)+ caller 传 `[mainRepo]` 让外置 worktree session 能写 mainRepo plan 文件。app 重启 / bridge state lost / recoverer fallback 路径 → SDK sandbox.allowWrite 不含原 mainRepo → 写 plan 文件静默失败(sandbox 拦)→ 用户体感 plan 完成时 frontmatter 更新失败莫名其妙。

**修法**(REVIEW_40 jsdoc 列出的 FUTURE 5 步路线):
1. migration v019_sessions_extra_allow_write.sql 加 TEXT JSON 列
2. session-repo: SessionRow + setExtraAllowWrite + 加入 toSessionRecord / rename
3. shared/types/session.ts: SessionRecord.extraAllowWrite 字段
4. claude session-finalize.ts: setExtraAllowWrite 写库(紧跟 setSandbox)
5. claude recoverer.ts: 从 rec.extraAllowWrite 读回 → createThunk 透传(resume + fallback 双路径)
6. **codex 端同款**(REVIEW_40 jsdoc 未列但 cross-adapter parity 需对称):codex session-finalize.ts setExtraAllowWrite + codex recoverer.ts 读回
7. **adapters/types.ts jsdoc 更新**:删「未持久化 — 仅 transient」改「持久化 / 全 adapter 透传」+ 删 FUTURE 5 步路线段(已实施)

### B. recoverer waiter Promise<string>(REVIEW_40 R2 reviewer-codex MED parity 限制)

**修前现状**:claude + codex SessionRecoverer 都是同款 limitation:`recoverAndSend(sessionId, text, attachments): Promise<void>` 返回 void;waiter `await inflight` 后用 OLD sessionId 调 sendThunk;recovery 走 jsonl missing fallback rename 后 waiter 撞 sessions Map miss + sessionRepo.get 已 rename 走 NULL → throw "not found"。

**用户场景**:并发 sendMessage 触发 recovery,第一波 jsonl missing fallback 成功 rename OLD→NEW;第二条 message arrival during recovery → waiter `await inflight` ok → sendThunk(OLD sessionId)→ throw "not found"(用户体感「第二条消息消失」)。

**修法**(双 adapter 同步改造):
1. SessionRecoverer.recoverAndSend signature 改 `Promise<string>` 返回 final session id
2. waiter `const finalId = await inflight; return this.sendThunk(finalId, text, attachments)` 用 final id
3. 失败路径 reject 仍透传(caller 需 catch)
4. 双 adapter:claude `claude-code/sdk-bridge/recoverer.ts` + codex `codex-cli/sdk-bridge/recoverer.ts`
5. 加 regression test 守门(2 并发 sendMessage + 第一波 fallback rename + 第二条 waiter 拿 newRealId)

**不变量**:
- 所有改动 worktree 内跑,主仓库零污染
- A 部分**新功能**(extraAllowWrite 真持久化),B 部分行为变化但 fix bug
- 改完 typecheck + 全套 vitest + 新加 regression case 必跑
- 双 adapter 同步改造(parity invariant)
- migration 不可逆,谨慎设计 SQL

## 设计决策(不再争论)

### 1. 拆 2 sub-task 独立 commit 链(避免互相影响)

A 和 B 互相正交(不同文件 / 不同流程),拆 2 commit 链:
- **Sub-task A**: extraAllowWrite 持久化 — migration + repo + types + finalize + recoverer 双端
- **Sub-task B**: recoverer waiter Promise<string> — recoverer 双端 signature + waiter 改 + test

按依赖关系 A 先 B 后(A 无依赖 / B 改 recoverer 时 A 已 land)。但 B 不依赖 A,先做 B 也可。让 lead 决定。

### 2. extraAllowWrite migration v019 设计

```sql
-- v019_sessions_extra_allow_write.sql
-- REVIEW_40 R1 MED-F follow-up:adapters/types.ts:78-95 jsdoc 承诺持久化但实际未实现 →
-- hand_off_session 外置 worktree 后 app 重启 SDK 写 mainRepo plan 文件静默失败
-- (sandbox.allowWrite 不含原 mainRepo)。本 migration 加 TEXT JSON 列实现 jsdoc 承诺。
--
-- 字段值:JSON array of absolute paths,e.g. `["/Users/apple/repo"]`。NULL = 不指定
-- (与 caller 不传 extraAllowWrite 行为同款,sandbox.allowWrite 仅含 cwd + /tmp + cache)。
ALTER TABLE sessions ADD COLUMN extra_allow_write TEXT;
```

### 3. recoverer waiter Promise<string> signature 兼容性

claude / codex 双端 recoverer 都 export `class SessionRecoverer`。改 signature 影响:
- bridge sendMessage `await this.recoverer.recoverAndSend(...)` — 改成 `const finalId = await this.recoverer.recoverAndSend(...); /* finalId 已 final 不需要拿来用 */`
- TestBridge / 测试 mock — signature 改要同步改

向后兼容性:不需要(sub-class only,无外部 caller 依赖)。直接改不留 deprecated 版本。

### 4. extraAllowWrite codex 端是否实施(parity invariant)

REVIEW_40 jsdoc 仅列 claude 5 步,因为 codex 实测无 caller 传 extraAllowWrite(spawn handler 透传给所有 adapter,但 codex bridge `createSession` opts 不含 extraAllowWrite 字段 — codex sandbox 不支持 extra writable roots,SDK API 限制)。

**lead 自查决策点**:codex 端是否实施?
- ✅ 做(parity 完整):即使 codex bridge 当前不消费 extraAllowWrite,持久化字段对称 + future codex SDK 加支持时零迁移成本 + 减跨 adapter 漂移
- ❌ 不做(YAGNI):codex SDK 不支持就不持久化,字段为 NULL,本字段仅 claude session 用

**推荐 ✅ 做**:与 claude rec.codexSandbox 持久化但 codex SDK 不接受 model override 同款语义(持久化记账让 UI 一致 + future-proof)。implementation 仅 codex session-finalize 加 setExtraAllowWrite 写库 + codex recoverer 读回 createThunk 透传(透传到当前不消费的 opts 无副作用)。

如 lead 决定 ❌ 不做,在本 plan 加「不动文件保护清单」记录理由。

### 5. recoverer waiter Promise<string> 失败语义

waiter await inflight throw 时:
- catch 静默(原行为):waiter 自己再走 sendMessage 进新一轮 recovery
- 透传 throw:caller(IPC handler)拿到错误透传 renderer

修后保持原 catch 静默语义(waiter await inflight throw 不阻塞 caller path)。但 waiter 后续 sendThunk 用 OLD sessionId 时仍可能 throw "not found"(新一轮 recovery 起 inflight)。

实际改动:`return this.sendThunk(finalId, text, attachments)` 中 finalId 仅 inflight resolved 时定义,reject 时 finalId 未赋值。代码:

```ts
let finalId: string;
try {
  finalId = await inflight;
} catch {
  // 第一波恢复已失败,第二条等待者自己再走 sendMessage 起新一轮 recovery
  finalId = sessionId; // 用 OLD 再撞一次,触发新 recovery 路径
}
return this.sendThunk(finalId, text, attachments);
```

OLD sessionId fallback path 触发新一轮 recovery(sessions Map 仍 miss),与原行为一致。

## 步骤 checklist

### Phase A: extraAllowWrite 持久化(7 commit / 按依赖顺序)

- [ ] **Step A.1 — migration v019**:`src/main/store/migrations/v019_sessions_extra_allow_write.sql` 加 TEXT 列(详 §2)
- [ ] **Step A.2 — session-repo types + crud**:`src/main/store/session-repo/types.ts` SessionRow extra_allow_write + toSessionRecord JSON parse / `core-crud.ts` setExtraAllowWrite + INSERT/UPDATE 含字段 / `rename.ts` 列扩 19 同步
- [ ] **Step A.3 — SessionRecord 字段**:`src/shared/types/session.ts` SessionRecord.extraAllowWrite jsdoc
- [ ] **Step A.4 — claude session-finalize**:`src/main/adapters/claude-code/sdk-bridge/session-finalize.ts` setExtraAllowWrite 紧跟 setSandbox
- [ ] **Step A.5 — claude createSession 透传**:`src/main/adapters/claude-code/sdk-bridge/index.ts` finalizeSessionStart 入参加 extraAllowWrite
- [ ] **Step A.6 — claude recoverer 读回**:`src/main/adapters/claude-code/sdk-bridge/recoverer.ts` createThunk 透传 `rec.extraAllowWrite ?? undefined`(resume + fallback 双路径)
- [ ] **Step A.7 — codex 端同款**(决策点 §4 ✅):codex session-finalize + recoverer 同模式
- [ ] **Step A.8 — adapters/types.ts jsdoc 更新**:删「未持久化」改「持久化」+ 删 FUTURE 5 步路线段(已实施)
- [ ] **Step A.9 — regression test**:加 1-2 case 验证 extraAllowWrite 持久化往返(spawn → repo.get → fallback → rec.extraAllowWrite 读回)

### Phase B: recoverer waiter Promise<string>(2-3 commit / 双 adapter)

- [ ] **Step B.1 — claude recoverer signature**:`recoverAndSend` 返回 `Promise<string>`,fallback path 返 newRealId,resume path 返 sessionId / waiter `let finalId; try { finalId = await inflight } catch { finalId = sessionId }`
- [ ] **Step B.2 — codex recoverer signature**:同款
- [ ] **Step B.3 — bridge sendMessage 调用方**:`if (!s) await this.recoverer.recoverAndSend(...)` 改 `const finalId = await ...`(`finalId` 不需要继续用,bridge sendMessage 已 return)
- [ ] **Step B.4 — regression test**:加 1-2 case 验证 waiter 路径用 final id(2 并发 sendMessage,第一波 jsonl missing fallback rename,第二条 waiter 拿 newRealId 不撞 not found)

### Phase C: 收口

- [ ] **Step C.1 — 跑全 vitest**:typecheck 双端 + 全套 vitest 必跑(migration 影响 sessionRepo 读路径)
- [ ] **Step C.2 — REVIEW_<X+1>.md(建议)**:本 plan 改动多文件 + migration + 双 adapter,值得单建 review 走异构对抗;不走 R2/R3 多轮(scope 较窄,trivial fix-to-fix 可主路径修)
- [ ] **Step C.3 — CHANGELOG_<X+1>.md**:撰写归档 + plans/INDEX.md 同步
- [ ] **Step C.4 — archive_plan**:`mcp__agent-deck__archive_plan` 自动归档(前置 ExitWorktree(action: "keep"))

## 当前进度

- ⬜ 等本 hand-off 起的新 session cold-start
- ⬜ Step A.1 migration v019(或决定先 Phase B,看 lead 选)

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/cross-adapter-parity-20260515.md` 全文读 plan
2. `EnterWorktree(name: "cross-adapter-parity-20260515")` 创建新 worktree
3. `git log --oneline -5` 自检 HEAD = d635dad(base_commit)或之后
4. **从 Step A.1 开始动手**(或 Step B.1 — lead 自定):
   - A 先(migration 不可逆 + 后续 commit 依赖 schema)/ B 先(B 影响范围小可先快速完成)
   - 推荐 **A 先**:migration 是 schema 改动,先 land 让 B 阶段不需要兼容旧 schema
5. 改完每步跑 `pnpm typecheck` + 影响范围内的 vitest;commit message 必须含「(parity-plan Phase A/B/C Step Y.Z)」
6. 进度变更先告诉用户征得确认(autonomous mode 下 trivial 决策不需要,真歧义才停)
7. **决策点 §4(codex 端是否实施)**:推荐 ✅ 做 — 如 lead 选 ❌ 不做需在 plan 加「不动文件保护清单」记录理由

⚠️ **跨会话第一次读 plan 必须用 `Bash: cat` 而非 `Read` 工具**(详 user CLAUDE.md §Step 3 末尾 callout)

## 已知踩坑(看 REVIEW_40 + 历史 migration 经验)

- **migration v019 不可逆**:加列后无法删,小心字段命名 + JSON schema(后续不能改 schema 不破存量)
- **session-repo/rename.ts 列扩**:每次 migration 加列要同步更新 INSERT/SELECT 列数(REVIEW_40 历史:claude_code_sandbox / codex_sandbox / model 几次都需要同步)
- **vitest skip 原因**:64 个 test skip 是 better-sqlite3 ABI 不匹配,与本 plan 无关
- **archive_plan 前置必须先 ExitWorktree**(CLI 内部 tool 限制)
- **base_branch 是 main**(本 plan 切 worktree 时主仓库 HEAD 在 main)

## 相关 follow-up(本 plan 不做)

- **#6 codex sdk-bridge tests + #5 double rename cleanup**:留 plan `codex-sdk-bridge-tests-20260515`(独立 hand-off P0)
- **#1 P4 BaseAdapter / #3 跨 adapter sandbox 继承 / #2 scheduler 命名**:留 plan `adapter-architecture-design-20260515`(后续 P2 design hand-off)

## 会话风格授权(autonomous mode)

承袭 REVIEW_40 plan「会话风格授权」:lead 自主推进 plan checklist,真歧义才停问用户。

**触发用户介入的真歧义清单**:
- plan 设计决策外的二选一(决策点 §4 codex 端是否实施推荐 ✅,但 lead 可决定)
- 测试失败疑似真 bug 而非平移引起的预期 diff
- migration v019 SQL 字段命名 / JSON schema 拿不准
- 用户对话中显式新指令(中断 autonomous 切回 user-driven)
- 安全 / 数据可逆性高风险操作(migration 不可逆 + 写库测试前确认)
