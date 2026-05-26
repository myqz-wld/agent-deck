---
plan_id: deep-review-batch-a1-b-fixes-20260519
created_at: 2026-05-19T11:50:00+08:00
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-batch-a1-b-fixes-20260519
status: completed
base_commit: 7d059e8e7246abffa647b6b3811d388064d4be5b
base_branch: main
final_commit: a02cb9c009d08c89aabd6536f2443bee624d74d9
completed_at: 2026-05-19T13:55:00+08:00
---

# Deep-Review Batch A1 + B 收口修复 plan（2026-05-19）

修 deep-code-review SKILL Round 1 + Round 2 在 Batch A1（claude-code SDK bridge 核心）+ Batch B（agent-deck-mcp tool handlers）出的 6 HIGH + **11 MED**。fix 完跑 R3 verify 轮。

**Step 1.5 plan-review 反馈**：plan-review reviewer pair（`review-plan-deep-review-batch-a1-b-fixes` team）出 5 HIGH + 7 MED + 2 LOW，本版 plan 已修订全部 finding（含覆盖矩阵 / cold-start worktree 兜底 / spike 结论修正 / 漏 finding A1-MED-2 (claude) 补 step）。

reviewer 4 个 teammate 保留 dormant 状态：
- `review-adapters-claude-bridge` team：`reviewer-claude · A1` (sid `50eedfda-38dd-4f1a-9c28-ec15af4d5166`) + `reviewer-codex · A1` (sid `01d00d36-e71e-49a2-9153-a879d0d60c41`)
- `review-mcp-handlers` team：`reviewer-claude · B` (sid `af26be58-29b4-4b74-973b-27cd978c66a1`) + `reviewer-codex · B` (sid `b81ce2df-27e4-413b-b73a-94a07a1e8a2a`)

R3 verify 直接 `send_message` 复用同 team；jsonl 在 lifecycle 转 dormant 后仍保留，SDK resume 复原对话历史。

---

## 总目标 & 不变量

### 总目标
1. **修 6 HIGH**（双对抗 + 反驳轮 + lead 现场验证三态裁决为真）
2. **修 11 MED**（与 HIGH 同模块的 race / contract / fail-open / protocol inconsistency / 抽象一致性，搭车修避免后续重开 plan）
3. **R3 verify 轮**：fix 全部完成后让 dormant reviewer pair 复用 mental model 验证「fix 是否引新问题 / 是否还有未识别同类深层 bug」

### 不变量（fix 必守）

1. **A1-HIGH-1 修法 (A) 彻底失败语义**：consume catch SDK 错时 throw 给 createSession，让 createSession 进 catch 走 `sessions.delete(tempKey)` + `releasePending` + `releaseSdkClaim(opts.resume)` + `throw` IPC。不允许走 (B)/(C) 半途方案
2. **A1-HIGH-2 修法对称补全**：setTimeout fallback 路径必须补全与 consume L207-219 first-id 路径**对称**的 sessions Map key 切换 + 不调 renameSdkSession（resume 场景 no-op）
3. **B-HIGH-1 修法 (C) 两层守门**：`tools/helpers.ts:54-76` `denyExternalIfNotAllowed` 加 transport awareness（CallerContext.transport 已在 `agent-deck-mcp/types.ts:54` 存在，直接读用）+ `transport-stdio.ts:77` + `transport-http.ts:92-98` 三处都加，depth-in-defense 不能任一漏
4. **B-HIGH-2 修法 (A) 条件化 batonMode**：`batonMode: args.archive_caller !== false`，archive_caller=false 退化 normal spawn 走完整 depth/fan-out/setSpawnLink
5. **B-HIGH-3 修法 (A) refs/heads 校验**：`git rev-parse --verify --quiet refs/heads/<base_branch>`（plan-review MED-1 修订：用 `verify refs/heads/` 比 `symbolic-ref` 语义更直观）
6. **B-HIGH-4 修法 (A) fail-fast precheck**：mainRepo `git status --porcelain` 在 step 3 之后 step 7 之前 reject + hint
7. **MED 修法不引新 race / 不破现有 invariant**
8. **不修不阻塞 LOW**：6 LOW + 1 未验证 + 多条 INFO 全数留 follow-up plan（plan-review v2 2 LOW 已合并到主修订 — Step 1.1 override 精度 + §不变量 9 测试路径统一，故 follow-up 仅 R1/R2 原始 6 LOW + 1 未验证；plan-review v2 NEW-LOW 数对账修订）
9. **测试覆盖跟修法走** — 每条 fix 落地都要补测；测试文件**统一放各模块的 `__tests__/` 子目录**（plan-review LOW-1 codex 修订）：
   - `src/main/agent-deck-mcp/__tests__/` 放 mcp helpers + tools/handlers 测试
   - `src/main/adapters/claude-code/sdk-bridge/__tests__/` 放 sdk-bridge 测试
   - 不用顶层 `tests/` 路径
10. **ts/lint/build/test 必过**：fix 不能引入 typecheck error / 现有测试失败 / build break；phase 5 收口必须跑全套 `pnpm test`（plan-review MED-3 claude 修订）

---

## R1/R2 finding 全覆盖矩阵（plan-review HIGH-4 修订）

| Finding ID | Severity | Source | Phase Step | 三态裁决 |
|---|---|---|---|---|
| **A1-HIGH-1** 假 session leak | HIGH | codex 提 + claude 反驳 ✅ | Phase 2 Step 2.1 | ✅ 双方共识真问题 |
| **A1-HIGH-2** 30s fallback 双 CLI | HIGH | codex 提 + claude 反驳 ✅ | Phase 2 Step 2.2 | ✅ 双方共识真问题 |
| **B-HIGH-1** caller spoofing | HIGH | codex 提 + claude 反驳 mini-test ✅ | Phase 1 Step 1.1 | ✅ 双方共识真问题 |
| **B-HIGH-2** baton bypass | HIGH | codex 提 + claude 反驳 ✅ | Phase 2 Step 2.3 | ✅ 双方共识真问题 |
| **B-HIGH-3** detached HEAD | HIGH | codex 提 + claude 反驳 git 实测 ✅ | Phase 1 Step 1.2 | ✅ 双方共识真问题 |
| **B-HIGH-4** mainRepo dirty | HIGH | codex 提 + claude 反驳 git 实测 ✅ | Phase 1 Step 1.3 | ✅ 双方共识真问题 |
| **A1-MED-1 (claude)** setPermissionMode fail-open | MED | claude 单方 + lead 现场 | Phase 3 Step 3.1 | ✅ 真问题 |
| **A1-MED-2 (claude)** reviewer-* hardcode SSOT | MED | claude 单方 + lead 现场 | Phase 3 Step 3.2 | ✅ 真问题（plan-review HIGH-4 codex 修订前漏 step） |
| **A1-MED-3 (claude)** recoverer fallback cwd jsdoc | MED | claude 单方 + lead 现场 | Phase 3 Step 3.3 | ❓ 范围错位 → 降级补 caller 链路 NOTE |
| **A1-MED-4 (claude)** hook toolCallId 不对称 | MED | claude 单方 + spike 实证 | Phase 3 Step 3.4 | ✅ 真问题 |
| **A1-MED-1 (codex)** file-changed in tool_use | MED | codex 单方 + lead 现场 | Phase 3 Step 3.5 | ✅ 真问题 |
| **A1-MED-2 (codex)** RestartController race | MED | codex 单方 + lead 现场 | Phase 3 Step 3.6 | ✅ 真问题 |
| **B-MED-1 (claude)** cwd 4 态 marker | MED | claude 单方 + lead 现场 | Phase 3 Step 3.7 | ✅ 真问题 |
| **B-MED-2 (claude)** markerCleared 不对称 | MED | claude 单方 + lead 现场 | Phase 3 Step 3.8 | ✅ 真问题 |
| **B-MED-3** hand_off plan 路径中间档 | MED | **双方独立** ✅ 强冗余 | Phase 3 Step 3.9 | ✅ 真问题（强冗余直接锁定） |
| **B-MED-1 (codex)** tracked plan unlink | MED | codex 单方 + lead 现场 | Phase 3 Step 3.10 | ✅ 真问题 |
| **B-MED-2 (codex)** hand_off stem 校验 | MED | codex 单方 + lead 现场 | Phase 3 Step 3.11 | ✅ 真问题 |
| ~7 LOW + 1 未验证~ | LOW/未验证 | — | follow-up plan | 不阻塞 |

**覆盖审计**：6 HIGH + 11 MED（A1-MED ×6 + B-MED ×5）= 17 项，全部有对应 phase step。Phase 3 step 数 11，与 MED 数对齐。

---

## 设计决策（不再争论）

### Step 0 RFC 第一轮（user 在 AskUserQuestion 第一轮 4 题选择）

- **R1.1 plan 范围 = 6 HIGH + 关键 MED 11 条** —— user 在 AskUserQuestion 第一轮 Q1 选项 "6 HIGH + 关键 MED 9 条（推荐）"（数量后续审计为 11 条，覆盖矩阵补全）
- **R1.2 plan 文件位置 = `<main-repo>/plans/`** —— user Q2 选项 "项目内（推荐）"；本项目 30+ stub plan 实际惯例
- **R1.3 走 worktree 隔离** —— user Q3 选项 "走 worktree 隔离（推荐）"；`.claude/worktrees/<plan-id>/` 路径
- **R1.4 按 P0/P1 优先级分 phase** —— user Q4 选项 "按 P0/P1 优先级（推荐）"

### Step 0 RFC 第二轮（user 在 AskUserQuestion 第二轮 4 题选择 + lead 推荐）

- **R2.1 A1-HIGH-1 修法 = (A) 彻底失败语义** —— user 在 AskUserQuestion 第二轮 Q1 选项 (A)；reviewer-claude 反驳轮推荐
- **R2.2 B-HIGH-1 修法 = (C) 两层都加** —— user 在 plan-review 后 lead 主动起的 1 题确认 (C)；lead 推荐 depth-in-defense
- **R2.3 B-HIGH-2 修法 = (A) 条件化 batonMode** —— user 在 AskUserQuestion 第二轮 Q3 选项 (A)；reviewer-claude 反驳轮推荐
- **R2.4 R3 verify = 全部 fix 完一次 R3** —— user 在 AskUserQuestion 第二轮 Q4 选项 "全部 fix 完一次 R3（推荐）"

### Step 0.5 Spike 实证（hook 协议 tool_use_id）—— plan-review MED-1 codex 修订

**spike-1**：A1-MED-4 修法分支 spike — Claude Code SDK hook payload 哪些 event 提供 `tool_use_id` 字段

**实测命令**：
```
grep -nE 'hook_event_name.*=.*[^a-zA-Z]|tool_use_id:' node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

**修订实测结果**（lead Read sdk.d.ts 现场验证后修正 plan-review reviewer-codex MED-1 指出的 spike 错误）：
- L1740 `PermissionDenied` event：`tool_use_id: string` ✓
- L1757-1762 `PermissionRequest` event：**没** tool_use_id（仅 tool_name / tool_input / permission_suggestions）— 原 spike 写错
- L1857-1862 `PostToolUseFailure` event：`tool_use_id: string` ✓
- L1870-1875 `PostToolUse` event：`tool_use_id: string` ✓
- L1890-1894 `PreToolUse` event：`tool_use_id: string` ✓

**hook 应用层路由**（Grep `PreToolUse|PostToolUse` in `src/main/adapters/claude-code/translate.ts`）：
- L7-14 注释「hook payload 格式」仅列 SessionStart / PreToolUse / PostToolUse / Notification / Stop / SessionEnd（**无 PostToolUseFailure 路由**）
- L39 `translatePreToolUse` 仅 emit `tool-use-start`，**不调 `maybeEmitFileChanged`**
- L192 `translatePostToolUse` 才调 `maybeEmitFileChanged` emit `file-changed`

**结论**（修订）：✅ A1-MED-4 修法分支 (a) 「hook 协议提供 tool_use_id」成立，但**作用面限定**：
- 修法范围**仅 `translatePostToolUse` 路径**（L192）—— 当前是唯一调用 `maybeEmitFileChanged` 的 hook 路径
- BaseHookPayload 不变（已通用）；翻译函数局部 `BaseHookPayload & { tool_use_id?: string; ... }` 局部 narrow
- `PreToolUse` / `PostToolUseFailure` 不是 emit `file-changed` 路径，本修法不涉及（如未来加 `translatePostToolUseFailure` 走同模式即可，本 plan 不做）
- `PermissionRequest` 没 tool_use_id 是 SDK 协议事实，不是 bug（应用层不依赖 PermissionRequest 触发 file-changed）

---

## 步骤 checklist（按 phase 分）

### Phase 0：worktree 隔离 + base 自检（user confirm 后执行）

- [ ] Step 0.1 — `git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-deep-review-batch-a1-b-fixes-20260519 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-batch-a1-b-fixes-20260519`（避开 EnterWorktree CLI v2.1.112 stale base bug）
- [ ] Step 0.2 — `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-batch-a1-b-fixes-20260519")`（注意 path 不是 name）
- [ ] Step 0.3 — 进 worktree 后**精确自检**（plan-review MED-4 codex 修订 — 旧版 `reset --hard` 过粗）：
  - 跑 `Bash: pwd`（应在 worktree 内）
  - 跑 `git -C <worktree> rev-parse HEAD` 取 worktree HEAD（应等于 base_commit `7d059e8e7246abffa647b6b3811d388064d4be5b`）
  - 跑 `git -C <worktree> status --porcelain`（应空 — 新建 worktree 必空）
  - **若不等且 status 空 + 用户 confirm**：`git -C <worktree> reset --hard 7d059e8e7246abffa647b6b3811d388064d4be5b`（带显式目标 commit）
  - **若不等且 status 非空**：abort + 报错给 user 排查（不 reset 避免丢未保存改动）
- [ ] Step 0.4 — 顶层 sanity 检查：`pnpm typecheck` 在 worktree 内跑通

### Phase 1：P0 安全 / 数据丢失（B-HIGH-1/3/4）

#### Step 1.1 — B-HIGH-1 (C) 两层 spoofing 守门 — plan-review HIGH-1 修订（路径 + 字段精度）

**文件 / 修法**（精确 line + 字段值改动）：

(a) **`src/main/agent-deck-mcp/tools/helpers.ts:54-76`** —— `denyExternalIfNotAllowed` 加 transport awareness（CallerContext.transport 已在 `src/main/agent-deck-mcp/types.ts:54` 存在，**不需新增字段**）：

```ts
// 新增逻辑（在原 sentinel 检测之外加 transport+sid 联合检测）：
export function denyExternalIfNotAllowed(
  toolName: keyof typeof EXTERNAL_CALLER_ALLOWED,
  caller: CallerContext,
): HandlerResult | null {
  // 旧检测保留
  if (caller.callerSessionId === EXTERNAL_CALLER_SENTINEL && !EXTERNAL_CALLER_ALLOWED[toolName]) {
    return { /* deny: external sentinel + tool 不允许 external */ };
  }
  // B-HIGH-1 修法（C 路径，invariant assertion）— plan-review v2 NEW-H1 codex 修订:
  // 旧版条件 `transport !== 'in-process' && callerSid !== sentinel` 会误杀 **HTTP per-session
  // auth 合法 real sid**（transport-http.ts:92 当 authn 通过时 resolvedSid = real sid，非
  // sentinel）。修订为 invariant assertion 仅针对 stdio：transport=stdio 时 callerSid 应该
  // 总是 sentinel（transport-stdio.ts:77 修法已 force），如果出现非 sentinel = transport 层
  // 漏改 invariant violation。此处 deny + log 兜底守门，永不影响 HTTP per-session real sid。
  if (
    caller.transport === 'stdio' &&
    caller.callerSessionId !== EXTERNAL_CALLER_SENTINEL &&
    !EXTERNAL_CALLER_ALLOWED[toolName]
  ) {
    console.error(
      `[helpers] invariant violated: stdio transport callerSid="${caller.callerSessionId}" (should always be "__external__" sentinel — check transport-stdio.ts callerSessionIdOverride)`,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: `tool ${toolName} not allowed for stdio transport with non-sentinel caller_session_id (stdio invariant violation — transport layer should force sentinel).`,
        hint: `stdio transport must use callerSessionId="__external__" sentinel for write tools (no per-session authn supported). If you see this error, transport-stdio.ts:77 callerSessionIdOverride was not properly set to () => EXTERNAL_CALLER_SENTINEL.`,
      }) }],
      isError: true,
    };
  }
  return null;
}
```

**注**：HTTP transport 的 spoofing 防御**完全靠 transport-http.ts:92-98 修法 (c)** 在源头 force sentinel（fallbackToGlobal=true 时；per-session authn 时仍走 resolvedSid 真 sid 是合法路径）。helpers.ts 仅做 stdio invariant assertion 兜底，不再尝试集中守门 HTTP（避免误伤合法路径）。「(C) 两层守门」实质 = (b)/(c) transport 层强制 + (a) helpers.ts stdio invariant assertion 兜底（与 plan-review v2 codex NEW-H1 反馈一致）。

(b) **`src/main/agent-deck-mcp/transport-stdio.ts:77`** —— `callerSessionIdOverride: null` → `() => EXTERNAL_CALLER_SENTINEL`（plan-review LOW-1 claude 修订：精度 from "force sentinel" 措辞 to 具体字段值）：

```ts
// 旧：buildAgentDeckTools({ callerSessionIdOverride: null, transport: 'stdio' })
// 新：force sentinel — 让 tools/index.ts:108 `overridden ?? args.caller_session_id`
// 在 stdio 路径下 overridden = sentinel 短路，完全忽略 args.caller_session_id 防 spoofing
buildAgentDeckTools({
  callerSessionIdOverride: () => EXTERNAL_CALLER_SENTINEL,
  transport: 'stdio',
});
```

(c) **`src/main/agent-deck-mcp/transport-http.ts:92-98`** —— `fallbackToGlobal=true` 时 force sentinel（global token 路径无 per-session authn）：

```ts
const callerSessionIdOverride = (extra?: unknown): string => {
  const authInfo = (extra as { authInfo?: McpAuthInfo } | undefined)?.authInfo;
  if (authInfo?.fallbackToGlobal) {
    // global token 路径无 per-session authn → force sentinel 防 spoofing
    return EXTERNAL_CALLER_SENTINEL;
  }
  return authInfo?.resolvedSid ?? EXTERNAL_CALLER_SENTINEL;
};
```

**验证**：
- [ ] Step 1.1a — 写新单测 `src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts` 覆盖 5 场景：(in-process honest) / (stdio + spoofed sid) / (HTTP global token + spoofed sid) / (HTTP per-session authn + real sid) / (HTTP fallbackToGlobal + spoofed sid)
- [ ] Step 1.1b — `zsh -i -l -c "pnpm test src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts"` 全过
- [ ] Step 1.1c — 写 mini-test `src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts`（按 reviewer-claude 反驳轮 mini test 模拟 4 段防御链 1:1 重写）→ verify (A)/(B)/(D) 行为变化 = (A)(B) DENY，(D) DENY
- [ ] Step 1.1d — `pnpm typecheck` 通过

#### Step 1.2 — B-HIGH-3 base_branch refs/heads 校验 — plan-review MED-1 claude 修订

**文件**：`src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:451`

**修法**（plan-review MED-1 claude 修订：用 `rev-parse --verify refs/heads/` 替代 `symbolic-ref`，语义更直观）：
```ts
// 旧：try { await deps.runGit(['rev-parse', '--verify', effectiveBaseBranch], mainRepo); }
// 新：
try {
  await deps.runGit(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${effectiveBaseBranch}`],
    mainRepo,
  );
} catch (e) {
  return {
    error: `base_branch "${effectiveBaseBranch}" is not a named branch (refs/heads/<name>); SHA / tag / detached HEAD refs are not allowed.`,
    hint: `archive_plan ff-merge requires a named branch to commit onto. If base_branch is a tag or SHA, plan cannot be archived. Edit plan frontmatter base_branch to a branch name (e.g. "main" / "feature-x").`,
  };
}
```

**验证**：
- [ ] Step 1.2a — 加 unit test `src/main/agent-deck-mcp/__tests__/archive-plan-impl.base-branch-named-only.test.ts`：tag 名 / SHA / 不存在 branch 全 reject；正常 branch 名通过
- [ ] Step 1.2b — 跑 reviewer 反驳轮 git 端到端复现脚本（在 tmp git repo 跑 archive_plan with `base_branch: v1.0`）→ reject 而非 detached HEAD

#### Step 1.3 — B-HIGH-4 mainRepo dirty fail-fast precheck

**文件**：`src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:229` 之后 + step 7 之前

**修法**：
```ts
// step 3.5: mainRepo precheck（B-HIGH-4 修法）
let mainStatusOutput = '';
try {
  mainStatusOutput = await deps.runGit(['status', '--porcelain'], mainRepo);
} catch (e) {
  return { error: `git status --porcelain failed in main repo ${mainRepo}: ${(e as Error).message}` };
}
if (mainStatusOutput.trim().length > 0) {
  const lines = mainStatusOutput.trim().split('\n').slice(0, 5);
  return {
    error: `main repo ${mainRepo} is not clean (uncommitted/staged changes); archive_plan would mix them into the archive commit.`,
    hint: `Please commit / stash / git restore the staged changes first, then retry archive_plan. Detected:\n${lines.join('\n')}${mainStatusOutput.trim().split('\n').length > 5 ? '\n  (... more)' : ''}`,
  };
}
```

**验证**：
- [ ] Step 1.3a — 加 unit test `src/main/agent-deck-mcp/__tests__/archive-plan-impl.mainrepo-clean.test.ts`：(staged 文件) / (unstaged 文件) / (untracked + staged) 全 reject
- [ ] Step 1.3b — 跑 reviewer 反驳轮 git 端到端复现 → 不再吞 staged 文件

### Phase 2：P0 功能 broken（A1-HIGH-1/2 + B-HIGH-2）

#### Step 2.1 — A1-HIGH-1 彻底失败语义 — plan-review HIGH-2 修订（文件名 + guard 位置）

**文件**（plan-review HIGH-2 双方共识修订）：
- `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:262-321`：consume catch 块 SDK 错改为 throw（不仅 console.warn + emit 红字）
- `src/main/adapters/claude-code/sdk-bridge/index.ts:294-297`：**guard 加在此处**（plan-review HIGH-2 claude 子修订 — 旧版加在 `session-finalize.ts` 入口位置错）—— `waitForRealSessionId` 拿到 realId 后立即 `if (realId === tempKey) { throw new Error('createSession: SDK 流结束未发 first session_id frame, 拒绝创建假 session'); }`，让 catch L298 路径补 `sessions.delete(tempKey)` + `releasePending` + `releaseSdkClaim(opts.resume)` + rethrow
- `src/main/adapters/claude-code/sdk-bridge/session-finalize.ts`：**不动**（plan-review 旧版指错 `finalize-session-start.ts` 文件名 — 实际是 `session-finalize.ts` 且函数为同步 emit session-start 不应加 guard）

**验证**：
- [ ] Step 2.1a — 加 vitest mock test `src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts`：mock SDK query throw on first frame → createSession reject、`sessionRepo.get(*)` 无任何 record、sessions Map empty、sdkOwned 不留 opts.resume claim
- [ ] Step 2.1b — `pnpm typecheck` + 现有测试全过（`zsh -i -l -c "pnpm test src/main/adapters/claude-code/sdk-bridge/__tests__/"`）

#### Step 2.2 — A1-HIGH-2 setTimeout fallback 对称切 sessions Map

**文件**：`src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:140-162`

**修法**（按 reviewer-claude 反驳轮给的具体 patch）：
```ts
const fallback = setTimeout(() => {
  if (resolved) return;
  resolved = true;
  const fallbackId = resumeId ?? tempKey;
  internal.realSessionId = fallbackId;
  // A1-HIGH-2 修法：对称补全 sessions Map key 切换（与 consume L207-219 first-id 路径同款）
  if (tempKey !== fallbackId) {
    this.ctx.sessions.delete(tempKey);
    this.ctx.sessions.set(fallbackId, internal);
    // 不调 sessionManager.renameSdkSession：resume 场景 fallbackId === resumeId === OLD_ID，
    // OLD 行已存在 DB → renameWithDb 走 toExists=true 路径但 tempKey 行不存在，
    // L60 `if (!fromRow) return` 早返 → rename 实际 no-op。省 SQL 调用。
  }
  // emit error message ... resolve(fallbackId)
}, ...);
```

**验证**：
- [ ] Step 2.2a — 加 vitest mock test `src/main/adapters/claude-code/sdk-bridge/__tests__/setttimeout-fallback-symmetry.test.ts`：mock SDK query 永不发 first frame，等 30s timeout → sendMessage(fallbackId) 不撞 recoverer / listPending(fallbackId) 拿到 internal session / setPermissionMode 不 throw / interrupt 不失效
- [ ] Step 2.2b — `pnpm typecheck` + 现有测试

#### Step 2.3 — B-HIGH-2 条件化 batonMode

**文件**：`src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:326`

**修法**：
```ts
// 旧：const spawnResult = await spawnFn(spawnArgs, ctx, { batonMode: true, batonRole: 'lead' });
// 新：
const spawnResult = await spawnFn(spawnArgs, ctx, {
  batonMode: args.archive_caller !== false,  // archive_caller=true（默认 baton 语义）→ 跳 depth；
                                                // archive_caller=false（caller 保活）→ 退化 normal spawn
  batonRole: 'lead',
});
```

**验证**：
- [ ] Step 2.3a — 加 unit test `src/main/agent-deck-mcp/__tests__/hand-off-session.archive-caller-false.test.ts`：archive_caller=false × N → 第 (max_fan_out + 1) 次撞 fan-out reject（不再无限 spawn）
- [ ] Step 2.3b — 跑 reviewer 反驳轮的攻击链复现：archive_caller=false × 6 应该在第 6 次撞 fan-out=5/parent

### Phase 3：P1 11 MED — plan-review HIGH-4 修订（覆盖矩阵 + 漏 step 补全）

#### Step 3.1 — A1-MED-1 (claude) setPermissionMode fail-open 治理

**文件**：`src/main/adapters/claude-code/sdk-bridge/index.ts:524-535`

**修法**（与 restartWithPermissionMode L94+L156-159 模式对齐）：
```ts
async setPermissionMode(sessionId, mode): Promise<void> {
  const s = this.sessions.get(sessionId);
  if (!s) throw new Error(`session ${sessionId} not found`);
  const oldMode = s.permissionMode;
  s.permissionMode = mode;
  try {
    await s.query.setPermissionMode(mode);
  } catch (err) {
    s.permissionMode = oldMode;  // 回滚 cache
    throw err;
  }
}
```

- [ ] Step 3.1a — 加 vitest mock test `src/main/adapters/claude-code/sdk-bridge/__tests__/set-permission-mode-fail-open.test.ts`：SDK setPermissionMode throw → s.permissionMode 仍 oldMode
- [ ] Step 3.1b — `pnpm typecheck` 通过

#### Step 3.2 — A1-MED-2 (claude) reviewer-* hardcode SSOT 抽出 — plan-review HIGH-4 codex 修订（旧版漏 step）

**文件**（plan-review v2 NEW-M1 codex 修订 — bundled-assets path 修正：实际在 resources/ + src/main/bundled-assets.ts，不在 src/main/agent-deck-mcp/bundled-assets/）：
- `src/main/adapters/options-builder.ts:111`：`if (raw.agentName === 'reviewer-claude' || raw.agentName === 'reviewer-codex')` 等多处硬编码字符串
- 多处散落（实施前 grep `reviewer-claude\|reviewer-codex` in `src/main/adapters/options-builder.ts` + `src/main/bundled-assets.ts` + `resources/claude-config/` + `resources/codex-config/` + `src/main/agent-deck-mcp/tools/handlers/` 等确认完整散布点；保证 SSOT 抽出后 0 hardcode 残留）

**修法**：
```ts
// src/main/adapters/options-builder.ts 顶部
export const REVIEWER_AGENT_NAMES = ['reviewer-claude', 'reviewer-codex'] as const;
export type ReviewerAgentName = typeof REVIEWER_AGENT_NAMES[number];

// L111 改：
if ((REVIEWER_AGENT_NAMES as readonly string[]).includes(raw.agentName ?? '')) {
  // ...8 字段 spread default
}

// 与 AGENT_IDS list (L56-58) + AssertSameKeys 同款 SSOT 模式
```

- [ ] Step 3.2a — 抽 const + replace 3 处 hardcode（grep 验证 0 hardcode 残留）
- [ ] Step 3.2b — 加 SSOT 守门 unit test：未来漏改任一处 TS 编译期报错 / unit test 命中

#### Step 3.3 — A1-MED-3 (claude) recoverer fallback cwd jsdoc — plan-review HIGH-3 claude 修订（降级补 NOTE 不动 jsdoc）

**plan-review HIGH-3 验证**：lead 现场 Read recoverer.ts:600-602 jsdoc 段「**不持久化 fallback cwd**: sessionRepo.cwd 不被改写」描述粒度**仅 findFallbackCwd 函数本身**（L606-630 函数确实没调 setCwd）。A1-MED-3 R1 finding 是范围错位（helper 视角 jsdoc 对 / caller 链路最终持久化是另一抽象层）。

**修法**（降级 — 不动原 jsdoc，加一条 caller 链路 NOTE 解释 by-design）：

在 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:600-603` 原 jsdoc「不持久化 fallback cwd」段后追加：
```
*
* **NOTE（caller 链路视角）**:虽 findFallbackCwd 本身不写 sessionRepo,但 caller 拿到
* fallback cwd 后调 createSession({cwd: effectiveCwd, ...}) → finalize emit session-start
* 写 newRealId 行 cwd = effectiveCwd → rename(OLD, newRealId) 后 OLD 行 DELETE，最终
* sessionRepo.get(newRealId).cwd === effectiveCwd（fallback cwd）。SessionDetail 显示
* fallback cwd 是设计内 by-design（旧 worktree path 永久丢失换 SDK 子进程能起来的取舍）。
* 行为不可改 — rename 时复制 OLD.cwd 到 NEW 会撞 cwd-not-exists 死循环。
```

- [ ] Step 3.3 — 单条 doc-only 修改

#### Step 3.4 — A1-MED-4 (claude) hook PostToolUse file-changed toolCallId 透传 — plan-review MED-1 codex 修订（spike 修正后修法范围限定）

**修法范围限定**（plan-review MED-1 codex 修订）：
- 修法**仅 `translatePostToolUse`** 路径（L192）—— 当前唯一调用 `maybeEmitFileChanged` 的 hook 路径
- 不动 BaseHookPayload（已通用）；翻译函数 narrow 局部 type
- `PreToolUse` / `PostToolUseFailure` 不是 emit `file-changed` 路径，本修法不涉及
- `PermissionRequest` 没 tool_use_id 是 SDK 协议事实（spike 已修正）

**文件**：
- `src/main/adapters/claude-code/translate.ts:192` 函数签名 narrow `tool_use_id?: string`
- L216-291 四处 file-changed emit 加 `toolCallId: p.tool_use_id ?? null`（PostToolUse 路径独有）

- [ ] Step 3.4a — Read sdk.d.ts:1870-1875 PostToolUse type narrow 详查
- [ ] Step 3.4b — emit 处 4 处加字段
- [ ] Step 3.4c — 加 regression test `src/main/adapters/claude-code/__tests__/translate.post-tool-use-toolcallid.test.ts`：hook 路径 file-changed 事件含 toolCallId

#### Step 3.5 — A1-MED-1 (codex) file-changed emit 等到 tool-use-end completed

**文件**：`src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts:96-102`（tool_use 阶段 emit）+ L122-128（tool_result 阶段）

**修法**：tool_use 阶段不立即 `maybeEmitFileChanged`，改为延迟到 tool_result 阶段且 status=completed 时 emit。
- internal 加 `pendingFileChangeIntents: Map<toolUseId, FileChangePayload>`
- L96-102 tool_use 路径：改为 `pushFileChangeIntent` 先 push 到 Map
- L122-128 tool_result 路径：拿 `block.tool_use_id` 在 Map find；status='completed' → emit + delete；status='failed' → 仅 delete（不 emit）；session-end / consume finally 时清 Map 防 leak

- [ ] Step 3.5a — internal 字段 + Map 生命周期管理
- [ ] Step 3.5b — emit 时序改造
- [ ] Step 3.5c — regression test：模拟 Edit old_string 不匹配 → tool_result is_error=true → file-changed 不发；Edit 成功 → tool_result is_error=false → file-changed 发
- [ ] Step 3.5d — 与 Step 3.4 hook 路径对称改造（PostToolUse 已经是 tool-use-end 后 emit，无需改）

#### Step 3.6 — A1-MED-2 (codex) RestartController multi waiter race 治理

**文件**：`src/main/adapters/claude-code/sdk-bridge/restart-controller.ts:82-90` + L116-181 + L211-219 + L242-303

**修法**：从 inflight await 出来后**重新检查** recovering Map（loop）：
```ts
let inflight = this.ctx.recovering.get(sessionId);
while (inflight) {
  try { await inflight; } catch { /* 上一个失败不影响本次 */ }
  inflight = this.ctx.recovering.get(sessionId);  // 重新读，防 multi waiter 同释放后并发进入 close
}
```

- [ ] Step 3.6a — 加 vitest race test `src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-multi-waiter.test.ts`：mock 旧 inflight + 两个 caller 同时 await → 只一个 close + DB write + createSession
- [ ] Step 3.6b — `pnpm typecheck` + 现有 restart 测试

#### Step 3.7 — B-MED-1 (claude) cwd 4 态 release marker 边界

**文件**：`src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:316-329`

**修法**：拆 if/else 子分支区分 markerReal == worktreeReal：
```ts
} else {  // cwd valid + !inWorktree
  if (markerReal === worktreeReal) {
    // 状态 (c-1)：marker 与 worktree 匹配 → 可 release
    warnings.push(`cwd ${cwdReal} is outside worktree but enter_worktree marker (${markerReal}) is held — caller likely forgot exit_worktree before changing cwd. Marker will be released after archive succeeds.`);
    releaseMarkerOnSuccess = true;
  } else if (markerReal !== null) {
    // 状态 (c-2)：marker 指向另一个 worktree → 仅 warn 不 release（让 caller 自己 exit_worktree）
    warnings.push(`cwd ${cwdReal} is outside worktree, but caller holds marker for a different worktree (${markerReal}). Archive(${worktreeReal}) will not release marker(${markerReal}); caller should call exit_worktree on ${markerReal} separately.`);
    // releaseMarkerOnSuccess 不设 true
  }
  // 状态 (c-3)：cwd valid + marker null → 直接放过
}
```

- [ ] Step 3.7 — 加 TC15 测试 `src/main/agent-deck-mcp/__tests__/archive-plan.impl-cwd-marker.test.ts` （marker != worktree 在 cwd valid + !inWorktree 时 marker 不被 release）

#### Step 3.8 — B-MED-2 (claude) exit_worktree markerCleared contract 对称

**文件**：`src/main/agent-deck-mcp/tools/handlers/exit-worktree-impl.ts:167-184`

**修法**：catch 块改为 return error（与 step 6 happy path 对称）：
```ts
if (!(await deps.exists(worktreePath))) {
  let markerCleared = false;
  if (marker) {
    try {
      deps.clearCwdReleaseMarker(input.callerSessionId);
      markerCleared = true;
    } catch (e) {
      return {
        error: `worktree was already removed but clearCwdReleaseMarker failed: ${(e as Error).message}`,
        hint: `worktree at ${worktreePath} no longer exists. Marker DB clear failed (partial-success). Manual recovery: call enter_worktree to reset marker, then exit_worktree.`,
      };
    }
  }
  return { worktreePath, action: input.action, branchDeleted: false, worktreeRemoved: false, markerCleared };
}
```

- [ ] Step 3.8 — 加 regression test：mock clearCwdReleaseMarker throw → return error 而非 ok with markerCleared:true

#### Step 3.9 — B-MED-3 hand_off plan 路径 fallback 加中间档（双方独立 ✅ 强冗余）

**文件**：`src/main/agent-deck-mcp/tools/handlers/hand-off-session-impl.ts:201-218`

**修法**：与 archive-plan-impl.ts:374-389 对齐，抽 helper：
```ts
// src/main/agent-deck-mcp/tools/handlers/plan-path-helpers.ts
export async function resolvePlanFilePath(
  mainRepo: string | null,
  planId: string,
  deps: { exists: (p: string) => Promise<boolean>; homedir: () => string },
): Promise<{ path: string } | { error: string; hint: string }> {
  const projectLocal = mainRepo ? path.join(mainRepo, '.claude', 'plans', `${planId}.md`) : null;
  const projectArchived = mainRepo ? path.join(mainRepo, 'plans', `${planId}.md`) : null;
  const userGlobal = path.join(deps.homedir(), '.claude', 'plans', `${planId}.md`);
  if (projectLocal && (await deps.exists(projectLocal))) return { path: projectLocal };
  if (projectArchived && (await deps.exists(projectArchived))) return { path: projectArchived };
  if (await deps.exists(userGlobal)) return { path: userGlobal };
  return { error: `plan file not found at any default location`, hint: `Tried: ${[projectLocal, projectArchived, userGlobal].filter(Boolean).join('\n       ')}\nPass plan_file_path explicitly to override.` };
}
```

- [ ] Step 3.9a — 抽 helper 到独立文件（避免重复代码 + 单一 SSOT）
- [ ] Step 3.9b — archive-plan-impl + hand-off-session-impl 都调 helper（替换 inline 逻辑）
- [ ] Step 3.9c — regression test：plan 在 `<main-repo>/plans/<id>.md` 时 hand_off 找到

#### Step 3.10 — B-MED-1 (codex) tracked plan unlink 纳入 git add

**文件**：`src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:680-700`

**修法**：step 12 unlink 后 step 13 `filesToAdd` 加 `path.relative(mainRepo, planFilePath)`（仅当 source 在 mainRepo 子树内）：
```ts
const filesToAdd = [
  path.relative(mainRepo, archivedPath),
  path.relative(mainRepo, indexPath),
];
const planRelative = path.relative(mainRepo, planFilePath);
if (path.resolve(planFilePath) !== path.resolve(archivedPath) && !planRelative.startsWith('..')) {
  filesToAdd.push(planRelative);  // 让归档 commit 包含「mv plan」的删除动作
}
```

- [ ] Step 3.10 — regression test：source plan 在 `<main-repo>/plans/<id>.md` 时归档 commit 含 D（删除）+ A（新增）两条

#### Step 3.11 — B-MED-2 (codex) hand_off plan_file_path stem 校验

**文件**：`src/main/agent-deck-mcp/tools/handlers/hand-off-session-impl.ts:193`

**修法**（与 archive-plan-impl.ts:363-369 对齐）：
```ts
if (input.planFilePathOverride) {
  if (!(await deps.exists(input.planFilePathOverride))) {
    return { error: `plan_file_path override does not exist: ${input.planFilePathOverride}` };
  }
  const overrideStem = path.basename(input.planFilePathOverride, '.md');
  if (overrideStem !== planId) {
    return {
      error: `plan_file_path stem "${overrideStem}" does not match plan_id "${planId}"`,
      hint: `worktree_path / plan-driven cold-start prompt are derived from plan_id. Mismatched stem would lead the new SDK session to the wrong plan. Either rename plan_file_path to "${planId}.md" or change plan_id to "${overrideStem}".`,
    };
  }
  planFilePath = input.planFilePathOverride;
}
```

- [ ] Step 3.11 — 加 regression test：plan_id != stem 时 reject

### Phase 4：R3 verify 轮（reviewer pair 复用）— plan-review MED-2/3 claude/codex 修订

**目的**：让 dormant 的 4 个 reviewer teammate 复用 mental model verify fix 是否正确 + 是否引新问题 + 是否还有未识别的同类深层 bug

#### Step 4.0 — dormant reviewer 状态前置自检（plan-review MED-2 claude 修订）

调 `mcp__agent-deck__list_sessions({status_filter: 'active'})` 验证 4 reviewer sessionId 仍 lifecycle=active + 仍 shared team。如任一 sessionId closed / 不再 shared team → 提示 lead 决定（重 spawn 丢 mental model / 用单方 reviewer / abort R3）。

- [ ] Step 4.0 — 自检 4 sid + team 配对 + lifecycle

#### Step 4.1 — 复用 A1 reviewer pair verify

R3 verify prompt 模板（plan-review MED-3 codex 修订 — `<last messageId>` 占位符替换为获取步骤）：
- 获取 last messageId：调 `mcp__agent-deck__get_session({session_id: <reviewerSid>})` 拿 lastEventAt 上下文，或直接 send_message 不带 reply_to_message_id（开新话题）— **本 R3 verify 选择不带 reply_to_message_id 开新话题**（R3 是新轮次评审，不是 R2 反驳的子话题）

- [ ] Step 4.1a — `mcp__agent-deck__send_message({session_id: "50eedfda-38dd-4f1a-9c28-ec15af4d5166", team_id: "61fd5cbb-d307-44e5-b76f-b1ae8ecc48e2", text: "<R3 verify prompt: scope = phase 1+2+3 fix 后的 A1 文件清单 + skip = 上轮已 ✅ fix 摘要列表（每条按 \`已修：<filepath:line> <一句话改动> (commit <hash>)\` 格式）+ focus = fix 是否引新问题 / 是否还有未识别同类深层 bug>"})`（不传 reply_to_message_id — 新话题）
- [ ] Step 4.1b — 同 prompt send 到 reviewer-codex · A1 (`01d00d36-e71e-49a2-9153-a879d0d60c41`, team `61fd5cbb-d307-44e5-b76f-b1ae8ecc48e2`)
- [ ] Step 4.1c — 等两路 reply 自动注入

#### Step 4.2 — 复用 B reviewer pair verify

- [ ] Step 4.2a — `mcp__agent-deck__send_message({session_id: "af26be58-29b4-4b74-973b-27cd978c66a1", team_id: "d1d061a1-22f4-4491-a8b9-6fdb58d85a6a", text: "<R3 verify prompt: scope = phase 1+2+3 fix 后的 B 文件清单 + skip + focus>"})`
- [ ] Step 4.2b — 同 prompt send 到 reviewer-codex · B (`b81ce2df-27e4-413b-b73a-94a07a1e8a2a`, team `d1d061a1-22f4-4491-a8b9-6fdb58d85a6a`)
- [ ] Step 4.2c — 等两路 reply 自动注入

#### Step 4.3 — R3 三态裁决

- [ ] Step 4.3 — 双方一致 0 HIGH/MED → ✅ 进 phase 5；任一方有 HIGH → 修复后再 R3；MED 单方独有 → lead 现场验证或反驳轮

### Phase 5：收口 — plan-review MED-3 claude 修订（加 pnpm test 全套）

- [ ] Step 5.1 — `zsh -i -l -c "pnpm typecheck"` + `zsh -i -l -c "pnpm test"`（**全套**单测+集成测，plan-review MED-3 claude 修订）+ `zsh -i -l -c "pnpm build"` 全过（worktree 内）
- [ ] Step 5.2 — 写 `<main-repo>/changelog/CHANGELOG_X.md`（X = 当前最大 + 1）：deep-review-batch-a1-b-fixes 概要 + 引用归档 plan
- [ ] Step 5.3 — 更新 `<main-repo>/changelog/INDEX.md`
- [ ] Step 5.4 — 写 `<main-repo>/reviews/REVIEW_46.md`（接 REVIEW_45 之后）：本次 deep review 报告（finding 全表 + 三态裁决依据 + 修法清单 + R3 verify 结果）
- [ ] Step 5.5 — 更新 `<main-repo>/reviews/INDEX.md`
- [ ] Step 5.6 — `git -C <worktree> add` + `git commit` 多个逻辑 commit（按 phase 切，commit msg 含 finding ID）
- [ ] Step 5.7 — `ExitWorktree(action: "keep")` 切 cwd 出 worktree
- [ ] Step 5.8 — `mcp__agent-deck__archive_plan({plan_id: "deep-review-batch-a1-b-fixes-20260519", worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-batch-a1-b-fixes-20260519", base_branch: "main", changelog_id: "X"})` 一行原子收口
- [ ] Step 5.9 — `shutdown_session × 6`（4 review + 2 plan-review reviewer）释放 teammate

---

## 当前进度

**当前会话状态**：
- ✅ Step 0 RFC 两轮完成（4 + 4 = 8 题对齐 design 决策）
- ✅ Step 0.5 spike 完成（hook tool_use_id 实证 + plan-review codex MED-1 修正后限定 PostToolUse 路径独有）
- ✅ Step 1 plan 文件写作（v2 修订完成 — 处理 plan-review 5 HIGH + 7 MED + 2 LOW）
- ✅ Step 1.5 plan-review 双对抗完成（5 HIGH + 7 MED + 2 LOW）
- ⏳ Step 1.5 修订 plan 后**重新进入 Step 1.5 二次评审 OR 直接 user confirm Step 2 进 worktree**（**当前节点**）
- ⏳ Step 2 EnterWorktree
- ⏳ Phase 1-5 实施

**reviewer teammate 状态**：
- A1 team `review-adapters-claude-bridge` (`61fd5cbb-d307-44e5-b76f-b1ae8ecc48e2`)：reviewer-claude (`50eedfda-38dd-4f1a-9c28-ec15af4d5166`) + reviewer-codex (`01d00d36-e71e-49a2-9153-a879d0d60c41`)
- B team `review-mcp-handlers` (`d1d061a1-22f4-4491-a8b9-6fdb58d85a6a`)：reviewer-claude (`af26be58-29b4-4b74-973b-27cd978c66a1`) + reviewer-codex (`b81ce2df-27e4-413b-b73a-94a07a1e8a2a`)
- plan-review team `review-plan-deep-review-batch-a1-b-fixes` (`53b37614-a372-4fd4-8abb-c610999febbe`)：reviewer-claude (`7f1d1b55-ceee-478b-97b1-c2489ff46fd7`) + reviewer-codex (`d8443efb-5922-440b-b784-9e63a169ab09`)

## 下一会话第一步（plan-review HIGH-5 codex 修订 — cold start worktree 兜底）

如本会话 context 不足以走完 phase 1-5，hand_off 给新会话。新会话 cold start：

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/plans/deep-review-batch-a1-b-fixes-20260519.md`（强制 cat 而非 Read，避免 cross-session jsonl cache 拿到旧版本）
2. **worktree 存在性兜底**（plan-review HIGH-5 codex 修订 + plan-review v2 NEW-MED 双方独立修订 — 旧版仅 path exists/missing 二档不覆盖 branch 已存在 / path exists 非 worktree / stale .git/worktrees metadata 等边角）：
   - 跑 `Bash: test -e /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-batch-a1-b-fixes-20260519 && echo EXISTS || echo MISSING`
   - **EXISTS**：先 sanity 检查是否真 worktree：跑 `Bash: git -C /Users/apple/Repository/personal/agent-deck worktree list --porcelain | grep -A1 '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-batch-a1-b-fixes-20260519'`
     - 输出含 `branch refs/heads/worktree-deep-review-batch-a1-b-fixes-20260519` → 进 step 3 EnterWorktree（path:）
     - 输出空（path exists 但非已注册 worktree / stale metadata） → 提示 user 决策：手动 `git worktree prune` 清 stale 再重建，或 `rm -rf <path>` 后回到 MISSING 分支
   - **MISSING**：进一步 branch 是否已存在判定（plan-review v2 NEW-MED reviewer-claude 修订）：
     - 跑 `Bash: git -C /Users/apple/Repository/personal/agent-deck branch --list worktree-deep-review-batch-a1-b-fixes-20260519`
     - 输出空（branch 也不存在） → 走原 `git -C <main-repo> worktree add -b worktree-<plan-id> <worktree-abs-path>` 新建 branch + worktree
     - 输出非空（branch 已存在但 worktree 被外删 / 跨设备同步未带 working tree） → 走 `git -C <main-repo> worktree add <worktree-abs-path> worktree-<plan-id>` 复用已存在 branch 重建 worktree（不带 -b）
3. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-batch-a1-b-fixes-20260519")`
4. 自检 `Bash: pwd`（应在 worktree 内）+ `git -C <worktree> rev-parse HEAD`（应等于 base_commit `7d059e8` 或之后的 fix commit）
5. 按 plan **§步骤 checklist** 找下一个未打勾步骤继续；不重新讨论 §设计决策；所有指向代码资产的路径换 worktree 前缀（`<main-repo>/.claude/worktrees/<plan-id>/<rel>`）
6. 进度 / 决策变更先告诉用户征得确认

## 已知踩坑（实施时避开）

1. **EnterWorktree CLI v2.1.112 stale base bug**：禁用 `EnterWorktree(name:)` 单步形式（撞 origin/<default> stale base），必须 Bash 显式建 worktree + `EnterWorktree(path:)` 两步形式
2. **worktree 路径陷阱**：进 worktree 后凡指向**代码资产**的路径都必须含 `.claude/worktrees/<plan-id>/` 前缀。`cwd` 切了不代表绝对路径自动重映射
3. **macOS 没 timeout / gtimeout**：禁止在 Bash 命令体里写 `timeout 5m ...`，超时只走 Bash 工具调用本身的 `timeout` 参数
4. **better-sqlite3 binding ABI**：跑 vitest SQLite 真测前后必须保护 binding；fix 阶段 phase 3 测试如撞 NODE_MODULE_VERSION 错走清缓存脚本
5. **A1-HIGH-1 修法 (A) 改动范围**：consume catch 改 throw 后，stream-processor + index.ts createSession catch 路径需对齐；plan-review HIGH-2 已修订 guard 位置 = `index.ts:294-297`（不是 session-finalize.ts 内部）
6. **B-HIGH-1 修法 (C) 三处协同**：transport-stdio.ts:77 + transport-http.ts:92-98 + helpers.ts:54-76 三处必须**同步**修改；任一处漏改 spoofing 路径仍开。**CallerContext.transport 字段已在 types.ts:54 存在，不需新增**（plan-review HIGH-1 codex 修订）
7. **A1-MED-1 (codex) 修法 (Step 3.5) 是架构改动**：file-changed emit 时序从 tool_use → tool_result，需引入 `pendingFileChangeIntents` Map + session-end cleanup；与 Step 3.4 hook 路径无需对称改造（PostToolUse 已经是 tool-use-end 后 emit）
8. **R3 verify 用 dormant reviewer 复用 mental model**：`send_message` 自动 SDK resume 复原对话历史；不要 shutdown 重 spawn（丢 mental model）。**Phase 4 Step 4.0 必先自检** dormant reviewer 状态（plan-review MED-2 claude 修订）
9. **fix 期间 reviewer-claude · A1 给的「订正」**：HIGH-1 上 codex 推理「recovering 标记」不适用（recovering Map 在 createSession 路径不参与），但「opts.resume sdkOwned claim leak」是真 — 修法 Step 2.1 必须包括 releaseSdkClaim(opts.resume)
10. **base_branch = main**：本 plan 切 worktree 时主仓库 HEAD 在 main；archive_plan ff-merge 目标也是 main（frontmatter `base_branch: main`）
11. **测试文件路径统一**（plan-review LOW-1 codex 修订）：所有新测试统一放 `src/<module>/__tests__/<test>.test.ts`（与现有 MCP / sdk-bridge 测试同款），不用顶层 `tests/` 路径
12. **A1-MED-3 jsdoc 修法范围错位**（plan-review HIGH-3 claude 修订）：原 jsdoc 描述粒度仅 findFallbackCwd 函数本身（jsdoc 对 helper 视角是正确的）— 修法降级为「不动 jsdoc，加 caller 链路 NOTE」；不要按 R1 finding 字面把 jsdoc 改反向
13. **A1-MED-4 hook 修法范围**（plan-review MED-1 codex 修订 + spike 修正后）：仅 `translatePostToolUse` 路径（L192）补 toolCallId；`PreToolUse` / `PostToolUseFailure` 不是 emit `file-changed` 路径不涉及；`PermissionRequest` 没 tool_use_id 是 SDK 协议事实
14. **plan-review HIGH-4 覆盖矩阵**：本 plan 已加完整 finding → phase step → source → 裁决 表格；MED 编号用 `(claude)` / `(codex)` 后缀消歧（A1-MED-1/2 同号不同 source）
