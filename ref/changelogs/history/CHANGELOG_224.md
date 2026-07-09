# CHANGELOG_224 — 幻影 fork 自愈：runtime id 不再污染 cli_session_id

## 变更类型
行为修复（接 CHANGELOG_221/223 jsonl resume 这条线 —— 闭环 223 precheck 排查日志埋的两个假设，并修复上一版 read-side 自愈后的 source-side 回写；同时收紧 read-side 自愈，避免真实 fork 的旧 applicationSid jsonl 被误用）

## 背景（CHANGELOG_223 排查日志的结论）
CHANGELOG_223 在 `jsonl-fallback.ts` precheck 判定 jsonl 缺失、即将退 fresh-cli 时埋了一行 `warn`，
用来区分两个假设：**「fork 子 jsonl 不落盘」vs「连续快速重启时序竞态」**。本次实测复现后用文件 mtime
锁死 —— **是前者（幻影 fork），不是时序竞态**。

复现链（应用 sid = `c12a770d` 全程不变）：
1. 冷启动建会话，CLI 写 `c12a770d.jsonl`。
2. 改沙盒档（workspace-write→off）触发 `restartWithClaudeCodeSandbox` 冷重启，`--resume c12a770d`。
   CLI 续写 `c12a770d.jsonl`（新一轮 `parentUuid` 直接挂回原消息树，每条 `sessionId` 仍是 `c12a770d`）。
3. **但 CLI init 帧报了一个全新 `session_id=31246f77`**（≠ resume）→ stream-processor S6 fork-detect
   触发 → `updateCliSessionId(applicationSid, 31246f77)` 把 `cli_session_id` 列写成 `31246f77`。
4. 下一次用户发消息，SDK 子进程已退 → `recoverAndSend` → precheck 用 `rec.cliSessionId=31246f77`
   算 `31246f77.jsonl` → **MISS**（该文件从未落盘）→ 退 fresh-cli + DB 摘要注入，连续会话线断裂。

### 幻影 fork 的具体原因
在 `claude --resume <applicationSid> --input-format stream-json` + 新 prompt 下，CLI 的 **运行 id**
与 **落盘 id** 分属两层：
- **运行 / hook 层**：`system:init` 帧吐一个 CLI 现铸的全新 UUID（`31246f77`），hook/settings-env
  按它建 `~/.claude/session-env/31246f77/`（**空目录**，无 transcript）。
- **落盘 / transcript 层**：被 `--resume` 钉死在 `applicationSid` 名下的 jsonl，CLI 把新一轮**续接在
  原消息树上**（`parentUuid` 直接挂回上一轮 `uuid`），从不生成 `31246f77.jsonl`。

S6 fork-detect 只读了 init 帧那个运行 id 就推断「报了新 id ⇒ 它有自己的新 jsonl」，于是把
`cli_session_id` 列指向一个**从不落盘的幻影 id**。真历史 `applicationSid.jsonl` 一直在盘上，却因为
列被幻影 id 顶替而被绕过 —— 违反 CLAUDE.md「resume 优先」纲领（用户体感「像新开了个会话」）。

> CLAUDE.md「软 fork，jsonl 在」对偶 case 里「init id ≠ resume」这个观察没错（CHANGELOG_27/REVIEW_6
> 「实测铁证」），错的是「所以新 id 有自己的 jsonl」后半推断。本修法不信任何报告 id，只认盘上**实际
> 存在**的 jsonl，对真 fork（NEW.jsonl 在）与幻影 fork（NEW.jsonl 不在）两种情况都稳。

## 实现

### source-side 修复：stream-processor 不再持久化幻影运行 id
`stream-processor.ts` `consume` 首个 `session_id` 帧现在同时接收两个维度：
- `applicationResumeId`：应用稳定 sid，用于 events / UI / DB 主键。
- `effectiveResumeCliSid`：真正传给 Claude CLI `--resume` 的 sid，用于判断真实 CLI fork。

普通 resume 中如果 `effectiveResumeCliSid === applicationSid`，但 SDK init 帧吐了另一个 id，本次按**幻影运行 id**
处理：`internal.cliSessionId` 继续保持 `applicationSid`，不调用 `sessionManager.updateCliSessionId`，后续 recover/restart
仍会 `--resume <applicationSid>` 找到真实 jsonl。只有 `effectiveResumeCliSid` 与 `applicationSid` 已经分离、且首帧又变化时，
才按真 CLI sid fork 更新 `cli_session_id`。

### 重启竞态修复：旧 internal 不再删除新 internal
沙盒 / 权限冷重启时，旧 SDK stream 与新 SDK stream 会短暂并存同一个 application sid。旧逻辑在 `consume finally`、
create-session 失败清理、close-session 清理中直接 `sessions.delete(applicationSid)`，可能把刚放进去的新 `internal`
删掉，导致 UI 仍显示会话但 `sendMessage` 命中死链路 / 无响应。

本次把这些清理都改为 identity guard：
`if (sessions.get(key) === internal) sessions.delete(key)`。`createUserMessageStream` 同样用 identity 判断，
避免旧流继续吞新流的消息队列。

### read-side 兜底：precheck 自愈探测 + freshness gate
`jsonl-fallback.ts` `maybeJsonlFallback`：cli sid 维度的 jsonl 缺失时，退 fresh-cli **之前**回探
`applicationSid.jsonl`：
- 触发条件：① cli sid 维度缺失 ② 非 `cwdFellBack`（cwd 已切，原 jsonl 不在新 cwd 下，保持 fail-safe）
  ③ `cliSessionId` 非空且 ≠ `applicationSid`（相等时 primary 已覆盖，无幻影可言）。
- 命中 `applicationSid.jsonl` 在盘后，还必须满足 mtime freshness gate：`applicationSid.jsonl.mtime`
  不能明显早于 `SessionRecord.lastEventAt`（允许 2s 写盘 / DB 时间先后容差）。mtime 缺失或过旧时判定证据不足，
  保持 fresh-cli fallback，避免「真实 fork 的当前 cli jsonl 丢了，但旧 applicationSid.jsonl 仍在」时错误 resume 旧历史。
- 通过 freshness gate → `jsonlMissing=false` + 返回新字段 `healedCliSessionId = applicationSid`，落一行 `warn`
  （scope `claude-jsonl-fallback`，区别于既有「precheck MISS」行）。**不** emit / **不** createSession，让 caller 走正常 resume。
- 三个 caller 的正常 resume 路径把 `resumeCliSid` 改为 `fbResult.healedCliSessionId ?? rec.cliSessionId ?? <appSid>`：
  - `recoverer/recover-and-send-impl.ts`（断连自愈 recover 路径）
  - `restart-controller.ts` `restartWithPermissionMode`（权限冷重启）
  - `restart-controller.ts` `restartWithClaudeCodeSandbox`（沙盒冷重启）
  命中时 `--resume` 切到 `applicationSid` 找对 jsonl；未命中（`undefined`）沿用 `rec.cliSessionId` 原值，行为不变。

### 兼容边界
read-side 兜底仍保留：如果历史 DB 已被上一版写入幻影 `cli_session_id`，restart/recover precheck 会先探测
`applicationSid.jsonl` 并把本轮 `resumeCliSid` 切回 applicationSid。source-side 修复负责阻止后续 restart 再把列写坏。

## 验证
- `pnpm typecheck` 双配置通过。
- 新增单测 `jsonl-fallback.test.ts` Heal-1..5：命中自愈（`fellBack=false`+`healedCliSessionId===sessionId`+
  不起 fresh CLI+两次探测序+mtime freshness gate）/ applicationSid jsonl stale 不自愈 / mtime 探测失败不自愈 /
  两 jsonl 都缺退 fresh-cli / `cwdFellBack=true` 短路不探测 /
  `cliSessionId===sessionId` 不二探 / `cliSessionId=null` 不触发自愈（31 测全绿）。
- 新增/更新 `sdk-bridge.consume-fork.test.ts`：真 CLI sid fork 仍更新 `cli_session_id`；幻影运行 id 不更新 DB；
  旧 stream `finally` 不删除同 application sid 下的新 internal。
- 回归：`src/main/adapters/claude-code/sdk-bridge/__tests__` +
  `sdk-bridge.consume-fork.test.ts` + Claude `sdk-bridge.recovery.test.ts` 全绿（15 文件 / 146 测）。
