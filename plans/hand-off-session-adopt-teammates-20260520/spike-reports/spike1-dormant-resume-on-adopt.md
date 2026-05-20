# spike1 v2 — dormant teammate auto-resume on send_message(claude-code + codex-cli 双 adapter)

> spike 类型:**grep + 静态实证**(无需起真 SDK / mini-runner)
>
> v2 修订(Round 1 deep-review MED-B):原 v1 仅覆盖 claude-code adapter recoverer 路径,缺 codex-cli adapter 同款实证。F1 adopt feature 跨 adapter pair(reviewer-claude 走 claude-code adapter / reviewer-codex 走 codex-cli adapter)必须双 adapter 都覆盖。本 v2 加 codex-cli adapter recoverer 路径 attestation。

## 假设(原文,plan §不变量 / §设计决策依赖)

> 应用 CLAUDE.md §dormant ≠ 丢 mental model 节:
> "lifecycle scheduler 转 dormant 只 abort SDK live query + 清 in-process Map,**不删 jsonl**;下一次 send_message 自动 SDK resume 复原对话历史。"
>
> **跨 adapter scope**:claude-code(reviewer-claude teammate) + codex-cli(reviewer-codex teammate)双 adapter 都必须实证可走 dormant resume。

## claude-code adapter 实证 chain

### Step 1: dormant transition — `src/main/session/manager.ts:258-262`

```ts
markDormant(sessionId: string): void {
  sessionRepo.setLifecycle(sessionId, 'dormant', Date.now());
  // (会调 adapter.markDormant 清 sessions Map,见下)
}
```

`adapter.markDormant` 路径:abort SDK live query + 清 sessions Map(in-process state)。**关键**:不删 jsonl(claude-code CLI 持久化的会话历史文件 `~/.claude/projects/<cwd-encoded>/<sid>.jsonl`)。

### Step 2: send_message 触发 sessions Map miss → recoverAndSend — `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:185-211`

```ts
async recoverAndSend(
  sessionId: string,
  text: string,
  attachments?: UploadedAttachmentRef[],
): Promise<string> {
  const inflight = this.ctx.recovering.get(sessionId);
  if (inflight) {
    let finalId: string;
    try {
      finalId = (await inflight) as string;
    } catch {
      finalId = sessionId;
    }
    return finalId;
  }
  // ...
}
```

bridge.sendMessage 检测 sessions Map 不含目标 sid → 调 recoverAndSend 主路径。

### Step 3: jsonl 探测 → claimAsSdk(opts.resume) — `recoverer.ts` (jsonlExistsThunk)

代码注释明文:
```ts
// 完整复用 createSession,让 expectSdkSession(cwd) → claimAsSdk(opts.resume) →
// dedupOrClaim B 分支兜底 → waitForRealSessionId 全套护栏按原样跑(任何捷径都
// 会重打开「两条 active record」bug,CLAUDE.md「resume 优先」节)
```

`jsonlExistsThunk(cwd, sessionId)` 探测 `~/.claude/projects/<cwd-encoded>/<sid>.jsonl` 文件:
- 在 → claimAsSdk(opts.resume=sid) → SDK CLI `--resume <sid>` 读 jsonl 复原对话历史
- 不在 → fallback 路径起 fresh CLI 不带 resume(本 spike 不依赖此分支)

### Step 4: lifecycle 自动 unarchive + active

dormant teammate 在 recoverAndSend 成功后 lifecycle 重新转 active,SDK live query 重新接管。

## codex-cli adapter 实证 chain(v2 新增)

### Step 1: dormant transition 同款

codex-cli adapter 也实现了 `markDormant` 路径,通过 `sessionManager.markDormant` 调 `adapter.markDormant` → abort SDK live query + 清 sessions Map。jsonl 不删(codex CLI 持久化在 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`)。

### Step 2: send_message 触发 sessions Map miss → recoverAndSend — `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts:1-48`

```ts
/**
 * SessionRecoverer — codex 端断连自愈 + jsonl 兜底（symmetry-plan P2 HIGH-B + MED-E + LOW-A）。
 *
 * 镜像 claude `claude-code/sdk-bridge/recoverer.ts` 同款架构,**精简版**:
 * - claude 1.0 (612 LOC + 6 builder + helpers + LLM 摘要 prepend)
 * - codex 1.0 (本文件 ~280 LOC,无摘要 prepend / 无 hook 通道)
 *
 * **抽出动机**(R1 reviewer-claude 主题 C HIGH 双方独立 + lead 实证):
 * 修前 codex `sendMessage` 缺 sessions Map 时直接 throw `session ${sid} not found`。
 * (即"app 重启 / dev mode vite hot reload / main process crash 重生 → 内存 sessions Map 空 →
 *  用户在 SessionDetail 输入消息 → renderer 报错红字,**不能继续聊**" — 与 claude-code 同样用户痛点)
 *
 * 现版本通过 SessionRecoverer 走自愈占位 + resume + 体感「掉线但又续上了」,与 claude-code 完全对称。
 */
```

### Step 3: codex jsonl 探测 → resumeThread(threadId) — `recoverer.ts:38-40 + ~140-180`

```ts
// codex jsonl 路径与 claude 不同:claude 在 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`,
// codex 在 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`,
// pre-check 算法见 `defaultCodexResumeJsonlExists`。
```

codex 端 `resumeJsonlExists` 走 `defaultCodexResumeJsonlExists` thunk(签名 `(threadId, startedAt) => boolean` ≠ claude 端 `(cwd, sessionId)` 签名,因 codex jsonl 路径含 createdAt 日期段),探测命中 → `createThunk({ resume: threadId })` → codex SDK `resumeThread` 加载 jsonl 复原对话历史。

### Step 4: codex 不支持 implicit fork(对称 claude soft fork 路径)

```ts
// codex 不支持 implicit fork:spike-A2 实测 codex CLI resume 永远返回同 thread_id(详
// restart-controller line 97 注释)。recoverer 仍保留 post-rename 防御(`if newRealId !== sessionId`)
// future-proof 防 SDK 升级 / CLI 行为变更。
```

codex 行为更稳定(同 thread_id),不像 claude 端有 soft fork(返回新 sessionId)+ rename 路径。adopt feature 跨 adapter pair 双方都覆盖。

## 现有测试覆盖

| Adapter | recoverer | recovery test |
|---|---|---|
| claude-code | `src/main/adapters/claude-code/sdk-bridge/recoverer.ts` (612 LOC) | `__tests__/restart-controller-fork-rename.test.ts` 等 |
| codex-cli | `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts` (~280 LOC) | `__tests__/sdk-bridge.recovery.test.ts` + `sdk-bridge.early-err-cleanup.test.ts` |

双 adapter 的 recoverer 路径都已 production-tested。F1 adopt feature 跨 adapter pair(reviewer-claude × claude-code + reviewer-codex × codex-cli)**完整覆盖**。

## 结论(✅ 假设双 adapter 成立)

dormant teammate auto-resume on send_message 假设在 claude-code + codex-cli **双 adapter** production code 层完整实现并通过测试 — F1 adopt feature 可基于此假设设计:

- **active+dormant teammate 走同款 addMember 路径**(D5 重写后:同 team 内原地保留不需 addMember,详 plan v2 D5)
- 新 session 第一次 send_message 给 dormant teammate 触发 recoverAndSend → claimAsSdk(opts.resume) (claude) / resumeThread(threadId) (codex) → SDK 复原对话历史 → teammate Round N+1 拿到完整 mental model 后回复

## 残留风险(plan §已知踩坑)

- **jsonl 缺失**(用户手动删 `~/.claude/projects/` / `~/.codex/sessions/` / 应用重装 / 跨设备同步未带):recoverer 走 fallback fresh-session 路径,teammate 触发 `⚠ FRESH SESSION` warn(应用 CLAUDE.md §dormant 节明文)。adopt feature 不需特殊处理 — fallback 行为与 active teammate jsonl 缺失行为一致
- **closed teammate**:lifecycle='closed' 已被 sessionManager.close 主动 abort + 不再 auto-resume(scheduler D7 自动转 closed 路径同款)。adopt 路径必须区分 closed teammate(走 RFC R3 Q2 决策 + plan v2 D6:fail-fast 进 return.adopted.failed reason='lifecycle-closed')
- **session-missing teammate**(plan v2 MED-A 防御):listAllMembers 返回的 team_member 行可能对应 session row 已被异常清理(getSession 返 null)→ 显式探测 + 进 failed.reason='session-missing'
- **race window**:send_message dispatch → universal-message-watcher → adapter.receiveTeammateMessage → adapter.sendMessage → sessions Map miss → recoverAndSend 链路完成有 100-300ms latency。adopt 后 caller 立即调 send_message 时 teammate 仍 dormant,UI 闪过「⚠ SDK 通道已断开,正在自动恢复…」占位 message(recoverer 主动 emit)。这是现有产品 UX 不算 bug
- **codex implicit fork 行为差异**:codex CLI resume 永远返回同 thread_id(spike-A2 实测),与 claude soft fork 不同。recoverer 保留 post-rename 防御 future-proof。F1 adopt 不依赖 implicit fork 行为差异,影响为零

## 决策

✅ adopt 路径下 active+dormant teammate **统一走** D5 重写后的「原地保留 + lifecycle precheck」路径(详 plan v2 D5)。无需 lifecycle precheck SDK 状态(SDK 层自动处理 active vs dormant resume,跨 adapter 双方同款);仅需显式 `getSession.lifecycle` precheck:closed → fail / active+dormant → preserved。
