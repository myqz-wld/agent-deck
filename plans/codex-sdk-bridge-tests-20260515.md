---
plan_id: "codex-sdk-bridge-tests-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-sdk-bridge-tests-20260515"
status: "completed"
base_commit: "d635dad"
base_branch: "main"
parent_review_id: "REVIEW_40"
parent_plan_id: "codex-claude-adapter-symmetry-20260515"
final_commit: "ef0b31273cfe37b3095b6ad923c340c35feab145"
completed_at: "2026-05-15"
---
# codex-sdk-bridge-tests-20260515 — codex sdk-bridge 单测套件 + double rename owner cleanup

## 总目标 & 不变量

REVIEW_40 R2 reviewer-claude INFO-T 横向技术债收口:codex `__tests__/` 仅 translate.test.ts(0 sdk-bridge 测试),REVIEW_40 落地的 HIGH-A (single-flight) / HIGH-B (recoverer) / MED-D (resume await + case 3 rename) / MED-E (jsonl pre-check) **全无 unit test**,目前仅 manual / 生产实测发现 bug。镜像 claude `__tests__/sdk-bridge.recovery.test.ts` + `sdk-bridge.consume-fork.test.ts` 套件给 codex sdk-bridge 加同款测试守门。

**顺手清**:REVIEW_40 R2 reviewer-codex 提的 LOW double rename owner(thread-loop case 3 + restart-controller post-rename 双 owner,`sessionRepo/rename.ts:60 if (!fromRow) return` 静默 no-op idempotent 但 console.warn 多打一次)— cleanup 4-6 行。同 codex sdk-bridge 文件,可一并 commit。

**不变量**:
- 所有改动 worktree 内跑,主仓库零污染
- 行为零变化 (纯 test infrastructure 加 + LOW cleanup)
- 测试套件镜像 claude 同款范式 (TestBridge extend pattern + thunk override)
- typecheck 双端 + 全套 vitest + 新加 case 必跑

## 设计决策(不再争论)

### 1. 测试范式:镜像 claude `__tests__/sdk-bridge/_setup.ts` TestBridge extend pattern

claude 端测试通过 `class TestBridge extends ClaudeSdkBridge` override `protected resumeJsonlExists` / `cwdExists` / `summariseForHandOff` 让 test seam 注入 mock。codex 端已铺好 `protected codexResumeJsonlExists` / `cwdExists` 同款 protected wrapper(REVIEW_40 commit ef10747 落地),test 同模式可直接 extend。

### 2. 测试文件拆 2 套(与 claude 1:1 对应)

- **`sdk-bridge.recovery.test.ts`**:覆盖 HIGH-B recoverAndSend 主路径 + MED-E jsonl pre-check + LOW-A cwdExists fallback
  - sessions Map miss → recoverer.recoverAndSend 端到端
  - jsonl 在(common case)→ resume 路径 ok
  - jsonl missing → fresh thread fallback + post-rename
  - cwd missing + fallback found → fresh thread + emit cwd info(R2-2 修法后 jsonl 在则保留对话历史)
  - cwd missing + no fallback → throw + emit error
  - archived session → unarchive + recover
  - 5s placeholder dedup window
  - inflight 单飞(并发 sendMessage waiter)
  - MAX_MESSAGE_LENGTH 校验
  - createSession 失败 → emit error message + throw

- **`sdk-bridge.consume-fork.test.ts`**:覆盖 MED-D thread-loop case 3 rename + restart-controller catch + R2-1 sessions cleanup + R3-1 late earlyErr cleanup
  - case 3 thread-loop:212 rename:模拟 SDK 返不同 thread_id → sessions Map key 切 + sessionRepo rename + firstIdCb 触发新 id
  - restart-controller catch DB rollback:在 thread.started 前 SDK throw → restart-controller catch 触发 rollback DB + emit upserted
  - R2-1 sessions cleanup:resume earlyErrCb path reject 之前 sessions.delete + releaseSdkClaim
  - R3-1 late earlyErr cleanup:30s timeout 后 late earlyErr 仍 cleanup + emit error message(resolved=true 分支)
  - HIGH-A single-flight 并发 restart 保护(2 并发 restartWithCodexSandbox 同 sid 串行执行)
  - MED-A emit `session-upserted` 在 setCodexSandbox 后 + catch 回滚后

### 3. _setup.ts 共享 helper(与 claude 同款拆分)

- `class TestCodexBridge extends CodexSdkBridge` 暴露 `setMockJsonlExists` / `setMockCwdExists` / `setMockCreateSessionResult` 等 helper
- `makeMockSessionRepo()` / `makeMockSessionManager()` 复用 R37 P1 F shared mock factory(`@main/__tests__/_shared/mocks/`)
- jsonl path mock:`vi.spyOn(fs, 'readdirSync')` / `vi.spyOn(fs, 'existsSync')` 控制 ~/.codex/sessions 扫描结果

### 4. 不动 plan 主线 fix 代码

本 plan 仅加 test。如 test 撞出 fix-to-fix bug(典型:edge case 没考虑到),记 follow-up 不顺手 fix(避免 scope creep)。如 fix bug 是 1-2 行 trivial 范围,可顺手修(commit message 标记 follow-up trigger)。

### 5. double rename owner cleanup 修法

restart-controller.ts:113-128 删 post-rename 防御 block(thread-loop case 3 已 rename + sessionRepo.rename:60 fromRow not exists 静默 no-op 是 idempotent 防御,但 console.warn 多打一次)。注释保留说明 case 3 已 owner。约 6 行删除 + 2 行注释更新。

## 步骤 checklist

### Phase 1: _setup.ts + sdk-bridge.recovery.test.ts(HIGH-B + MED-E + LOW-A 守门)

- [ ] **Step 1.1 — 抽 _setup.ts**:`src/main/adapters/codex-cli/__tests__/sdk-bridge/_setup.ts` 暴露 TestCodexBridge + makeMockXxx factory + jsonl path mock helper
- [ ] **Step 1.2 — sdk-bridge.recovery.test.ts**:覆盖 9-10 个 case(详 §2)
- [ ] **Step 1.3 — 跑 vitest**:全过 + typecheck 0 错;commit message 含「(codex-tests-plan P1)」

### Phase 2: sdk-bridge.consume-fork.test.ts(MED-D + R2-1 + R3-1 + HIGH-A + MED-A 守门)

- [ ] **Step 2.1 — sdk-bridge.consume-fork.test.ts**:覆盖 6-8 个 case(详 §2)
- [ ] **Step 2.2 — 跑 vitest**:全过 + typecheck 0 错;commit message 含「(codex-tests-plan P2)」

### Phase 3: double rename owner cleanup

- [ ] **Step 3.1 — restart-controller.ts cleanup**:删 L113-128 post-rename block + 注释更新「thread-loop case 3 已 owner rename」
- [ ] **Step 3.2 — 跑 vitest**:不应 break 任何 test(idempotent no-op 删除);commit message 含「(codex-tests-plan P3)」

### Phase 4: 收口

- [ ] **Step 4.1 — REVIEW_<X+1>.md(可选)**:本 plan 是 test infrastructure + LOW cleanup,可不单建 review,直接归档到 CHANGELOG_<X+1>。如有意外 fix-to-fix 发现写 review
- [ ] **Step 4.2 — CHANGELOG_<X+1>.md**:简洁概要本 plan 落地 + commit list + 测试结果
- [ ] **Step 4.3 — archive_plan**:`mcp__agent-deck__archive_plan` 自动归档(前置 ExitWorktree(action: "keep"))

## 当前进度

- ⬜ 等本 hand-off 起的新 session cold-start
- ⬜ Step 1.1 _setup.ts

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/codex-sdk-bridge-tests-20260515.md` 全文读 plan
2. `EnterWorktree(name: "codex-sdk-bridge-tests-20260515")` 创建新 worktree
3. `git log --oneline -5` 自检 HEAD = d635dad(base_commit)或之后
4. **从 Step 1.1 开始动手**:
   - 读 claude `src/main/adapters/claude-code/__tests__/sdk-bridge/_setup.ts` 看 TestBridge extend pattern
   - 读 claude `sdk-bridge.recovery.test.ts` + `sdk-bridge.consume-fork.test.ts` 看 case 结构
   - 镜像写 codex 端 _setup.ts + 2 test 文件
5. 改完每步跑 `pnpm typecheck` + 影响范围内的 vitest;commit message 必须含「(codex-tests-plan P<X> Step Y.Z)」
6. 进度变更先告诉用户征得确认(autonomous mode 下 trivial 决策不需要,真歧义才停)

⚠️ **跨会话第一次读 plan 必须用 `Bash: cat` 而非 `Read` 工具**(详 user CLAUDE.md §Step 3 末尾 callout)

## 已知踩坑(看 REVIEW_40 历史)

- **vitest skip 原因**:64 个 test 被 skip 是 better-sqlite3 ABI 不匹配(Node 24 vs Node 33 Electron),与本 plan 无关
- **archive_plan 前置必须先 ExitWorktree**(CLI 内部 tool 限制)
- **base_branch 是 main**(本 plan 切 worktree 时主仓库 HEAD 在 main)
- **REVIEW_40 commit hash 引用**:8d3328e/453520e/f76aed5/ef10747/c9c94d7/8b607a1/6e0eb37/726af8d
- **claude TestBridge 范式参考**:`src/main/adapters/claude-code/__tests__/sdk-bridge/_setup.ts` 6 protected method override + summariseThrow field

## 相关 follow-up(本 plan 不做)

- **#7 extraAllowWrite 持久化**:留 plan `cross-adapter-parity-20260515` 处理(独立 hand-off P1)
- **#4 recoverer waiter Promise<string>**:留 plan `cross-adapter-parity-20260515` 处理(同上)
- **#1 P4 BaseAdapter / #3 跨 adapter sandbox 继承**:留 plan `adapter-architecture-design-20260515` 处理(后续 P2 design)
- **#2 F2 scheduler 命名**:下次加新 scheduler 时一并 rename,不开 plan

## 会话风格授权(autonomous mode)

承袭 REVIEW_40 plan「会话风格授权」:lead 自主推进 plan checklist,真歧义才停问用户。

**触发用户介入的真歧义清单**:
- plan 设计决策外的二选一
- 测试失败疑似真 bug 而非平移引起的预期 diff
- 真不能拆的 ≥ 500 LOC 文件该不该写「不动文件保护清单」边界拿不准
- 用户对话中显式新指令(中断 autonomous 切回 user-driven)
- 安全 / 数据可逆性高风险操作
