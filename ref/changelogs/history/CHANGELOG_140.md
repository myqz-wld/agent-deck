# CHANGELOG_140 — codex 流级错误三态识别(Reconnecting 中间态修复)

## 概要

修 codex CLI 把内置 5 次自动重连的中间态通过 `ThreadErrorEvent` 透传给应用层,应用层 `translate.ts` case 'error' 误把它当 `finished:error` 收尾让 UI 状态机错乱(用户看到「⚠ Codex 流级错误：Reconnecting... 1/5 (stream disconnected before completion: ...peak load...)」红字 + 状态条熄灭,但 codex 实际还在重连工作 → 重连成功后继续吐 message)。**协议契约 vs 实际行为不一致**(SDK d.ts 注释说 ThreadErrorEvent 是 `unrecoverable error`,codex CLI 实际用它通知 recoverable 中间态)→ 应用层必须分流。

设计上**白名单 + 启发式双层 + fatal 优先**,UI 上**显示重连进度不带 error 红字**(让 turn 不结束等待重连成功后的 turn.completed 收尾)。轻 plan 直接 main 分支改 + 单次异构对抗 review(reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5)。

详 [`plans/codex-stream-error-classify-20260521.md`](../../plans/history/codex-stream-error-classify-20260521.md)。

## 修法

### `src/main/adapters/codex-cli/translate.ts`(主修)

**抽 2 helper + 改 case 'error' 三态分支**:
- `classifyStreamErrorEvent(message): 'transient' | 'fatal'` — 决策树「fatal 优先 → transient 白名单 → 启发式兜底 → 保守 fatal」
- `extractRetryProgress(message): string` — best-effort 提取 N/M 进度数字

**transient 白名单**(6 条 codex CLI binary `strings` 抓出来的真字面):`Reconnecting...` / `stream disconnected before completion` / `stream disconnected - retrying sampling request` / `reconnecting:` / `app-server event stream disconnected` / `TCP Connection with remote is closed, trying to reconnect`。

**fatal 白名单**(扩到 12 条 codex binary 真 fatal 字面):`max retry times reached` / `exceeded retry limit` / `Error retrieving` / `could not retrieve` / `Could not retrieve` / `failed to retrieve` / `Failed to retrieve` / `exec-server connection disconnected` / `exec-server transport disconnected` / `disconnecting slow connection` / `dropping message for disconnected` / `Convert it to UTF-8` / `Fix the config` / `Too many retransmissions`。

**启发式 regex 改 word-boundary**:`\b(retry|retrying|retried|reconnect|reconnecting|reconnected|disconnect|disconnected|disconnecting)\b/i`(替代旧 `(retr|reconnect|disconnect)/i` 词根级匹配,防 retrieving / retransmit / retrograde 误命中)。**fatal regex 加 `exceeded\s+retr` + `maximum\s+retr`** 兜底(替代旧 `(max\s+retr|exhaust|gave\s+up)/i` 漏抓 codex `exceeded retry limit, last status:` 真终态)。

**extractRetryProgress 加上下文锚点**:`/(?:Reconnecting\.\.\.|attempt|retry)\s+(\d+)\s*\/\s*(\d+)/i`(替代旧无锚点 `(\d+)\s*\/\s*(\d+)`,防误抓日期 `2026/05` / HTTP `503/502` / 路径 `123/456` / IP 子网 `192.168.1.0/24`)。

**case 'error' 三态分流**:
- transient → emit message 不带 error: true(`🔄 Codex 正在重连... 重连尝试 1/5`),不 emit finished
- fatal → emit message error + finished(ok:false, error)(原行为)

**启发式命中加 `console.warn`** 留诊断信号(plan §D1 + REVIEW MED-1 修法):未来 codex 升级换字面进入启发式时主进程日志可见,方便后续补白名单。

### `src/main/adapters/codex-cli/__tests__/translate.test.ts` 

新增 11 case(从 30 → 36 个测试),三组覆盖:

**transient 白名单/启发式**(C1-C4 + C13):
- C1 bare `Reconnecting... ` → 1 message no error,no finished
- C2 含 `1/5` 进度 → 提取入 label
- C3 `stream disconnected - retrying sampling request` 白名单
- C4 启发式兜底 `Some random retry attempt notice...` + **必须 console.warn 触发**(MED-1 落地验证)
- C13 日期前缀不误抓:`[2026/05/21] Reconnecting... 1/5 (...)` → 提取 1/5 不是 2026/05(HIGH-3 regression)

**fatal 真终态**(C6 + C7 + C8-C12):
- C6 `stream disconnected ... max retry times reached` 双词共现 → fatal 优先
- C7 `connection lost - falling back...` 启发式不命中 → 保守 fatal + 不撞 console.warn(防 regression)
- C8 `Unexpected error retrieving API key:` → fatal(凭证错,HIGH-1 regression)
- C9 `exec-server connection disconnected: pipe broken` → fatal(IPC 错,HIGH-1 regression)
- C10 `exceeded retry limit, last status: 503` → fatal(终态字面,HIGH-2 regression)
- C11 `failed to retrieve local addr from established conn` → fatal(网络错,HIGH-1 regression)
- C12 `Convert it to UTF-8 and retry.` → fatal(配置错,HIGH-1 regression)

## review

bash 单轮异构对抗(`~/.claude/templates/reviewer-{claude,codex}.sh.tmpl`)双 Bash 并发起,reviewer-claude 出 HIGH×3 / MED×4 / LOW×1,reviewer-codex 出 HIGH×1 / MED×1 / LOW×1。三态裁决:

- ✅ HIGH-1 启发式 `retr` 词根太宽吞真错 — **双方独立** + 双方 grep codex binary 实证 ≥ 13 条字面
- ✅ HIGH-2 `exceeded retry limit` 漏抓 — claude 单方但 grep + 决策树推演完整
- ✅ HIGH-3 extractRetryProgress 误抓日期 — claude HIGH(UX)+ codex LOW,事实一致取高严重度
- ✅ MED-1 启发式 console.warn 漏落 — codex 单方,plan §D1 自己写了实现漏了
- ✅ MED-2/MED-3 测试缺真 fatal regression / 日期边角 — claude 单方,HIGH 修后必须有 case 锁
- ❓ MED-1-claude turn stuck *未验证* — claude 单方推理,无现场实证(进 plan §已知踩坑 backlog,留 watchdog tile)
- ❓ MED-4 D1 注释「拼接报文」无实证 — 软改,注释保守措辞
- ⏸ LOW-1 `Reconnecting...` trailing 空格 — `includes` 子串行为已正确,不修

## verify

`pnpm typecheck` GREEN / `pnpm exec vitest run translate.test.ts` 36/36 pass / 0 fail。
