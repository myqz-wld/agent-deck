# REVIEW_82 — 全项目 deep review 批 D4：codex-cli binary + 实例池 + adapter 入口 + oneshot runner（Batch D 收官）

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第十二批，Batch D 子批 D4，**Batch D 收官**）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_79-81（D1/D2/D3）/ REVIEW_69-70（codex translate/win32 基线）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 D pair dr-project-d-20260531）+ 三态裁决 + lead 现场验证（**installed app 实测 filesystem 取证** + codex SDK dist d.ts signal 支持核查 + claude oneshot parity）+ temp-revert 验证。
- 收口: R1 双 reviewer reply。**异构 divergence**（互补盲点）：reviewer-claude 0 HIGH/0 MED/1 LOW（实例池双构造良性）/ 3 INFO + **win32 PATH 逐行对照 SDK dist 确认无回归**；reviewer-codex 0 HIGH/2 MED（oneshot timeout 不取消子进程 + binary pnpm layout）。lead 对两条 divergent MED 各自现场验证 → **MED-1 ✅ 真问题修**（codex SDK signal 支持 + claude parity + stale comment）；**MED-2 ❌ 证伪**（installed app filesystem 实测 top-level layout 存在，resolver 在 prod 正确）。LOW 接受 by-design。typecheck 双配置 + codex-cli/session 197 passed（+2 回归 test，MED-1 temp-revert 验证非空）。

## 范围（批 D4）

codex-cli adapter 的「二进制路径解析 + 实例池 + adapter 入口 + oneshot runner」收官子模块，7 文件 ~653 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `sdk-bridge/codex-binary.ts` | 167 | resolveBundledCodexBinary（packaged unpacked 路径 + 双布局 + win32）+ prependBundledCodexPathDirs（bundled rg PATH 注入）|
| `codex-instance-pool.ts` | 71 | oneshot caller 共享全局 Codex 实例池 + invalidateCodexInstance |
| `index.ts` | 205 | CodexCliAdapter（capabilities + createSession/sendMessage/restart 委托 bridge + setSessionRenameHookFn 桥点）|
| `handoff-runner.ts` | 87 | codex hand-off oneshot runner（thin delegate → runCodexOneshot）|
| `summarizer-runner.ts` | 77 | codex 间歇总结 oneshot runner（同上）|
| `sdk-loader.ts` | 25 | loadCodexSdk 动态 import（单例 promise）|
| `codex-config-paths.ts` | 21 | codex agent-deck plugin 路径常量 |

> **连带修改**（出 D4 scope，reviewer-codex 经 runner 链路触达）：`src/main/session/oneshot-llm/codex-runner.ts` + `race-with-timeout.ts`（MED-1 修法落点；D4 runner 直接依赖，clean contained fix，不延后到 Batch E）。

## 三态裁决结果

### [MED ✅ reviewer-codex 单方 + lead 验证] oneshot-llm/codex-runner.ts:101 — codex oneshot timeout 后子进程不取消，周期 timeout 累积后台进程（cross-adapter parity 缺口）

reviewer-codex 单方提出（reviewer-claude 互补盲点未审 cancellation 角度）。D4 的 summarizer-runner / handoff-runner 都进 `runCodexOneshot`。该 helper 只对 promise 做 timeout race，`thread.run` 不传 `signal`，`raceWithTimeout` 不给 onTimeout。timer 赢后 caller inFlight 槽释放，但底层 codex exec 子进程 / API turn 仍后台跑到自然结束 → 周期 summary timeout 连续发生时累积后台 codex 进程 + 请求。

```ts
// 修前
const work = (async () => {
  const codex = await getCodexInstance();
  const thread = codex.startThread({ ... });
  return thread.run(opts.prompt);  // ← 不传 signal
})();
const result = await raceWithTimeout({ work, timeoutMs, errorMessage });  // ← 无 onTimeout
```

**lead 验证**：
1. codex SDK `TurnOptions.signal: AbortSignal`（index.d.ts:171）+ `thread.run(input, turnOptions?)`（index.d.ts:209）支持取消，dist 内 `spawn(..., {signal})` 已接到 child_process ✅
2. claude `runClaudeOneshot` timeout 时调 `q.interrupt()`（claude-runner.ts:88-89）取消子进程 → **codex 是 parity 缺口** ✅
3. 现有注释（codex-runner.ts:30-31 + 77-78）**误称**「codex SDK 没 q.interrupt() 等价物」= 事实陈旧错误（`TurnOptions.signal` 就是等价物）→ 把「accepted by-design」错钉成「无法修」✅
4. **temp-revert 复现**：移除 signal + onTimeout → 2 test FAIL（success-path thread.run 收到 undefined / timeout-path signal 未 abort）✅

**严重度 MED**：触发是周期 summary（用户开 summarize + codex provider + 频繁 timeout）累积后台进程，资源泄漏非数据损坏；但确定可复现 + 有现成修法（SDK 已支持 signal）+ claude 已有取消 → 真问题修。

**修法**：`runCodexOneshot` 内 `const controller = new AbortController()` + `thread.run(opts.prompt, { signal: controller.signal })` + `raceWithTimeout({ ..., onTimeout: () => controller.abort() })`，对齐 claude 取消语义。同步修 3 处 stale 注释（codex-runner.ts 文件头 + inline + race-with-timeout.ts ×2）。

### [MED ❌ reviewer-codex 单方 — lead installed-app filesystem 实测证伪] codex-binary.ts:68 — packaged binary resolver 硬编码 top-level native package 路径「不匹配 pnpm 布局」

reviewer-codex 单方提出：packaged resolver 拼 `app.asar.unpacked/node_modules/@openai/<pkgDir>/vendor/<triple>`，但 dev pnpm 树里 `node_modules/@openai/codex-darwin-arm64` 不存在（实际在 `.pnpm/@openai+codex@0.135.0-darwin-arm64/...`）→ 声称 resolver 在 prod 返 null 撞 ENOTDIR。

**lead 现场证伪（installed app filesystem 实测铁证）**：
1. reviewer-codex 验证的是 **dev pnpm 布局**（`test -e node_modules/@openai/codex-darwin-arm64` → 不存在 ✅ 确实），但 resolver 是 **`app.isPackaged` gated**（dev 直接 return null line 65）→ 验错环境
2. **实测 installed app**：`ls /Applications/Agent Deck.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/` → **`codex-darwin-arm64/` 存在**（electron-builder 打包时把 pnpm symlink 扁平化成 top-level，asarUnpack pattern package.json:124 `node_modules/@openai/codex-darwin-*/**` 驱动）
3. **完整 resolver vendor 路径实测全中**：`app.asar.unpacked/.../codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`（197MB 二进制）✅ + `codex-package.json`（isNewLayout 双条件）✅ + `codex-path/rg`（4MB ripgrep）✅
4. **活证据**：这正是本 review session reviewer-codex 自己跑的 codex 二进制 — resolver 在 prod 工作正常

**裁决 ❌ 不修**：dev pnpm aliasing 与 packaged layout 本就不同（resolver 的 `app.isPackaged` gate 正是为此），reviewer-codex 把 dev 布局误推到 packaged。installed app filesystem 直接证伪。修复方向（改走 createRequire 链）属过度工程 + 引入 dev/prod 路径耦合风险，不采纳。

### [LOW ❓ reviewer-claude — 接受 by-design] codex-instance-pool.ts:51 — getCodexInstance 无单飞，summarizer 并发首轮冷启双构造 Codex 实例（良性）

reviewer-claude 提出（lead 倾向接受 by-design）。`getCodexInstance` 是 cache miss → `await loadCodexSdk()` → `new sdk.Codex()` → 写 cache；两并发 caller cache 空时都 miss → 都 `await` 让出 → 都 `new` → 后者覆盖前者 cache。summarizer maxConcurrent 默认 2 → 首轮 2 条并发真实存在。

**lead 裁决 ❓ 接受 by-design**：Codex 实例是 lightweight handle（注释自述「真正 spawn 子进程是 startThread() 时才发生」），双构造仅多 new 一个轻量对象前一个被 GC，**无子进程泄漏 / 无 token / 无文件句柄**；两 caller 各自 startThread 独立 thread 互不干扰。属一次性冷启窗口微小浪费非正确性/资源问题。reviewer-claude 自评「接受现状亦可」+ lead 同意（ROI 低，注释已说明实例轻量）。对齐 claude promise-单飞范式属可选优化，不在 bug-fix scope，记 follow-up。

### [INFO ✅×3 reviewer-claude] 验证记录（无 action）

- **win32 PATH 复查（lead 重点）✅**：逐行对照 codex-sdk dist/index.js:472-489 `prependPathDirs`/`pathEnvKey` — `pathEnvKey` casing 选择 / win32 删其他 casing 变体 / dedup 全字面一致；binName win32=codex.exe + isNewLayout 用 spec.binName（REVIEW_69+70 修法）有回归 test。**无回归**。
- **双轨实例缓存 ✅**：pool（oneshot 无 mcp）vs bridge codexBySession（live 需 mcp）刻意不合并，注释充分 + path 失效信号统一。
- **capabilities 一致性 ✅**：逐条核对 canRestartWithCodexSandbox / canRestartWithClaudeCodeSandbox / canSetPermissionMode / canAcceptAttachments 与实现无漂移。

### [INFO ❓ 未验证 reviewer-claude，不改] codex-instance-pool.ts:54 — path 改 + inflight 旧构造竞争理论窗口

reviewer-claude 自标 *未验证*。冷启首轮 + 恰好改 path + 两 caller 时序交错三重叠加极罕见；即便发生下次 getCodexInstance 的 `cachedPath === overridePath` 比较 detect mismatch 自愈。lead 裁不改（LOW promise-单飞若采纳顺带消除）。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | oneshot-llm/codex-runner.ts:87 + race-with-timeout.ts | MED ✅ | AbortController + thread.run({signal}) + onTimeout abort（对齐 claude）+ 3 处 stale 注释修 | reviewer-codex 单方 + lead（SDK signal 支持 + claude parity + 注释 stale）+ temp-revert 2 test |
| — | codex-binary.ts:68 | MED ❌ | 证伪不修（installed app filesystem 实测 top-level layout 存在）| lead installed-app `ls` 铁证 |
| — | codex-instance-pool.ts:51 | LOW ❓ | 接受 by-design（轻量 handle + 自愈）| reviewer-claude + lead |

## 验证

```
typecheck（双配置）：PASS
node_modules/.bin/vitest run src/main/adapters/codex-cli src/main/session：19 files / 197 passed + 1 skipped
MED-1 temp-revert：移除 signal + onTimeout → codex-model-passthrough 2 REVIEW_82 test FAIL
  （success-path thread.run 收 undefined signal / timeout-path signal 未 abort）→ 确定性复现
MED-2 证伪：ls /Applications/Agent Deck.app/.../app.asar.unpacked/node_modules/@openai/
  → codex-darwin-arm64/vendor/aarch64-apple-darwin/{bin/codex,codex-package.json,codex-path/rg} 全存在
```

## 结论

**Batch D 收官批**。codex-binary（win32 PATH 逐行对照 SDK dist 无回归，REVIEW_69+70 修法完好）+ 实例池双轨 + capabilities 一致性 + sdk-loader 单飞都扎实，0 HIGH。异构 divergence 体现互补盲点价值：reviewer-claude 专注 win32 忠实性/capabilities（全过），reviewer-codex 抓 cancellation + packaging。MED-1（oneshot timeout 不取消）是 cross-adapter parity 真缺口（SDK 已支持 signal + claude 已取消 + 注释 stale）→ 修；MED-2（binary pnpm layout）lead installed-app filesystem 实测**证伪**（resolver prod 正确，reviewer-codex 误推 dev 布局到 packaged）。LOW 实例池双构造良性接受 by-design。

**Batch D 全收官**：D1-D4 全 28 文件（codex adapter 全量）/ REVIEW_79-82 / **7 bug fix**（D1 1+测试 / D2 1 / D3 2 / D4 1 + D1 测试缺口）+ 10 INFO + 21 回归 test，系统覆盖 codex 会话创建 / thread-loop fork-detect / event translation / recovery 自愈 / binary 解析 / oneshot 全链路。MED-2 证伪是异构对抗价值的反面体现（单方 finding 经 lead 现场验证拦截误报）。

## Follow-up（留用户回来决策）

1. **[MED parity] claude restart-controller setClaudeCodeSandbox throw 窗口**（REVIEW_80 follow-up，仍 open）
2. **[INFO 未验证] translate.ts fatal error 后潜在双 finished**（REVIEW_80 follow-up，仍 open）
3. **[LOW 可选优化] codex-instance-pool promise-单飞范式对齐 claude loader**（REVIEW_82 — 消除冷启双构造 + path-race 理论窗口，ROI 低非 bug）

> Batch D ✅ 全收官。下一批 Batch E（session：manager/lifecycle-scheduler/summarizer + issue-lifecycle-scheduler）/ F（spawn/send/task + dispatch）/ G（store）/ H（renderer+文案）/ I（剩余可跳）。
