---
review_id: 12
reviewed_at: 2026-04-29
expired: false
skipped_expired:
---

# REVIEW_12: approve-bypass 冷切后仍出孤儿「外」会话（REVIEW_9 1B 防护破洞）

## 触发场景

REVIEW_11 修完 4 条 bug 重打包后，用户实测 ExitPlanMode 选「批准并切到完全免询问」（approve-bypass 冷切走 restartWithPermissionMode → closeSession OLD CLI + spawn NEW CLI with bypass）执行完成后，UI 实时面板**仍**出现一条孤儿「外」会话（`source='cli'`，cwd 显示 `/Users/apple` home dir，**不是**用户原会话的真实 cwd）。

REVIEW_9 1B 修法（renameSdkSession 把 fromId 加进 recentlyDeleted 60s 黑名单 + ingest 入口 isRecentlyDeleted 丢弃）期望覆盖此场景，但用户实测仍复现 → 1B 防护有破洞。

## 方法

**双异构配对**：

| 任务 | Agent A | Agent B |
|---|---|---|
| Bug 5 根因 + 修法 | Opus 4.7 xhigh subagent (general-purpose, 实读 sdk-bridge / manager / hook-routes / hook-installer) | Codex CLI gpt-5.5 xhigh `read-only --skip-git-repo-check`，10 分钟超时，stdin 喂 prompt + `-o OUT` 抓最终答案，独立 prompt 防锚定 |

**范围**：

```text
src/main/session/manager.ts （ingest + dedupOrClaim + recentlyDeleted）
src/main/adapters/claude-code/sdk-bridge.ts （createSession env 注入 + closeSession + restartWithPermissionMode）
src/main/adapters/claude-code/hook-installer.ts （hook curl 命令模板）
src/main/adapters/claude-code/hook-routes.ts （hook event ingest 入口）
src/shared/types.ts （AgentEvent 类型）
```

**机器可读范围**（File-level Review Expiry）：

```review-scope
src/main/adapters/claude-code/hook-installer.ts
src/main/adapters/claude-code/hook-routes.ts
src/main/adapters/claude-code/sdk-bridge.ts
src/main/session/manager.ts
src/shared/types.ts
```

**约束**：实读真实代码 / 不依赖 SDK 错误字符串匹配（CLAUDE.md P12）/ 不接管全局 uncaughtException / 不能为「最小修法」绕过协议正确性 / 不能误伤同 cwd 真独立 CLI 会话（用户在另一终端跑 `claude` 同目录场景）

## 三态裁决结果

### ✅ 真问题（Bug 5）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| 5.1 | HIGH | `src/main/adapters/claude-code/sdk-bridge.ts:1185-1191` (closeSession) | closeSession **不**把 sessionId 加进 recentlyDeleted 黑名单 —— 与 SessionManager.delete (manager.ts:396) 和 renameSdkSession (manager.ts:424) 不对称。restartWithPermissionMode 路径下若 CLI 不 fork（`newRealId === OLD_ID`，sdk-bridge.ts:1288 的 if 不进），rename 不触发 → OLD_ID 永远没人加黑名单。OLD CLI 飞 SessionEnd hook 带 OLD_ID 时三道防线全失效。 | ✅ | ✅ |
| 5.2 | HIGH | `src/main/session/manager.ts:483-486` (extractCwd) + 协议设计层 | OLD CLI 在被 SIGTERM + EOF cleanup race 期间内部已 fork 出新 sessionId Y，飞回的迟到 hook event 携带 sessionId=Y（不在 recentlyDeleted）+ cwd=`/Users/apple`（hook server / CLI 子进程兜底到 HOME 而不是真实 cwd）。`recentlyDeleted` 只挡精确 sessionId，`consumePendingSdkClaim(cwd)` 又只信 hook payload 的 cwd —— hook 带新 ID Y + home dir，**两层兜底全失效** → ensureRecord 创建 source='cli' 孤儿。证据：用户截图「外」会话 cwd 显示 `/Users/apple` 而非真实工作目录。 | ✅ | ✅ |

### ❌ 反驳

| 报项方 | 报项 | 反驳依据 |
|---|---|---|
| 假说 B（NEW SDK SessionStart 先到） | NEW SDK 子进程的 SessionStart hook 在 SDK init message 之前到 | sdk-bridge.ts:195 expectSdkSession + line 207 claimAsSdk(opts.resume) 双保险已覆盖；NEW SDK 的 hook 带真实 cwd 必命中 pendingSdkCwds。验证：用户截图「外」会话 cwd=`/Users/apple` 不是 NEW SDK 的真实 cwd，所以「外」record 不可能是 NEW SDK 提前飞的 SessionStart |
| 假说 E（TTL 60s 不够） | recentlyDeleted 60s 在某些慢启动场景下不够 | 60s 远超任何 CLI cleanup 延时，事件根本没命中黑名单，主因是 sessionId 不匹配而非 TTL 过期 |
| 假说 F（hook 路径绕过 ingest） | hook event 通道有完全独立的 ingest 路径 | hook-routes.ts:49-51 taggedEmit 调注入的 emit 最终走 sessionManager.ingest，无独立路径 |

### ⚠️ 部分

| 现场 | A 视角（Opus）| B 视角（Codex） | 结论 |
|---|---|---|---|
| 修法层 1（closeSession 加黑名单） | ✅ 主修（必修） | ❌ 不主修，认为只能挡 OLD_ID 这一种 sessionId 形态，覆盖不全（漏 fork 出的 Y） | 部分一致：作为**双保险**采纳，不作主修 |
| 修法层 2（cwd-window 5s 短窗兜底） | ✅ recentlyClosedCwds 5s | ❌ 反对（即便短窗也会误伤同 cwd 外部 CLI） | Codex 角度更稳：**不采纳**层 2 |
| 修法（origin tag 协议从源头标记） | 未提（采用 cwd-window） | ✅ 主修：env AGENT_DECK_ORIGIN=sdk + curl 转发 X-Agent-Deck-Origin header + ingest 看 origin=sdk skip | **采纳 Codex origin tag 为主修**（不依赖 sessionId/cwd，零误伤外部 CLI） |

**最终方案**：主修 Codex 的 origin tag（覆盖根因 5.1 + 5.2），双保险 Opus 的 closeSession 加黑名单（覆盖 origin tag 升级前老 hook 命令路径残留 + sessionId 形态恰好匹配的边界场景）。

## 修复（review 内直接落地，不新建 changelog）

### HIGH

1. **`src/shared/types.ts:33-46` (AgentEvent 加 hookOrigin 字段)** — `hookOrigin?: 'sdk' | 'cli'`，仅 hook 通道事件携带，标记该 CLI 子进程是本应用 SDK 派生 ('sdk') 还是完全独立的 CLI 进程 ('cli')。注释明确 'undefined' 按 'cli' 兼容（升级前 settings.json 残留老 hook 命令路径）。

2. **`src/main/adapters/claude-code/sdk-bridge.ts:510` (env 注入)** — query options 的 `env` 从 `runtime.env` 改为 `{ ...runtime.env, AGENT_DECK_ORIGIN: 'sdk' }`，CLI 子进程继承后能在 hook curl 命令里被 `${AGENT_DECK_ORIGIN:-cli}` 展开。

3. **`src/main/adapters/claude-code/hook-installer.ts:43-58` (curl header)** — buildCommand 的 curl 命令加 `-H "X-Agent-Deck-Origin: \${AGENT_DECK_ORIGIN:-cli}"`（双引号外层让 shell 展开 env，其它 header 仍单引号——token / Content-Type 是模板字符串写入时的字面量，不需要 shell 展开）。⚠️ 用户已安装的旧 hook 会在下次 hook 重新安装时被覆盖（HookInstaller.install 会清掉所有带 `# agent-deck-hook` 标记的旧条目重写）。

4. **`src/main/adapters/claude-code/hook-routes.ts:17-58` (读 header + 传给 emit)** — makeRoute 内读 `request.headers['x-agent-deck-origin']`，把 `'sdk'` / `'cli'`（默认）传给 emit 回调；buildHookRoutes 的 taggedEmit 把 hookOrigin 塞进 emit event。

5. **`src/main/session/manager.ts:227-235` (ingest 第三道兜底 C)** — dedupOrClaim 在兜底 A/B 之后加：`if (event.source === 'hook' && event.hookOrigin === 'sdk') return { skip: true }`。语义：走到这里说明 sdkOwned / pendingSdkCwds / record 三层都没认出，但 hookOrigin='sdk' 已从源头标记此进程是 SDK 派生 → 这条 event 一定是 SDK-derived 进程的孤儿副产品（典型 OLD CLI fork 后飞回的迟到 hook），直接 skip 不创建 source='cli' record。用户独立终端跑 `claude` 没有 env → header 走默认 'cli' → 不走本分支，零误伤。

6. **`src/main/session/manager.ts:230-242` (markRecentlyDeleted 公共方法) + `src/main/adapters/claude-code/sdk-bridge.ts:1193-1200` (closeSession 调用)** — manager 暴露 `markRecentlyDeleted(sessionId)` 公共方法（仅 set Map），closeSession 内部 release sdkOwned 之后立即调，把 sessionId + realSessionId 都加进 60s 黑名单。**双保险**用：origin tag 升级前的老 hook 命令路径（hookOrigin === undefined → 按 'cli' 兼容 → 不走兜底 C）下，sessionId 黑名单仍能挡住「OLD CLI 不 fork 飞 OLD_ID 迟到 hook」窗口。

## 关联 changelog

无（本轮全部在 reviews/ 内直接落地）。Bug 5 修法引入了 hook 协议层的 X-Agent-Deck-Origin header 与 AGENT_DECK_ORIGIN env 约定，但属于「应用内部协议加固」，对用户可见行为只是「approve-bypass 冷切不再出现孤儿外会话」（bug fix），不算新功能；README 的「Adapter 架构」/「关键端口」节无需新增。

## Agent 踩坑沉淀

本次 review 提炼出 1 条 agent-pitfall 候选：

- **「同源黑名单只挡精确 ID」陷阱** — sessionId 黑名单 / cwd claim 这类「按值匹配」的兜底机制，对「上游进程内部 fork 出新 ID」/「上游 fallback 到不同 cwd 兜底值」的迟到事件天然失效。CLI 子进程被 SIGTERM 后内部 cleanup 路径可能生成新 sessionId、可能用 HOME 兜底 cwd（实测 approve-bypass 冷切场景两者同时发生）。预防：跨进程边界的去重 / 隔离机制不能完全依赖「上游推上来的值」（sessionId / cwd / pid 都可能错乱），应在**应用 spawn 子进程时主动注入身份标记**（env / args / ipc handshake），下游事件靠该标记识别归属，不依赖业务字段。典型实现：env 注入 → hook 命令转发为 HTTP header → ingest 入口按 header skip。

写入 `.claude/conventions-tally.md`「Agent 踩坑候选」section。同主题再撞 2 次会触发升级到 CLAUDE.md「项目特定约定」节。
