# spike2: Claude / codex SDK fork detect 触发条件 + 后续 sid

> spike 完成日期：2026-05-20
> runner: `spike2-runner.mjs` (read-only 静态实测)
> log: `spike2.log`

## 动机

plan §设计决策 D2 列出 7 处反向 rename 路径,但 grep 反查时 codex restart-controller 已被 REVIEW_40 R2 reviewer-codex P3 LOW 删除 (post-rename 防御 block 删,只剩注释 ref)。本 spike 验证:

1. claude SDK fork detect 实际触发条件
2. fork 判定逻辑 ground-truth (stream-processor.ts L305 `if (resumeId && resumeId !== realId)`)
3. fork 后 hook event 携带 sid
4. codex SDK 实测不支持隐式 fork (spike-A2 历史实证 + thread-loop case 3 仅做 future-proof)
5. **反向 rename 路径精准列表** (修正 plan §D2 — 实际 6 处不是 7 处)

## 实测命令 + 实测结果

### 实测 2.1: claude fork detect 判定逻辑

`stream-processor.ts:305`:
```typescript
if (resumeId && resumeId !== realId) {
  console.warn(`[sdk-bridge] CLI forked: requested resume=${resumeId} but got realId=${realId}; ...`);
  sessionManager.renameSdkSession(resumeId, realId);
}
```

- **resumeId** = `opts.resume` (应用层传给 SDK `query({resume})` 的 sid)
- **realId** = first SDKMessage.session_id (CLI 实际给的 sid)
- **触发条件 (CHANGELOG_27 / REVIEW_6 注释 L282-285)**:
  - SDK streaming input mode (默认开)
  - + opts.resume 非空
  - + 新 prompt
  - → CLI native binary 内置 fork → first session_id ≠ requested resume
  - 与 SDK 文档「forkSession 默认 false 不 fork」**不一致**(CLI 内置 fork 在更深层,应用层无法关闭)

### 实测 2.2: claude renameSdkSession 全部调用点 (5 处)

| file:line | 类型 | 是否反转 (D2) |
|---|---|---|
| `stream-processor.ts:279` | tempKey → realId (spawn 路径首次确认 sessions.id) | ❌ **不反转** |
| `stream-processor.ts:313` | fork detect (OLD → NEW,first realId !== resumeId) | ✅ **反转** |
| `recoverer.ts:466` | jsonl-missing fallback (OLD → NEW) | ✅ **反转** |
| `restart-controller.ts:189` | restartWithPermissionMode 内 fork detect (OLD → NEW) | ✅ **反转** |
| `restart-controller.ts:341` | restartWithClaudeCodeSandbox 内 fork detect (OLD → NEW) | ✅ **反转** |

合计 **claude 4 处反向 rename**(spawn 主路径 stream-processor:279 不反转,与 plan §D2 一致)。

### 实测 2.3: codex renameSdkSession 全部调用点

grep 命中 4 处,但 codex restart-controller.ts:134 / 136 仅是**注释 ref**(REVIEW_40 R2 reviewer-codex P3 LOW 已删 post-rename 防御 block)。实际真实调用 3 处:

| file:line | 类型 | 是否反转 (D2) |
|---|---|---|
| `thread-loop.ts:154` | tempKey → realId (spawn 路径首次确认,与 claude stream-processor:279 对称) | ❌ **不反转** |
| `thread-loop.ts:263` | case 3 post-resume fork future-proof (OLD → NEW) | ✅ **反转** |
| `recoverer.ts:339` | jsonl-missing fallback (OLD → NEW) | ✅ **反转** |
| ~~`restart-controller.ts:134`~~ | ~~已删 post-rename block,不需修改~~ | (废弃) |

合计 **codex 2 处反向 rename**(plan §D2 列了 codex restart-controller 但 grep 实证已无真调用,**plan 需修正**)。

### 实测 2.4: hook event 携带 sid 来源

`translate.ts:31` (translateSessionStart): `sessionId: p.session_id` 来自 hook payload `body.session_id`。
hook curl 命令在 `hook-installer.ts:62` 设的 hook script 由 CLI 子进程执行 — body.session_id 是 **CLI 当前 thread 的 sid**。

**fork 后 hook event 携带 sid**:
- spawn 时 CLI 用 SDK 给的 resume sid 起 thread → CLI 内部 fork → 切到 NEW thread → 之后所有 hook curl body.session_id = NEW_ID
- 应用层 ingest 入口收到 hook event sessionId=NEW_ID,**但 sessions.id (反转后) 仍是 OLD_ID** → ingest 会 ensureRecord(NEW_ID) 创建新行 = bug!
- **D7 修法**: ingest 入口先 `sessionRepo.findByCliSessionId(eventSid)` 反查 sessions.id → 找到 → 走正常路径(sessions.id 不变);找不到 → 进迟到 event 黑名单分支(spike4 详)

### 实测 2.5: codex 不支持隐式 fork

注释铁证:
- `recoverer.ts:34`: "codex 不支持 implicit fork:spike-A2 实测 codex CLI resume 永远返回同 thread_id"
- `thread-loop.ts:250`: "case 3: 恢复路径但 SDK 返回不同 id(罕见 + future-proof)"
- `restart-controller.ts:97`: "codex resume 不会隐式 fork,理论上等于入参 sid,但接口签名与 claude 对齐保留 string 返回"

**结论**: codex thread-loop:263 case 3 是 future-proof 防御代码,实际 SDK 0.131.0 不会触发。但反向 rename 修法仍要覆盖此处(防 SDK 升级 / 行为变更)。

### 实测 2.6: 已有 fork test 覆盖

`__tests__/sdk-bridge.consume-fork.test.ts`:
- L56: `it('first realId ≠ opts.resume → 调 sessionManager.renameSdkSession(OLD_ID, NEW_ID) + release OLD claim')`
- L103: `it('first realId === opts.resume → 不触发 fork 分支(不调 renameSdkSession)')`

**反向 rename 修法时这两个 test 必改**: assertion 从「sessions.id 切到 NEW_ID」改为「sessions.id 不变 + cli_session_id 列被 update 为 NEW_ID」。

## 结论

✅ **D2 假设大部分成立,1 处需修正**:

1. claude fork detect 触发条件 + 判定逻辑铁证清晰 (stream-processor.ts:305)
2. claude 4 处反向 rename 路径精准 (recoverer:466 / stream-processor:313 / restart-controller:189 / restart-controller:341)
3. codex **2 处** (而非 plan §D2 说的 3 处) 反向 rename 路径 (recoverer:339 / thread-loop:263) — codex restart-controller 已删 post-rename block 不需改
4. **总计 6 处** (claude 4 + codex 2) 而非 plan §D2 说的 7 处
5. fork 后 hook event sid = NEW_ID (CLI 当前 thread sid),迫使 D7 ingest 入口 findByCliSessionId 反查必须实装

**实施推论 (D2 修正)**:
- 修正 plan §D2 的 7 处 → 6 处:
  - `recoverer.ts:466` jsonl-missing fallback rename(claude)
  - `codex/recoverer.ts:339` jsonl-missing fallback rename(codex)
  - `stream-processor.ts:313` fork detect(claude)
  - `codex/thread-loop.ts:263` post-resume fork rename(codex)
  - `restart-controller.ts:189` restartWithPermissionMode fork rename(claude)
  - `restart-controller.ts:341` restartWithClaudeCodeSandbox fork rename(claude)
- spawn 主路径 (stream-processor:279 / thread-loop:154) **保持不变**(tempKey → realId 是 sessions.id 首次确认,不算反向 rename)

## 残留风险

- ⚠️ **codex SDK 升级可能改变 fork 行为**: 当前 spike-A2 实测 codex CLI resume 永远返回同 thread_id,thread-loop:263 case 3 是 future-proof。codex SDK 升级后若开始 fork,反向 rename 修法已覆盖此场景。
- ⚠️ **stream-processor:279 的 tempKey rename 是 sessions.id 主路径,反向 rename 不能动**: 这是 SDK fallback bootstrap (CHANGELOG_28) 主路径核心机制(REVIEW_5 H4 / REVIEW_7 M3 一系列加固),重写风险大。tempKey 阶段 caller 还没拿到 sid,不算「sid 对外变化」。
- ⚠️ **fork detect 触发条件是 SDK 内部 black box**: 应用层只通过实测铁证(CHANGELOG_27)知道触发条件,SDK 文档承诺与实际不符。修法不能依赖 SDK 文档,必须保留 first realId !== resumeId 兜底判定。

## D2 验证标注 (回写 plan)

`*待 spike 验证*` → `*已 spike 2.1-2.6: claude 4 处 + codex 2 处反向 rename 路径精准列表;codex restart-controller 已无真 rename 调用应从 D2 移除*`
