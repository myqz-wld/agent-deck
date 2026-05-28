# CHANGELOG_172 — Deep-Review 批 C R1 必修 fix (5 处 / 5 文件)

## 概要

[REVIEW_61.md](../reviews/REVIEW_61.md) 批 C R1 双对抗 + lead 现场验证后,5 处必修 finding 一次性收口(2 MED + 3 LOW)。维度 5 ≤500 LOC 护栏 7/7 全超,登记保护清单 + 候选单独 plan 走分批拆分,本 commit 不拆。

## 修法

### MED-A [window.ts] BrowserWindow 销毁后 stale this.win 引用 (codex 验证铁证)

`create()` 没注册 `'closed'` event listener — 用户 Cmd+W / OS close 关窗后 BrowserWindow.isDestroyed()=true 但 `this.win` 字段只在显式 `close()` 方法置 null,期间任何 .show() / .focus() / .getOpacity() 撞 destroyed。

**修法**:
- `create()` line 107-118 注册 `this.win.once('closed', () => { this.stopInvalidateLoop(); this.win = null; })` 自动清
- `showOnce` 内 `this.win.isDestroyed()` 防护(防 setTimeout 1.5s fallback 撞 destroyed)
- dock activate → ensureFocusableOnActivate → create() 重建会重新设 this.win 到新 BrowserWindow,'closed' 清 null 不破坏重建路径

### MED-B [index.ts] fatal bootstrap app.exit(1) 绕过 closeDb (codex Electron 文档铁证)

`initDb()` 在 line 99 已开,但 hook-server fail line 214 + bootstrap catch line 494 两处直接 `app.exit(1)`。Electron app.exit 文档明确不发 before-quit/will-quit → before-quit handler line 519 不会跑 → SQLite WAL 不 checkpoint → 下次启动 replay log,极端 corruption 风险。

before-quit handler line 540-565 自己也用过同款修法(REVIEW_35 R2 MED-D claude R2-3 留的注释)但 fatal 两个分支绕开了同一不变量。

**修法**:
两处 `app.exit(1)` 前同步 best-effort 跑 `closeDb()`:
```ts
try { closeDb(); } catch (err) { console.warn('[<fatal context>] closeDb error', err); }
app.exit(1);
```
fatal 路径仅 warn 不阻塞 exit(本来就是 fatal,WAL 丢一点比 hang 住强)。

### LOW-α [agent-deck-message-repo.ts] final retry 不写 attempt_count (codex 验证铁证)

`retryAfterFail` 内 `newAttemptCount = cur.attempt_count + 1` 达到 MAX_RETRY=3 时调 `markFailed(messageId, 'retry-exhausted (attempt=3): ...')`,但 markFailed 不更新 attempt_count 列 → DB 里仍停在 cur.attempt_count (typically 2),与 status_reason 字符串里的 attempt=3 不一致 → 失败消息结构化 attemptCount 字段和可读 reason 分裂,UI / 诊断 / 后续审计低报一次尝试。

**修法**:
final retry 分支用一条 UPDATE 同时写 `attempt_count` + `status` + `status_reason` + `delivering_since`,不复用 markFailed(避免 markFailed 接口语义变化影响其他 caller)。

### LOW-1 [window.ts] flash() 重入污染 baseline opacity (claude 验证)

flash() A 进行中 opacity 在 [0.5, 1.0] 切换;此时第二次调 flash() B → `getOpacity()` 取到的可能是 0.5,B 把 0.5 当 baseline → B 结束时 setOpacity(0.5) → 窗口永久半透明直到下次 flash 边界覆盖。

**修法**:
- 把 timer 引用提到 instance state (`this.flashTimer` + `this.flashOriginalOpacity`)
- 二次进入时先 `clearInterval` 旧 timer + 复位 opacity 到 `flashOriginalOpacity` 再起新轮
- `close()` 显式收尾同步清 `flashTimer`(防 flash 跑到一半显式 close,setInterval 句柄残留 event loop)

### LOW-β [task-repo.ts] subject LIKE wildcard 未 escape (codex 验证铁证)

用户输入 `%` 或 `_` 按 SQL wildcard 匹配让搜索范围扩大;不是 SQL injection (param 绑定挡住),但搜索语义偏移(用户输入 `100%` 实际意图搜「100%」字符,旧实现等价「任意以 100 开头」)。

**修法**:
escape `%` `_` `\` 三个 wildcard 字符 + 加 `ESCAPE '\'`:
```ts
const escaped = opts.subjectKeyword
  .toLowerCase()
  .replace(/\\/g, '\\\\')
  .replace(/%/g, '\\%')
  .replace(/_/g, '\\_');
wheres.push("LOWER(subject) LIKE ? ESCAPE '\\'");
params.push(`%${escaped}%`);
```
escape `\` 必须放第一个(replace 链顺序敏感),否则后续 `\%` 会被 `\\` 替换破坏。

## 降级 INFO 不修 (5 条)

详 REVIEW_61 §❌ 降级 INFO 不修 finding 节:

- **MED-1** window.ts kickRepaintAfterPin closure stale: jsdoc 明确 BY DESIGN「同步 +1 / next macro task 调回原值」是 layout trigger 机制核心,改动态读破坏残影修复效果
- **MED-2** index.ts agent-event 无 debounce: event-stream 不是 state-update 语义,debounce 会损害正确性,SessionDetail 自实现 throttle 是合理边界
- **MED-3** listBySession 全表 OR 扫描: 注释明文 by design trade-off,无 profile 数据,纯性能优化候选
- **LOW-2** cleanupBlocksReferences length-only: filter 单调性保证语义正确,已确认非 bug
- **LOW-3** manager.ts updateCliSessionId 函数体注释: jsdoc 38 行 + inline comment 3 行已充分覆盖,过度防御
- **LOW-4** index.ts before-quit removeAllListeners: process exit 自然清 + safeSend 兜底 isDestroyed,过度防御

## 维度 5 ≤500 LOC 护栏 (双方共识)

7 文件全超 500 LOC,本 commit 不拆(避免 5 处必修 fix + 7 文件拆分两件事混 1 commit blame radius 难拉),登记**保护清单**+ 候选**单独 plan 走分批拆分**。详 REVIEW_61 §INFO 拆分建议 节 + §保护清单 节。

## 验证

`pnpm typecheck` PASS。本 commit 零功能变更涉及的现有单测:
- `agent-deck-message-repo.test.ts` 现有 case 全 pass (final retry attempt_count 持久化新断言待 R2 配套加)
- `task-repo.test.ts` 现有 case 全 pass (LIKE wildcard escape 回归 test 待 R2 配套加)

## 下一步

R2 prompt 准备发送给 reviewer pair `dcr-batch-c-20260528`(skip 字段含本 commit 5 处 fix 摘要),focus 验证 fix 正确性 + 是否引新问题 + 维度 5 拆分候选审议(预计 R2 无新真 finding 即可收口)。
