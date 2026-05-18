# Spike 2 Report: codex SDK 子进程模型 + env snapshot 时机

**Date**: 2026-05-18
**Status**: ✅ Complete
**Drives**: HIGH-B (P2 codex 端 per-session token 注入路径)
**codex-sdk version**: 0.120.0

## 问题

应用层要在 P2 实施 `caller_session_id` per-session token 透传给 codex 子进程的 MCP 调用,需要回答两个关键问题:

1. **codex SDK `Codex.startThread()` 起的 thread 在子进程层面是什么模型?**(独立子进程? in-process? 共享子进程?)
2. **环境变量 snapshot 时机是什么?**(constructor frozen? 每次 spawn 时取 process.env 当下快照?)

这决定了 HIGH-B 修法:
- 如果 env constructor frozen → 必须 per-session 新建 Codex 实例,constructor 时传含 `AGENT_DECK_MCP_TOKEN=<sessionToken>` 的 env
- 如果 env 每次 spawn 时取 process.env → 可以全局单 Codex 实例,临时 mutate process.env 后立即 startThread(但并发场景下 race-unsafe)
- 如果 thread 共享子进程 → token 切换无解,必须改 codex SDK 上游

## 验证手段

1. **源码静态分析**:读 `/Users/apple/Repository/personal/agent-deck/node_modules/.pnpm/@openai+codex-sdk@0.120.0/node_modules/@openai/codex-sdk/dist/index.js` 全文(467 行)看 `Codex` / `Thread` / `CodexExec` 三个 class 关系 + `spawn` 调用点
2. **端到端实测**:写 `spike2-runner.mjs`(本目录),用 file:// 绝对路径 import codex-sdk,跑 3 个 sub-test:
   - Test 1: envOverride frozen(2 个 Codex 各 env,new 后 mutate process.env 看是否污染)
   - Test 2: process.env fallback(不传 env,startThread 在 mutate 前,run 在 mutate 后,看子进程拿到啥)
   - Test 3: subprocess PID independent(并发 2 个 thread,各让 codex 跑 `echo $$` 拿子 shell pid)

## 结论

✅ **codex SDK 0.120.0 子进程模型清晰,HIGH-B 修法路径已定**:**P2 必须 per-session 新建 Codex 实例**(constructor 时显式传 env 含 sessionToken),不能用 process.env mutation 路径(并发 race-unsafe)。

### 1. 子进程模型(line 238-241)

```js
// dist/index.js line 162-291: CodexExec.run() async generator
const child = spawn(this.executablePath, commandArgs, {
  env,
  signal: args.signal
});
```

**每次 `Thread.runStreamed()` / `Thread.run()` 都新 `spawn` 一个 codex CLI 子进程**(oneshot,通过 stdin write input + stdout iterate JSONL events + exit code 判定结束)。

`Codex` / `Thread` JS 类只是 thin wrapper,**不持有 long-lived 子进程**:
- `Codex` 持有 `CodexExec`(只是配置容器,初始化时拿 executablePath / env / configOverrides)
- `Thread` 持有 `_exec` (= Codex.exec) 引用 + `_threadOptions` + `_id`(thread id 由 codex CLI 在 spawn 后返回)
- `startThread()` 仅 `return new Thread(this.exec, this.options, options)`,**不 spawn**
- `runStreamed()` 调 `runStreamedInternal()` (async generator),**第一次** `for await` driven 时才走 `_exec.run()` 真正 spawn 子进程

### 2. envOverride 优先级 + frozen 时机(line 222-234)

```js
// dist/index.js line 222-234: CodexExec.run() 内 env assemble
const env = {};
if (this.envOverride) {
  Object.assign(env, this.envOverride);   // ← envOverride 优先
} else {
  for (const [key, value] of Object.entries(process.env)) {  // ← fallback process.env
    if (value !== void 0) {
      env[key] = value;
    }
  }
}
if (!env[INTERNAL_ORIGINATOR_ENV]) {
  env[INTERNAL_ORIGINATOR_ENV] = TYPESCRIPT_SDK_ORIGINATOR;
}
if (args.apiKey) {
  env.CODEX_API_KEY = args.apiKey;  // ← per-turn apiKey override(turnOptions 级)
}
```

```js
// dist/index.js line 153-161: CodexExec constructor 时 frozen
constructor(executablePath = null, env, configOverrides) {
  this.executablePath = executablePath || findCodexPath();
  this.envOverride = env;          // ← env 引用直接挂在实例字段
  this.configOverrides = configOverrides;
}
```

- **envOverride 在 `new Codex({env})` 时 frozen** 到 `CodexExec.envOverride`(对象引用挂字段)
- 所有后续 `runStreamed` 优先用 `envOverride` 喂给 `child_process.spawn`
- **不传 env** → fallback 同步 snapshot `process.env`(`Object.entries(process.env)` 在 `_exec.run` async generator 第一次 driven 时同步执行)

### 3. 实测铁证(3/3 PASS)

```
========== TEST 1: envOverride frozen ==========
codex1.finalResponse: "SPIKE_LABEL=tagA"        ← envOverride 注入 tagA
codex2.finalResponse: "SPIKE_LABEL=tagB"        ← envOverride 注入 tagB
process.env.SPIKE_LABEL = tagINTERFERER (在 2 个 Codex new 之后改的 — 没污染)
断言:codex1=tagA → PASS | codex2=tagB → PASS

========== TEST 2: process.env fallback ==========
startThread 时 process.env.SPIKE_LABEL = tagC
mutate 后 process.env.SPIKE_LABEL = tagD
codex3.finalResponse: "SPIKE_LABEL=tagD"        ← 子进程拿到 tagD
断言:codex3=tagD → PASS  (证明 spawn 子进程发生在 run() 内,而非 startThread() 时)

========== TEST 3: subprocess PID independence ==========
codex4.finalResponse: "MY_SHELL_PID=36210"
codex5.finalResponse: "MY_SHELL_PID=36209"
断言:两个 codex 子进程 PID 各异 → PASS  (并发 2 个 thread 各起独立 codex CLI 子进程)
```

Test 1 排除了「envOverride 字段被改」的可能性:虽然 `envOverride` 引用挂在 `CodexExec` 实例,但应用层不应再 mutate 已传入的 env 对象(JS 引用语义,mutate 会影响后续 spawn)。**实测在 `new Codex({env})` 之后改 `process.env` 不污染**已经 frozen 的 envOverride,因为 codex SDK 走的是 `Object.assign(env, this.envOverride)` 把 envOverride **拷贝**到子进程 env(不是同对象引用)。

Test 2 排除了「startThread 时就 spawn 子进程」的可能性:`startThread()` 同步返回,中间无任何子进程动作;真正 `spawn` 在 `run()` 内 async generator 第一次 driven 时同步执行。

Test 3 排除了「Codex 单例共享子进程」的可能性:每个 thread 各自独立子进程,完全隔离。

## HIGH-B 修法路径(P2 实施)

### ✅ 推荐:per-session 新建 Codex 实例

```ts
// src/main/adapters/codex-cli/owner.ts(假设路径,P2 实施时确认)
const sessionToken = mcpSessionTokenMap.allocate(sessionId);  // P2 待新建

const codex = new Codex({
  env: {
    ...process.env,
    AGENT_DECK_MCP_TOKEN: sessionToken,  // ← per-session token
  },
  // ... 其他 codex options
});

const thread = codex.startThread({
  sandboxMode: 'workspace-write',
  workingDirectory: sessionRepo.cwd,
  skipGitRepoCheck: true,
});
```

**优势**:
- envOverride 在 constructor 时 frozen,**并发完全 race-safe**(每个 session 的 Codex 实例独立,不共享 env 引用)
- 不依赖 process.env mutation(并发场景下不可靠 — 详 §❌ 不推荐 路径)
- 与 spawn / hand_off_session / 多 codex teammate 并发场景自然兼容

**注意点**:
- 每个 codex session 新建 Codex 实例**开销极低**:Codex constructor 只挂字段,真正子进程 spawn 才在 run() 时发生
- Codex 实例可以与 sessionRepo / sessionManager 同生命周期管理(per-session map cleanup)

### ❌ 不推荐:process.env mutation + 全局单 Codex

```ts
// 反例 —— 并发场景下 race-unsafe
const globalCodex = new Codex();  // 不传 env

// 来自 session A 的请求
process.env.AGENT_DECK_MCP_TOKEN = tokenA;
const threadA = globalCodex.startThread();
// ↑ 此时 thread 还没 spawn 子进程

// 在 threadA.run() 调用前,另一个 session B 的请求来了
process.env.AGENT_DECK_MCP_TOKEN = tokenB;
const threadB = globalCodex.startThread();

// 现在 await 链上 threadA.run() / threadB.run() 任一被驱动 →
// 实际 spawn 的子进程都拿到 process.env.AGENT_DECK_MCP_TOKEN = tokenB
// → tokenA 永远没机会注入 → session A 串到 session B 的权限
```

**根本原因**:`Thread.runStreamed()` 真正 spawn 子进程的时机是 iterate generator 时,中间多次 await,process.env 在并发场景下不可靠。

### temp token → real sid 原子迁移(P2 实施细节)

应用层 sessionRepo 在 `createSession` 时通常先有 temp sessionId(SDK 实际起来后 rename 成 real sid)。codex 端:

1. `mcpSessionTokenMap.allocate(tempSid)` 拿 token,塞 envOverride → new Codex
2. SDK first event 拿到 real sid → `sessionManager.renameSdkSession(tempSid, realSid)` 把 sessionRepo + 子表迁过去
3. **codex token 怎么办?**:option A(简单)— token 与 tempSid 绑死,real sid rename 后 mcpSessionTokenMap 同步 rename key;option B(更彻底)— mcp-session-token-map 提供 `rename(oldSid, newSid)` 原子方法

P2 实施建议:option B 跟着 `sessionManager.renameSdkSession` 一起调,保证 token map 与 sessionRepo invariant 一致。

## 与 Spike 1 的衔接

Spike 1 已定 HIGH-A 修法走 `extra.authInfo` 透传(transport 层 fastify 5 `req.raw.auth` 注入):
- HTTP transport(claude / 任何 HTTP 调 MCP 的 caller)→ extra.authInfo.resolvedSid 走 HookServer onRequest 注入
- in-process transport(应用现状 claude-code)→ closure callerSessionIdOverride 直接 override(不走 extra)
- **codex 走的是 HTTP transport**(codex CLI MCP client → 应用 MCP HTTP endpoint),需要 codex 子进程拿到含 token 的 Authorization header

P2 实施时 mcp-session-token-map 同时服务 HTTP transport 和 codex envOverride 路径:
- HTTP transport:HookServer onRequest 从 Authorization header 提 token → `mcpSessionTokenMap.get(token) → sid` → 注入 `req.raw.auth.resolvedSid`
- codex envOverride:`mcpSessionTokenMap.allocate(sid) → token` → 塞 `env.AGENT_DECK_MCP_TOKEN`,codex CLI 子进程会读这个 env 当 Authorization header 调 MCP HTTP(codex CLI 端读 env 注入 header 的实现需要在 P2 时实地检查 / 配 codex MCP server entry)

## 影响范围

- **新增**:`src/main/agent-deck-mcp/mcp-session-token-map.ts`(per-session token 双向 map,与 Spike 1 §影响范围 共用)
- **新增**:codex-cli adapter 内 per-session Codex 实例管理(map sid → Codex)
- **改**:codex-cli adapter `createSession` / `sendMessage` 改 per-session 新建 Codex 实例,而非全局单例
- **改**:`sessionManager.renameSdkSession` 内调 `mcpSessionTokenMap.rename(oldSid, newSid)` 保证 invariant
- **测试**:含 spike2-runner 同款 sub-test 进 codex-cli adapter 测试(at least envOverride frozen + 并发 token 不串)

## 残留风险

- ❓ **codex CLI MCP server entry 配置**:codex 子进程怎么读 `AGENT_DECK_MCP_TOKEN` 当 Authorization header,需 P2 实地检查 codex CLI 的 MCP client 实现(可能要 codex `~/.codex/config.toml` 加 `[mcp_servers.agent-deck] env = { AUTHORIZATION = "Bearer ${AGENT_DECK_MCP_TOKEN}" }` 类似配置 / 或者 codex 默认透传所有 process.env 给 MCP server)
- ❓ **codex SDK 升级风险**:0.120.0 → 未来版本 `CodexExec.envOverride` / spawn 模型可能变;升级时 watch `dist/index.js` line 222-241 行为
- ❓ **codex SDK approval prompt 行为**:实测时 default approvalPolicy 未显式设(spike runner 没设)实测通过,但生产环境如果撞 `on-request` approval 弹审批,需要让 codex teammate 自动允许(类似 claude-code teammate 的 inbox-watcher 自动 approve 机制)— 不在本 spike 范围,P3/P4 处理

## 后续 Spike

- **Spike 3**(codex SDK 默认 sandbox workspace-write 是否允许 Bash spawn 外部 CLI 子进程):本 spike 内 codex 用 sandbox=workspace-write **能跑 bash echo** 成功(Test 3 echo $$ 返回 PID),证明 sandbox=workspace-write **允许** codex 调用其 builtin shell 工具(bash)执行命令。但 Spike 3 真正想验证的是「codex sandbox 内能不能 `spawn` **外部 claude CLI 子进程**」(reviewer-claude.md (codex 视角) 路径)—— 那是更激进的子进程透出,本 spike 未测,留给 Spike 3
- Spike 2 结果**不依赖** Spike 3 → 可并行
