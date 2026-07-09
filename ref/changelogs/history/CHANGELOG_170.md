# CHANGELOG_170 — Deep-Review 批 B fix（sdk-bridge 双端断连自愈 + cross-adapter parity + UI 噪声过滤）

## 概要

[REVIEW_60.md](../../reviews/history/REVIEW_60.md) 批 B（sdk-bridge 双端 4 文件 3018 LOC）deep-review 3 轮异构对抗收口 — 共 **1 HIGH + 3 MED = 4 处 src 必修** 一次性收口。零 src 改动 follow-up（仅 2 处 test 补缺 + 1 处已有 source 注释的 LLM 摘要 parity gap + 1 处 *未验证* 其他 loader pattern）。

## 修法

### F1 [MED] 双端 recoverer single-flight 锁覆盖 archived unarchive 整段

`claude-code/sdk-bridge/recoverer.ts` + `codex-cli/sdk-bridge/recoverer.ts` 把 archived session unarchive + 占位 message dedup 整段从 IIFE 外移到 IIFE 内（同步注册 `this.ctx.recovering.set(sessionId, p)` 紧跟 IIFE 立即执行），让 single-flight 锁覆盖 `await sessionManager.unarchive(sessionId)` 整段。

**修前 bug**：`inflight check` (L248/L186) 与 `recovering.set` (L515/L447) 之间存在 `await sessionManager.unarchive` 窗口（L389/L319），两个并发 sendMessage 打到同 archived session 时双方都通过 inflight check → 各自创建 IIFE → 双 createSession，破坏「同 session 只允许一条 recovery in-flight」不变量（reviewer-codex R1 MED 单方 finding + lead 现场验证）。

### F2 [MED] codex createSession 顶层 try/catch 防早期失败泄漏

`codex-cli/sdk-bridge/index.ts` createSession 函数体加顶层 try/catch（L442 try / L777-818 catch），catch 内 best-effort cleanup 4 资源：`codexBySession.delete(initialSid)` + `mcpSessionTokenMap.release(initialSid)` + `sessions.delete(initialSid)` + `(if opts.resume) sessionManager.releaseSdkClaim(opts.resume)`。每个 cleanup 独立 try/catch warn 不抛，最终 rethrow err。

**修前 bug**：createSession 整个函数体无顶层 try/catch，`allocate(initialSid)` (L429) 之后任何 throw（ensureCodex / loadCodexSdk / new sdk.Codex / startThread / resumeThread sync throw）都让 token + (可能已 set 的) codex 实例 + (可能已 set 的) sessions Map entry + sdkClaim 全泄漏。与 claude createSession (L31-L165) try/catch 收口模板形成 cross-adapter parity gap（reviewer-codex R1 MED 单方 finding + lead 现场验证）。

cleanup 操作全部 idempotent（mcp-session-token-map.release sid 不在 → silent no-op + Map.delete / Set.delete 同款），thread-loop earlyErrCb (L675-692) 已 cleanup 的资源重复调用安全。

### F3 [HIGH] claude createSession catch 块双 key 清理 sessions Map（cross-adapter parity 收口）

`claude-code/sdk-bridge/index.ts` catch 块 (L436-455) 把 `this.sessions.delete(tempKey)` 改为 `this.sessions.delete(internal.applicationSid); this.sessions.delete(tempKey);` 双 key 清理。

**修前 bug**：plan reverse-rename-sid-stability-20260520 §A.4-pre §S2 已把 sessions.set (L380) 切到 `internal.applicationSid` 作 key，但 catch 块仍用静态 `tempKey` 作 delete key — resume 路径下 `applicationSid = opts.resume ≠ tempKey` → `sessions.delete(tempKey)` no-op → `opts.resume` entry 永远留在 Map 里 → 后续 sendMessage(opts.resume) `sessions.get` 命中 stale internal → 跳过 recoverer 自愈主路径 → push pendingUserMessages 进 stale internal → SDK 已 abort → 静默卡死。

**修法覆盖三分支**：(a) resume 路径 delete(opts.resume) 清正确 entry；(b) spawn 主路径无 first realId 时 applicationSid=tempKey，两个 delete 重复清同 key（idempotent）；(c) spawn 主路径 first realId 已切但 try 内 throw 时 delete(realId) 清新 entry + delete(tempKey) safety net。与 codex/sdk-bridge/index.ts L799 `sessions.delete(initialSid)` 形成 cross-adapter parity 收口（reviewer-claude R2 单方 HIGH + jsdoc 自相矛盾佐证 + codex 端正确反证 + lead 三分支现场验证）。

### F4 [MED] codex translate.ts ErrorItem LOADER_WARNING_PATTERNS 关键词 filter

`codex-cli/translate.ts` `case 'error'` (L385-417) 加 `LOADER_WARNING_PATTERNS = ['Ignoring malformed', 'failed to deserialize']` 关键词 filter。命中 pattern → `console.warn` 应用日志保留诊断，不 emit UI；未命中 → 维持原 `emit('message', { text: '⚠ <msg>', error: true })` 红 bubble 行为。

**修前 bug**：codex SDK `ErrorItem` (index.d.ts:83-87 "non-fatal error surfaced as an item") 被无差别 emit `error: true` 红 bubble。codex CLI 启动期间扫 `~/.codex/agents/*.toml` 加载 agent role definition 失败时产生大量 "Ignoring malformed agent role definition: failed to deserialize ... invalid type: map, expected a string" loader warning — 完全是用户配置问题（与应用层 / sdk-bridge / 当前 review scope 无关），却被错误投到 user-visible 红 bubble。用户实测 spawn reviewer-codex 时看到 15 条 loader 噪声红 bubble（5 个 .codex/agents/*.toml × 3 turn）严重污染 SessionDetail UI（lead 现场用户截图发现 + codex SDK ErrorItem 类型铁证）。

## 验证

- `pnpm typecheck` 0 error
- `pnpm exec vitest run` 16 files / 170 tests pass / 0 fail / 0 error（claude/codex sdk-bridge + recovery + early-err-cleanup + consume-fork + translate 全套）
- 4 处修法都属「补缺 cleanup / filter / parity 收口」类不改主路径行为，所有现有 test 期望未变（零回归）

## Follow-up

详 [REVIEW_60.md](../../reviews/history/REVIEW_60.md) §Follow-up：
1. **F5** codex jsonl-missing fallback 缺 LLM 摘要 prepend（已有 source 注释 follow-up 计划，独立 plan 收口）
2. **F6** 双端 recovery test 补 archived 并发 unarchive race 用例（test 补缺）
3. **F7** codex early-err-cleanup test 补 ensureCodex / startThread sync throw 3 用例（test 补缺）
4. **F8** 其他 codex CLI loader warning pattern（profile.toml / config.toml schema 错）扩 LOADER_WARNING_PATTERNS（等用户报项再加）
