---
review_id: 10
reviewed_at: 2026-04-29
expired: false
---

# REVIEW_10: 打包验证暴露 main 进程 stdout EPIPE → uncaughtException 把 .app 整个挂掉

## 触发场景

用户请「打包 & 安装」，按 CLAUDE.md「打包与本地安装（macOS）」一条龙跑：pkill → `pnpm dist` → 覆盖到 `/Applications` → ad-hoc 重签 → 清 quarantine → 软链 wrapper。流程 0~5 步骤全部 OK。

最后一步「`agent-deck new --cwd ... --prompt ping` 验证 wrapper」拉起后立刻挂掉。用户贴出 stderr：

```
Uncaught Exception:
Error: write EPIPE
    at afterWriteDispatched (node:internal/stream_base_commons:161:15)
    at writeGeneric (node:internal/stream_base_commons:152:3)
    at Socket._writeGeneric (node:net:958:11)
    at Socket._write (node:net:970:8)
    at writeOrBuffer (node:internal/streams/writable:572:12)
    at _write (node:internal/streams/writable:501:10)
    at Writable.write (node:internal/streams/writable:510:10)
    at console.value (node:internal/console/constructor:303:16)
    at console.log (node:internal/console/constructor:378:26)
    at showOnce (/Applications/Agent Deck.app/Contents/Resources/app.asar/out/main/index.js:77:15)
```

属于「打包后才暴露的 product 防御性编码缺陷」——纯 bug 加固，按 CLAUDE.md 走 reviews/。

## 方法

**没走双异构对抗**：本次属 CLAUDE.md「决策对抗」节明确列出的「**例外** trivial 改动」（仅加 2 行 stdout/stderr 'error' listener，纯防御性，无业务语义变化、无回归面），按例外条款不强制双 Agent 对抗，直接现场修 + 真包验证。

**范围**：main 进程入口 + 全 main 目录 stdout/stderr / uncaughtException 防护现状

```text
src/main/index.ts            （加防护的位置）
src/main/window.ts           （触发 EPIPE 的 console.log 现场）
src/main/                    （全目录 grep uncaughtException / stdout.on）
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
src/main/index.ts
src/main/window.ts
```

**约束**：只解决「主进程 stdout/stderr EPIPE 把 app 整个挂掉」这一个 bug；不接管 uncaughtException 全局语义；不改 console.log 现有调用点（避免 noise）。

## 三态裁决结果

> 注：本次未做双 Agent 对抗（trivial 例外）。下表是单方诊断的现场核实结论。

### ✅ 真问题（现场核实成立）

| # | 严重度 | 文件:行号 | 问题 | 证据 |
|---|---|---|---|---|
| 1 | HIGH | src/main/window.ts:80-85 + grep src/main/ | `showOnce` 在 `ready-to-show` / `did-finish-load` / 1500ms fallback timeout 三个时机之一调 `console.log('[window] shown via ...')`。main 进程**没有任何** `process.on('uncaughtException')` / `process.stdout.on('error')` / `process.stderr.on('error')` 兜底（grep 全 src/main/ 只有 sound.ts:147 一处 `process.stdout.write('\x07')` 与本议题无关）。packaged 模式下 launchd 把 stdout 接到一段 pipe，对端早期关闭后写入即抛 EPIPE → 因为 stream 'error' 没 listener，Node 升级为 uncaughtException → main 进程整个 die，HookServer / Helper / SDK 全部跟着退 |

### ❌ 反驳 / 排除（诊断中曾误判，记录避免回踩）

| 误判项 | 现场反驳 |
|---|---|
| ASAR integrity hash 不匹配是杀手（Info.plist `e623b4...` vs 实际 `ad5889...`） | 是 electron-builder 25.1.8 的老问题（asarUnpack 后 hash 漂移），但与本 crash 无关——手工 PlistBuddy 改 hash 成实际值 + `codesign --remove-signature` + ad-hoc 重签后启动**仍然**立即 die，证明不是这条路径 |
| `ELECTRON_RUN_AS_NODE=1` 让 stub 走 Node 模式（看到 `Cannot find module .../new` + `bad option:` Node 错误格式） | 是**诊断时的环境污染**：Claude Code Bash 工具的子进程环境里有 `ELECTRON_RUN_AS_NODE=1`（用户 zsh 全局没设：`grep ELECTRON ~/.zshrc ~/.zprofile ~/.zshenv` 全空）。`env -i HOME=$HOME PATH=/usr/bin:/bin` 干净启动后该错误消失。**用户真实终端**里的 EPIPE 是另一个独立 bug，下面修的是这个 |
| ELECTRON_DISABLE_ASAR_INTEGRITY env 可关 fuse | Electron 33.4.11 已不读这个 env，禁用 ASAR integrity 必须用 `@electron/fuses` flip fuse；本议题不需要走这条 |

### ⚠️ 部分

无。

## 修复（review 内直接落地，无单独 changelog）

### HIGH
1. **src/main/index.ts:26-32**（新增 6 行，紧跟 imports / 早于所有逻辑）：

   ```ts
   // 防止 packaged GUI 模式下 stdout/stderr 管道被对端关闭时，console.log/error 抛出
   // EPIPE 升级为 uncaughtException 把 main 进程整个挂掉（实测：wrapper exec
   // Electron stub 启动后，window.ts showOnce 的 console.log 即触发 EPIPE，main 直接退）。
   // 仅吞 stdout/stderr 写错误，不接管其他 uncaughtException 语义。
   process.stdout.on('error', () => {});
   process.stderr.on('error', () => {});
   ```

   设计取舍：
   - **为什么不加 `process.on('uncaughtException')`**：会改变全局错误语义（其他真异常本来该 crash 的会被吞），副作用大。EPIPE 是流粒度的事件，加 stream 'error' listener 是**最小**面修复。
   - **为什么不删 / 不改现有 console.log 调用点**：grep `src/main/` 大量 console.log 都是诊断输出，逐个换 logger 是另一个工程问题；防护放在源头一次解决所有调用点的 EPIPE。
   - **副作用**：当 stdout/stderr 真的不通时，console 输出会丢——但本来就丢，只是不再 crash。这是合理代价。

### 验证

打包重装后干净环境（`env -i HOME=$HOME PATH=/usr/bin:/bin`）跑 wrapper：

```
[settings-env] applied 9 env vars from ~/.claude/settings.json (rejected 2 non-whitelisted)
[adapter] claude-code initialized
[adapter] codex-cli initialized
[adapter] aider initialized
[adapter] generic-pty initialized
[hook-server] listening on 127.0.0.1:47821
[session-mgr] expect sdk session @ /Users/apple/Repository/personal/agent-deck (ttl 60000ms)
[window] shown via did-finish-load
```

`ps aux | grep 'Agent Deck'` 显示 main + Helper(GPU/Plugin/Renderer) + SDK CLI 全部 alive。`pnpm typecheck` 通过。

## 关联 changelog

无。本次属纯防御性 listener 加固，CLAUDE.md「| Debug / 性能 / 安全 review（不引入新功能，只修问题或加固） | reviews/ |」二选一规则下不再建 CHANGELOG。修法 6 行已在本 review 内完整描述。

## Agent 踩坑沉淀

新增 1 条候选（`.claude/conventions-tally.md` Agent 踩坑 section）：

- **main 进程必须为 stdout / stderr 装 'error' listener，否则 packaged GUI 模式 launchd 接管 stdout 后 console.log 一次 EPIPE 直接挂掉整个 .app**。其他 Electron 项目改 main 入口时同类风险存在（任何 print 调用 + 没装 listener = 雷）。再撞 2 次（其他模块新加 console.log 翻车 / 类似 EPIPE 案例）触发升级到 CLAUDE.md「项目特定约定」节。
