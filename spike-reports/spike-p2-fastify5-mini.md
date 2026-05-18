# Spike P2 Step 2.2 Mini-Runner Report: fastify 5 request.raw.auth → mcp-sdk extra.authInfo

**Date**: 2026-05-18
**Status**: ✅ PASSED — fastify 5.8.5 + mcp-sdk 1.29.0 通路实跑验证 OK
**Drives**: Spike 1 残留风险解除（P2 Step 2.2 内嵌 v4 M3 修法）

## 问题

Spike 1 (`spike1-mcp-sdk-extra-arg.md`) 通过读源码论证：

- mcp-sdk 1.29.0 `StreamableHTTPServerTransport.handleRequest` 内 `const authInfo = req.auth` 从 IncomingMessage 拿 auth，注入到 tool handler 的 extra.authInfo
- 应用层中间件需在 `req.auth = ...`（fastify 5 中即 `request.raw.auth = ...`，因为 `request.raw` 是原 IncomingMessage）

但 Spike 1 残留风险 §未实跑 fastify 5 端到端验证：

> ❓ mcp-sdk 内部把 req.auth 透传到 extra.authInfo 是 fastify / express 标准约定。fastify 5 `request.raw` 是原 Node IncomingMessage，需在 onRequest 写 `request.raw.auth = ...` 而不是 `request.auth = ...`（fastify 不直接暴露这个字段）。本 spike 未实跑 fastify 5 端到端验证。

本 mini-spike 实跑验证残留风险，确认通路 OK 后再改 server.ts 真实路径。

## 验证设计

`spike-reports/spike-p2-fastify5-mini.mjs`：

1. 起 fastify 5.8.5 HTTP server (port 0 自动分配)
2. addHook('onRequest') 在 /mcp 分支验证 Bearer token，命中后写
   `request.raw.auth = {resolvedSid: 'mocked-sid-from-token-map', fallbackToGlobal: false}`
3. 注册 mcp-sdk McpServer + StreamableHTTPServerTransport 到 POST/GET/DELETE /mcp（与
   `src/main/agent-deck-mcp/transport-http.ts:133-147` 真路由结构对齐）
4. 注册 dummy `whoami` tool: handler 内回声 `extra.authInfo` —
   - server-side 同步把 extra.authInfo 存到 outer scope 变量供 mini-runner 末尾断言
   - 把 extra.authInfo JSON 序列化塞到 tool result text，client 端也能直接观察
5. 用 mcp-sdk Client + StreamableHTTPClientTransport 连本地 server，requestInit headers 带
   `Authorization: Bearer mocked-bearer-token-abc123`
6. client.callTool({name: 'whoami'}) → 同步双向断言：
   - client-visible result.content[0].text 解析后 authInfo 与注入值一致
   - server-side outer scope 变量 = 注入值（防 mcp-sdk client 缓存假阳性）

## 实跑结果

```
[spike] fastify listening on 127.0.0.1:54340
[spike] mcp client connected
[spike] whoami returned: {"authInfo":{"resolvedSid":"mocked-sid-from-token-map","fallbackToGlobal":false}}
[spike] server-side observed extra.authInfo: {"resolvedSid":"mocked-sid-from-token-map","fallbackToGlobal":false}
[spike] ✅ client-visible authInfo matches injected value
[spike] ✅ server-side handler observed authInfo correctly
[spike] ✅ ALL CHECKS PASSED — fastify 5 request.raw.auth → mcp-sdk extra.authInfo 通路验证 OK
```

## 结论

✅ **通路验证 OK**，fastify 5.8.5 onRequest hook 写 `request.raw.auth` 后 mcp-sdk 1.29.0
`StreamableHTTPServerTransport.handleRequest` 能正确读 `req.auth`，注入到 tool handler
第二参数 `extra.authInfo`。Spike 1 残留风险解除。

可以进 P2 Step 2.2 真实 server.ts 改造：

- `/mcp` 分支接入 `mcpSessionTokenMap.get(token)` 反查 sid → 命中写
  `request.raw.auth = {resolvedSid, fallbackToGlobal: false}`
- 不命中但等于 `mcpServerToken`（全局 token）→ `request.raw.auth = {resolvedSid: null, fallbackToGlobal: true}`
- 既不在 sessionTokenMap 也不等于 globalToken → 401

下游 P2 Step 2.3-2.4 改 `BuildAgentDeckToolsDeps.callerSessionIdOverride` signature 接 extra 参数，
transport-http.ts 实现 `(extra) => extra?.authInfo?.resolvedSid ?? null`。

## 关键依赖事实

- fastify 5.8.5 `request.raw` 是原 Node IncomingMessage（与 spike 1 推断一致）
- mcp-sdk 1.29.0 `streamableHttp.js:128-140` 内 `const authInfo = req.auth` 直接读 IncomingMessage 字段
- `transport.handleRequest(req.raw, reply.raw, body)` 把 req.raw 传过去（`transport-http.ts:138-141`）
- pnpm 严格模式不 hoist mcp-sdk 到顶层 node_modules（mcp-sdk 是 @anthropic-ai/claude-agent-sdk
  transitive dep），mini-runner 通过绝对路径 `node_modules/.pnpm/@modelcontextprotocol+sdk@.../...`
  动态 import 解决（应用层 transport-http.ts:29-31 同款路径）

## 不影响后续 step

mini-runner 是 acceptance test 性质，跑通即归档，不进 CI。下游 Step 2.10 测试矩阵会在
`__tests__/transport-http-extra-auth.test.ts` 写真正的 vitest case 复现本 spike 路径。
