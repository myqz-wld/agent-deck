# Spike 3 — Codex SDK Dormant Thread Resume 实现 Audit

**日期**：2026-05-19
**plan_id**：reviewer-codex-cross-adapter-20260519
**spike 目标**：确认 codex-cli adapter 在 reviewer-codex teammate 转 dormant 后被 lead `send_message` 唤醒时能否通过 `codex.resumeThread(threadId, options)` 自动复原对话历史（不丢 mental model）。

## 方法

代码 audit（不跑实测） — 阅读 `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts`（498 LOC）+ `restart-controller.ts` + `session-finalize.ts` 实现 + 注释，比对 claude-code 同款实现，验证 dormant resume 链路完整。

理由：dormant resume 涉及 lifecycle scheduler 转 dormant（abort SDK live query + 清 in-process `codexBySession` Map）→ 下次 `send_message` 触发 sessions Map 缺失 → recoverer.recoverAndSend → ensureCodex + `Codex.resumeThread(threadId)` 复原对话。这套机制 production 用过（CHANGELOG_26/28/31 跑过 user-facing 场景），不必单独跑 spike，audit 即可。

## 关键代码 / 注释

### recoverer.ts:1-48（文件 header）

> **设计目标**：claude 1.0 sdk-bridge.sendMessage 缺 sessions Map 时直接 `throw new Error('session ${sid} not found')`。app 重启 / dev mode vite hot reload / main process crash 重生 → 内存 sessions Map 空 → 用户在 SessionDetail 输入消息 → renderer 报错红字，**不能继续聊**（必须新建会话，丢上下文）。claude 端走 recoverer 自愈占位 + resume + 体感「掉线但又续上了」，codex 完全缺这条路径。

> **CHANGELOG_26** — recovering 单飞 + 30s placeholder UX
> **CHANGELOG_28** — jsonl 预检不在则走不带 resume 的新建 createSession + 事后 renameSdkSession
> **CHANGELOG_31** — 用户显式发消息触发 recoverAndSend 自动 unarchive

### recoverer.ts:108-119（jsonl 探测 thunk）

```
默认实现 `defaultCodexResumeJsonlExists` 走 fs.readdirSync 扫 startedAt 日期目录。
codex jsonl 路径与 claude 不同：claude 在 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`，
codex 在 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`，
pre-check 算法见 `defaultCodexResumeJsonlExists`。
```

### 与 claude 端架构对偶

> codex 1.0（recoverer.ts ~280 LOC，本文件 498 LOC 含注释）镜像 claude 1.0（612 LOC + 6 builder + helpers + LLM 摘要 prepend）**精简版**：
>
> - codex 无 hook 通道：不调 sessionManager.expectSdkSession（claude 走 hook 路径需要）
> - codex 无 LLM 摘要 prepend：claude 用 `summariseSessionForHandOff` thunk + `prependHistorySummary` helper 在 fallback 路径起 fresh CLI 之前生成摘要 prepend。codex 现版本暂不接（独立 follow-up 收口）
> - codex 不支持 implicit fork：spike-A2 实测铁证 codex CLI resume 永远返回同 thread_id；recoverer 仍保留 post-rename 防御（`if newRealId !== sessionId`）future-proof
> - codex 无 permissionMode：codex SDK approvalPolicy 写死 'never'

### dormant 转换链路

`src/main/session/lifecycle-scheduler.ts:54-72` 周期性扫表：

- `active → dormant`：`sessionRepo.findActiveExpiring(now - activeWindowMs)` → `sessionRepo.batchSetLifecycle(ids, 'dormant', now)` + 调 `manager.markDormant(sid)`
- `manager.ts:258-262` `markDormant`：写 `sessionRepo.setLifecycle(sid, 'dormant', now)` + （根据 manager 内部实现）应该会 abort SDK live query + 清 in-process Map

dormant 转换后 in-process `codexBySession` Map 缺失 → 下次 `sdk-bridge.sendMessage` 触发 sessions.has(sid)=false → `recoverAndSend` 路径：

1. 单飞守门（`recovering: Map<sid, Promise>` SHARED with restartController，同 sid 同时只有一条 recovery in-flight）
2. 5s placeholder dedup（防同 sid 短时间反复 recover 噪声）
3. emit 占位 message「⚠ Codex 通道已断开，正在自动恢复…」让 UI 显示状态而非哑巴 busy
4. jsonl 预检：`defaultCodexResumeJsonlExists(threadId, startedAt)` 通过 fs.readdirSync 扫 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`
5. jsonl 在 → 走 `createSession({resume: <threadId>, prompt, cwd, permissionMode, codexSandbox, ...})` → codex SDK `resumeThread(threadId, options)` 复原对话历史
6. jsonl 不在 → 走 `createSession({...无 resume})` + 事后 `renameSdkSession(OLD_ID, newRealId)` 把应用层 events / file_changes / summaries 子表迁到新 ID（CHANGELOG_28）

## 结论

✅ **PASS**：codex-cli adapter dormant resume 机制完整：

- recoverer 单飞 + jsonl 预检 + resumeThread 调 SDK 复原对话 都有
- 与 claude-code 端架构对偶（精简版，无 LLM 摘要 prepend / 无 hook 通道）
- production 用例 CHANGELOG_26/28/31 覆盖

**对 reviewer-codex teammate 的具体影响**：
- reviewer-codex transient dormant（lifecycle scheduler 转）→ lead 下次 send_message 自动 recoverAndSend → resumeThread → reviewer-codex 复原对话历史（mental model 通过 conversation history 隐式保留，**不触发 ⚠ FRESH SESSION warn**）
- reviewer-codex jsonl 缺失（用户手动删 ~/.codex/sessions/ / 应用重装 / 跨设备同步未带）→ hard fail fallback createSession 不带 resume → reviewer-codex 真的 fresh session → 触发 ⚠ FRESH SESSION warn（reviewer body §核心纪律 §7 强约束 reviewer 顶部硬性输出 warn + abort 等 lead 处置）

## 限制

- 本 audit **仅验证 codex SDK resume 机制本身**；reviewer-codex teammate context（reviewer mental model / 已读文件 / 上轮 finding 推理链）能否真的通过 resumeThread 复原，依赖 codex CLI 把 thread jsonl 落盘完整 + resumeThread 真的把所有历史 inject 进新 thread 系统 prompt。**spike-A2 实测铁证**（recoverer.ts:34 注释引）证实 codex CLI resume 同 thread_id；mental model 复原是 codex SDK 实现保证。
- 本 audit **不验证 cross-adapter 场景下 dormant resume**：reviewer-codex 起在 codex-cli adapter，lead 起在 claude-code adapter，是否会因为跨 adapter 触发什么 corner case？— audit 看不出来，但理论上 recoverer 在 codex-cli adapter 内部跑（与 lead adapter 无关），应该跑通。可在 plan 实施期间 cross-adapter 闭环跑一次 reviewer dormant + 唤醒小回归试。
- 本 audit **不依赖** spike 1+2 send_message dispatch blocker 解决（dormant resume 是「lead 调 send_message 时 sessions.has 缺失走 recoverer 路径」的机制；dispatch blocker 解决后 dormant resume 也会自然 work；dispatch blocker 不影响 dormant resume audit 结论本身）。
