# CHANGELOG_67: REVIEW_24 落地修复（HIGH-1 + HIGH-2 + 8 MED + 2 LOW）

## 概要

[REVIEW_24](../../reviews/history/REVIEW_24.md) 双异构对抗（reviewer-claude Opus 4.7 + reviewer-codex 三连失败后绕过 wrapper 直 Bash 拆批跑通）识别 11 ✅ finding（2 HIGH + 7 MED + 2 LOW + 2 ❌ 反驳证伪 + 4 ❓ 不修），全部落地修复。共 3 atomic commit。

## 变更内容

### `src/main/adapters/generic-pty/ansi-parser.ts`（commit `d6f31b4` + `bf9a302`）

- HIGH-1：PtyOutputBuffer 单 chunk ≥ capacity 走快路径截尾保留 capacity 字符（修 idle promptSuffix 检测彻底失效 — aider --no-stream 5-15KB chunk + `> ` 必中）
- MED Codex 3：promptSuffixRegex 长度上限 MAX_PROMPT_SUFFIX_REGEX_LENGTH=200 char，超出 fallback null 防 ReDoS

### `src/main/adapters/generic-pty/pty-bridge.ts`（commit `bf9a302`）

- HIGH-2：MAX_FIRST_PROMPT_BYTES (100_000 byte) → MAX_PROMPT_LENGTH (102_400 char) 与 `agent-deck-message-repo.ts` MAX_BODY_LENGTH 对齐 — 修 CJK / 接近 ASCII 上限 cross-adapter message 投递失败（PTY 写 stdin 是 char-based 不挑 byte）
- MED Codex 1+2：closeSession 序调整 — 先 SIGTERM 让 kernel 立即 grace → check sessions.has() 才设 killTimer 防 onExit 已 delete 后 timer leak → fileWatcher.close 改 fire-and-forget（不阻塞 closeSession 返回；shutdownAll 路径仍 await all close 释放 fs handle）
- MED Claude4：sendMessage 顶部 check intentionallyClosed 立即 throw "session is closing" 让 watcher 走 retry markFailed reason 准确，节省 3 次 retry quota
- MED Claude3：spawn-helper asar 路径替换从裸 `String.replace` 改 regex `/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'` 锚定路径段（与 `sdk-runtime.ts:87` 同款最佳实践，防 case 2 `app.asar.unpacked.unpacked` / case 3 用户路径含 `app.asar` 子串误吃）
- MED Claude5：ensureSpawnHelperExecutable boolean 单飞 → promise 单飞，后续 caller await 同一 promise 确保 chmod 完成才 spawn — 消除 race window

### `src/main/store/session-repo.ts`（commit `94f2a90`）

- MED Codex 6：parseGenericPtyConfigJson 加 `genericPtyConfigSchema.safeParse` 二次校验 — JSON.parse 后再走 zod 防合法 JSON 如 `"x"` / `42` / `[]` / `{}` silent 当 GenericPtyConfig 返回。defense-in-depth：写入端已 zod parse，读取端二次校验防用户手改 DB / migration 故障 / 历史脏数据

### `src/renderer/components/NewSessionDialog.tsx`（commit `94f2a90`）

- MED Claude6 + Codex 7：`<GenericPtyConfigForm key={agentId} ... />` 强制 remount，让用户切 Agent (aider ↔ generic-pty) 时 form 内部 useState 全 reset 到对应 preset 默认值

### `src/renderer/components/GenericPtyConfigForm.tsx`（commit `94f2a90`）

- LOW Codex 9：args parse 注释从「引号包裹保留为整体」改为明确「不支持引号」 + field label 加「（空格分隔，不支持引号）」让用户预期对齐

### `scripts/fix-pty-permissions.mjs`（commit `bf9a302`）

- LOW Codex 5：删 access + chmod 两步式 TOCTOU pattern，直接 chmod 捕 ENOENT silent

### 测试守门（commit `d6f31b4` + `bf9a302`）

`src/main/adapters/generic-pty/__tests__/ansi-parser.test.ts` + `pty-bridge.test.ts` 加 6 regression case：
- single chunk = capacity 边界
- single chunk > capacity（10 cap + 26 char）
- 9KB aider 风格答复 + 末尾 prompt 仍 match（HIGH-1）
- sendMessage 在 closeSession 后 throw "is closing"（MED Claude4）
- SIGTERM 先于 fileWatcher.close（codex MED 1）
- 超长 promptSuffixRegex (201 char) 拒绝 + fallback 纯 idleQuietMs（codex MED 3）

## 备注

- 验证：pnpm typecheck clean / 全量 vitest 325 passed | 55 skipped（之前 319 + 6 新 regression case）
- 不修条目（❌ 反驳 + ❓ 不修）已在 REVIEW_24 §❌ + §❓ 详细记录降级原因
- HIGH-2 仅修 R4 部分（`pty-bridge.ts` cap 改 length）；R3 老 adapter（claude-code / codex-cli）的 sendMessage cap 仍 byteLength 100_000 是系统性遗留，本轮不动 R3 老代码（避免越界）。Follow-up 应统一所有 adapter cap 与 messageRepo 一致 — 详 REVIEW_24 §HIGH-2
- 异构对抗失败兜底：reviewer-codex wrapper 三连失败（xaminim 平台 503）后用户决策「绕过 wrapper 试新 bash 环境」，第四轮直接 Bash 调外部 codex CLI 拆 2 批 background 跑通，详 REVIEW_24 §异构对抗失败兜底记录
