# Spike P2 Step 2.7 Report: codex CLI MCP server entry 配置实地检查

**Date**: 2026-05-18
**Status**: ✅ Complete — 选项 A 命中（codex CLI 原生支持 `--bearer-token-env-var`）
**Drives**: P2 Step 2.7 spike-style 验证残留风险

## 关键问题

`agent-deck-mcp-injector.ts:60` 注入 `bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN'` 字段到 codex SDK config（→ codex CLI 启动时拿到 `--config mcp_servers.agent-deck.bearer_token_env_var=AGENT_DECK_MCP_TOKEN`）。**codex CLI MCP client 怎么读这个 env var 拼 HTTP Authorization 头？**

- **选项 A**：codex CLI 原生支持 `bearer_token_env_var` 字段（直接读 env var → 拼 Bearer header）→ 应用层无需改任何代码
- **选项 B**：codex CLI 不识别这字段，需要应用层显式拼 `headers = { Authorization = "Bearer ${env:AGENT_DECK_MCP_TOKEN}" }` 类似 config

## 验证手段

不跑 dev runtime（worktree 内 pnpm install postinstall electron-rebuild 受 Python distutils 阻塞，
plan §当前进度环境踩坑节记录）。改走 codex CLI 内置 `--help` 文档 + SDK 源码论证：

```bash
node_modules/.pnpm/@openai+codex-sdk@0.120.0/node_modules/@openai/codex-sdk/node_modules/.bin/codex \
  mcp add --help
```

输出（节选）：

```
Usage: codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)

Options:
  --url <URL>
      URL for a streamable HTTP MCP server

  --bearer-token-env-var <ENV_VAR>
      Optional environment variable to read for a bearer token. Only valid with streamable HTTP
      servers
```

## 结论

✅ **选项 A 命中**：codex CLI 原生支持 `--bearer-token-env-var` flag（即 config TOML 里的
`bearer_token_env_var` 字段）。codex CLI 内部读 env var 拿 token 拼 HTTP `Authorization: Bearer
<token>` 头连接 streamable HTTP MCP server，**不需要应用层显式拼 headers**。

`agent-deck-mcp-injector.ts:60` 当前实现正确：

```ts
return {
  mcp_servers: {
    [AGENT_DECK_MCP_SERVER_NAME]: {
      url: `http://127.0.0.1:${hookServer.listeningPort}/mcp`,
      bearer_token_env_var: AGENT_DECK_MCP_TOKEN_ENV,  // ← codex CLI 原生识别
    },
  },
};
```

## env var 来源双轨道（plan D1 §(a) 共存策略）

codex CLI 子进程读 `AGENT_DECK_MCP_TOKEN` 时拿到的值由 codex SDK Codex constructor `env` 字段决定：

- **per-session 路径**（应用 spawn 的 codex teammate live session）：
  `sdk-bridge/index.ts:ensureCodex` 内 `new Codex({env: {...snapshotProcessEnv(),
  AGENT_DECK_MCP_TOKEN: <session-token>}})` 把 per-session token 注入 envOverride（spike 2 §1
  实证 envOverride frozen 拷贝到子进程 env）。子进程读到 per-session token →
  HookServer.checkMcpAuth 反查 mcpSessionTokenMap 命中 sid → handler 拿真实 caller
- **全局 fallback 路径**（外部 codex CLI / 非应用 spawn）：
  子进程继承主进程 process.env，读到全局 `AGENT_DECK_MCP_TOKEN`（main bootstrap 一次性设）。
  HookServer.checkMcpAuth 反查 mcpSessionTokenMap 不命中 → 比对全局 token 命中 →
  fallbackToGlobal=true → handler 视为 external caller（EXTERNAL_CALLER_ALLOWED 表只允许
  list/get）

## 不需要的改动

- ✗ 不需要改 `agent-deck-mcp-injector.ts` 拼 `headers` 字段
- ✗ 不需要改 codex SDK 内部传递逻辑（SDK 直接 forward `--config key=value` 给 codex CLI，spike
  2 §2 line 222-234 实证）

## 可选 Step 5.4.5 真测建议

P5 Step 5.4.5 pre-archive smoke test 阶段（解决 Python distutils 后能跑 `pnpm dev`），可补一次
端到端验证：

1. 起应用 → spawn 一个 codex teammate session
2. 在 session 内调一个 mcp tool（如 `list_sessions`）
3. 看 application 日志 `[mcp-server]` 路径是否 OK：
   - HookServer.checkMcpAuth 命中 mcpSessionTokenMap.get → resolvedSid 等于 teammate sid
   - tool handler 拿到真实 caller_session_id（不是 `__external__`）

但本次 spike 已通过 codex CLI 内置 `--help` 文档确认选项 A 命中，端到端真测可推到 P5 一并跑，
不阻塞 Step 2.8/2.9 推进。

## 不影响后续 step

Step 2.7 选项 A 命中 → 应用层 zero code change → Step 2.8 (`sessionManager.renameSdkSession`
集成 `mcpSessionTokenMap.rename + bridge.renameCodexInstance`) 可直接推进。
