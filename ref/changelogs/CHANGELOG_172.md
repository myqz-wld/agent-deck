# CHANGELOG_172 — Deep-Review 批 C R1+R2+R3 收口 (6 处必修 fix + 2 regression test)

## 概要

[REVIEW_61.md](../reviews/REVIEW_61.md) 批 C R1+R2+R3 三轮异构对抗 + lead 现场验证后,**6 处必修 finding** + **2 regression test 配套** 一次性收口。R1 5 处 fix(2 MED + 3 LOW)+ R2 LOW 1 处(window generation guard 三层防御)+ R2 INFO 2 test 配套。维度 5 ≤500 LOC 护栏 7/7 全超,登记保护清单 + 候选单独 plan 走分批拆分。

## 修法 (按 Round 顺序)

### R1 5 处必修 fix (commit d5549c6)

#### MED-A [window.ts] BrowserWindow 销毁后 stale this.win 引用 (codex 验证铁证)

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

### R2 LOW [window.ts] BrowserWindow generation guard 三层防御 (codex 验证序列 + claude FIX-2 自身漏点补全)

R2 reviewer-codex 抓到 reviewer-claude FIX-2 小补充漏掉的「卸 winA + 又新建 winB」双步: 旧 1.5s fallback setTimeout / flash setInterval cb / 'closed' listener 自身读 mutable `this.win` 跨 close+recreate 时拿到新 winB 误操作(showOnce winB.show() / flash 改新 winB opacity)。

**修法 (commit 5d389cf)**:
- `create()` 入口 `const capturedWin = this.win` 捕获本 generation,所有 callback 用 capturedWin 而非 mutable this.win + 加 `this.win !== capturedWin` generation guard
- `'closed'` listener 加 generation guard + 同步清 flashTimer + clearTimeout fallbackShowTimer + this.win = null (4 资源 best-effort cleanup,任一资源失败不互相阻塞)
- 1.5s 兜底 setTimeout 句柄存 instance state `this.fallbackShowTimer`,'closed' / `close()` 同步 clearTimeout
- `flash()` setInterval cb 同款 generation guard (跨 generation 不复位 winB opacity,避免污染新窗口真实 opacity)
- `close()` 同步清 flashTimer + fallbackShowTimer (双保险,close() 早于 'closed' event 时立即生效)

### R2 INFO [test] 2 regression test 配套 (codex 良性补缺)

R2 reviewer-codex 抓到 d5549c6 未改 test,R1 LOW-α + LOW-β 修法缺锁契约的回归 test。

**配套 (commit 5d389cf)**:
- `agent-deck-message-repo.test.ts` retryAfterFail final case 加 `expect(r?.attemptCount).toBe(3)` + `expect(r?.statusReason).toContain('attempt=3')` 锁 R1 LOW-α 契约 (旧实现 DB 列停在 2 与 reason 字符串 attempt=3 分裂,新 expect 会挂)
- `task-repo.test.ts` 新增 `subjectKeyword LIKE wildcard 字面匹配` test 23 行 (覆盖 `%` 字面排除 `1000` 误命中 / `_` 字面排除 `fooXbar` 误命中 / `\` 字面 Windows path 匹配,锁 R1 LOW-β 契约)

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

`pnpm typecheck` PASS。本 commit 涉及的现有单测:
- `agent-deck-message-repo.test.ts` 现有 case 全 pass + R3 新加 final retry attemptCount === 3 + statusReason 含 'attempt=3' 锁 R1 LOW-α 契约
- `task-repo.test.ts` 现有 case 全 pass + R3 新加 subjectKeyword LIKE wildcard 字面匹配 4 case(`%`/`_`/`\` 三 wildcard)锁 R1 LOW-β 契约
- SQLite test binding ABI 默认 skip(CLAUDE.md §打包踩坑清单明示守门,不主动跑 SQLite 真测避免 prebuild-install 覆盖 Electron binding 破坏 dev/.app 环境;binding 修好时 user 启动 .app 场景自动跑)

## Commit 序列

- **commit d5549c6**: R1 5 处必修 fix(MED-A / MED-B / LOW-1 / LOW-α / LOW-β)+ REVIEW_61 / CHANGELOG_172 / 双 INDEX
- **commit 5d389cf**: R2 LOW(window generation guard 三层防御)+ R2 INFO 2 regression test 配套

## 收口

R3 双 reviewer 共识 ✅ 可合本 R3 收口(reviewer-claude FIX-A/B/C/D 全 verify + reviewer-codex 0 finding 双方共识)。R1+R2+R3 三轮异构对抗整体结束。**SKILL 学习点**:R2 reviewer 互相补全 R1 自身漏点价值教科书级 case(reviewer-claude R2 FIX-2 小补充自身漏「卸 winA + 又新建 winB」双步,reviewer-codex R2 抓到完整序列),异构对偶价值再次实证 — 同源化双 Claude 会同时漏这个 R2 LOW。详见 REVIEW_61.md §最终收口总结 + §SKILL 学习点。
