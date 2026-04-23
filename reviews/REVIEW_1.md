# REVIEW_1: main 进程关键模块全审（双对抗）

## 触发场景

用户在迭代了 46 个 changelog 后主动要求做一轮 review，识别潜在 BUG 与优化点。属于「触发性周期 review」，非例行。

## 方法

**双对抗配对**（CLAUDE.md「决策对抗」规范）：
- Claude（`Explore` general-purpose subagent，Opus 4.7 xhigh）
- Codex CLI（Bash 直接调，`model_reasoning_effort="xhigh"`，超时 600000 ms）

**范围**：main 进程 16 个关键文件，约 5000 行：

```
src/main/adapters/claude-code/{sdk-bridge.ts, sdk-runtime.ts, translate.ts}
src/main/adapters/codex-cli/{sdk-bridge.ts, translate.ts}
src/main/session/{summarizer.ts, manager.ts, lifecycle-scheduler.ts}
src/main/store/{event-repo.ts, session-repo.ts, settings-store.ts, db.ts}
src/main/{ipc.ts, window.ts, index.ts}
src/main/hook-server/server.ts
```

**约束**：双方都被告知 changelog 1-46 已修过的问题不要再列，并按严重度（HIGH/MED/LOW）+ 文件:行号 + 代码片段格式输出。

**裁决**：每条结论我手工现场核实代码后做三态判定。

## 三态裁决结果

### ✅ 真问题（双方独立提出 / 一方提出但现场核实成立）

| # | 严重度 | 文件:行号 | 问题 | Claude | Codex |
|---|---|---|---|---|---|
| 1 | HIGH | manager.ts:83-92 | `pendingSdkCwds.size===1` fuzzy 匹配会跨 cwd 误 claim 外部 CLI hook 会话 | ❌ 未提 | ✅ 独发 |
| 2 | HIGH | sdk-bridge.ts:147→415 | `releasePending` 只在成功路径调，失败时 60s ttl 内同 cwd 真实 hook 被误吞 | ❌ 未提 | ✅ 独发 |
| 3 | HIGH | ipc.ts:455-470 | `loadImageBlob` TOCTOU：白名单查 `reqPath`、读取走 `realpath`，symlink 越权读任意磁盘 | ❌ 未提 | ✅ 独发 |
| 4 | MED | sdk-bridge.ts:1033-1047 | `toolUseNames` Map 只在图片工具分支 `delete`，普通工具长会话线性泄漏 | ❌ 未提 | ✅ 独发 |
| 5 | MED | sdk-bridge.ts:837-868 | query loop catch 只 `console.warn`，UI 拿不到失败原因 | ❌ 未提 | ✅ 独发 |
| 6 | MED | ipc.ts:524-531 | `ImageRead` 路径白名单只扫最近 500 事件，长会话旧图永久读不出 | ⚠️ 部分（fileChange 无 limit） | ✅ 独发 |
| 7 | MED | index.ts:203-215 | `before-quit` async listener 不 promise-aware，await 形同摆设 | ❌ 未提 | ✅ 独发 |
| 8 | LOW | ipc.ts:35 | 打包后 `process.env.npm_package_version` undefined，永远显示 0.1.0 | ❌ 未提 | ✅ 独发 |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| Claude HIGH | sdk-bridge.ts:219/294/340 abort listener 无 cleanup | listener 内部都有 `if (cur)` 保护幂等；ctx.signal 是每个 tool call 的 short-lived AbortSignal，turn 结束随 ctx 一起 GC，不跨 turn 累积 |
| Claude HIGH | codex-bridge.ts:252 `turnLoopRunning` race | runTurnLoop 第 431 行有 `if (internal.turnLoopRunning) return` 双重防护，async function 同步段先跑到 `=true` 再让出 microtask |
| Claude HIGH | summarizer.ts:97 `inFlight` Set 释放 | Claude 自己结论里写「实际安全」，`finally(() => delete)` 是对的 |
| Claude HIGH | manager.ts:319 `pendingSdkCwds` 三重 delete | Claude 自己说「幂等」；行号也对不上（manager.ts:319 是 renameSdkSession） |
| Claude MED ×4 | summarizer 注释 / 双重 trim 检查 / event-repo SQL 拼接 / lifecycle 注释过时 | 全是 trivial，无实际危害 |
| Claude LOW ×4 | flash() 的 setOpacity 异常 / codex fallback abort 无日志 / deriveTitle 边界 / shell.openPath 长字符串 / token 硬编码 | 危害极小或被 catch 兜住，不值得修 |

### ⚠️ 部分（双方都看到现场但角度不同）

| 现场 | Claude 视角 | Codex 视角 | 结论 |
|---|---|---|---|
| ipc.ts loadImageBlob 路径检查 | fileChange 无 limit 全表扫 | TOCTOU symlink 越权 | 取 Codex 视角（更严重）合并到 #3 |

## 修复（CHANGELOG_16 落地）

### HIGH

1. **manager.ts:83-92** — 删除 `size===1` fuzzy 兜底，注释明确「cwd 别名靠 `normalizeCwd` 内 `realpathSync`，不要再回到全局 fuzzy」
2. **sdk-bridge.ts:147-419** — 整段 await 链包 try/catch，catch 里 `this.sessions.delete(tempKey) + releasePending()` 后 throw
3. **ipc.ts:455-497** — 先 `realpath`，用 canonical `real` + 原 `reqPath` 双白名单校验；ext / MIME 都基于 `real`

### MED

4. **sdk-bridge.ts:1027-1047** — `maybeEmitImageFileChanged` 顶部统一 `internal.toolUseNames.delete(toolUseId)`，无论是否图片工具
5. **sdk-bridge.ts:837-868** — catch 里补 `emit('message', { text, error: true })`，UI 时间线能看到失败原因
6. **event-repo.ts** + **ipc.ts:524-531** — 新增 `eventRepo.hasToolUseStartWithFilePath(sessionId, filePath)`（SQL `json_extract` + `EXISTS LIMIT 1`），ImageRead 兜底白名单不再被 500 限制
7. **index.ts:203-230** — `before-quit` 改 `event.preventDefault()` → 真异步清理 → `app.exit(0)`，顺手接 `closeDb()`；用 `cleaningUp` flag 防重入

### LOW

8. **ipc.ts:35** — `process.env.npm_package_version ?? '0.1.0'` → `app.getVersion()`

## 关联 changelog

- [CHANGELOG_16.md](../changelog/CHANGELOG_16.md)：本次 8 处修复 + 文档机制重构（reviews 引入 / 反馈升级加 agent-pitfall / 三份 CLAUDE.md 简化与对齐）

## Agent 踩坑沉淀

本次 review 提炼出 8 条 agent-pitfall 候选（见 `.claude/conventions-tally.md`「Agent 踩坑候选」section），P1 / P2 / P3 / P4 / P5 / P6 / P7 / P8 各 count=1。同主题再撞 2 次会触发升级到 CLAUDE.md 项目约定。

部分主题（资源清理 / TOCTOU / 异步 listener）已**预防性**写入 CLAUDE.md「资源清理 & TOCTOU 防线」小节，但 tally 计数不抵消，作为未来同类问题的辅助提示。
