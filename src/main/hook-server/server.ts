import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import type { McpAuthInfo } from '@main/agent-deck-mcp/types';
import {
  HOOK_PROCESSING_FAILED_RESPONSE,
  INVALID_HOOK_BODY_RESPONSE,
  hookOriginFromHeaders,
  hookRouteDiagnostics,
  type HookAdapterId,
} from './route-diagnostics';

/**
 * 共享内嵌 HTTP server。Adapter 在初始化时通过 RouteRegistry.registerRoute()
 * 申请挂载自己的路由，HookServer 不知道任何具体 adapter 的存在。
 *
 * 鉴权使用两个独立 token：
 * - hookToken：所有 `/hook/*` 路由前置校验 `Authorization: Bearer <hookToken>`
 *   安装时写入 app-owned `0600` relay curl config；provider hook 命令只引用该私有文件
 * - mcpToken：所有 `/mcp` 路由前置校验。先反查 per-session token，命中时把
 *   `{resolvedSid, fallbackToGlobal: false}` 写入 `request.raw.auth`，供 mcp-sdk
 *   作为 tool handler 的 `extra.authInfo`；不命中但等于应用全局 token 时写入
 *   `{resolvedSid: null, fallbackToGlobal: true}`，把 caller 限定为 external read-only；
 *   其余 token 一律返回 401。
 *
 * 监听只在 127.0.0.1，但本机任何进程（多用户 / 容器 / 恶意 npm post-install）都能
 * 直接 curl，没有 token 就能伪造 AgentEvent 污染 SQLite / 调 MCP tool 起会话。
 * 两个 token 都是 authority boundary：构造时任一为空都拒绝启动，绝不按请求降级放行。
 */
export class HookServer {
  private app: FastifyInstance;
  private port: number;
  private hookToken: string;
  private mcpToken: string;
  /** 预先把 expected `Bearer xxx` 转 Buffer，避免每次请求都重新分配。 */
  private expectedHookAuthBuf: Buffer;
  /**
   * 全局 mcp token 的 raw（不含 `Bearer ` 前缀）Buffer。Per-session token 不在
   * map 命中时跟它常量时间比对一次，决定是 401 还是 fallback global。
   */
  private mcpTokenRawBuf: Buffer;
  private started = false;

  constructor(port: number, hookToken: string, mcpToken: string) {
    if (typeof hookToken !== 'string' || !hookToken.trim()) {
      throw new Error('HookServer requires a non-empty hookToken');
    }
    if (typeof mcpToken !== 'string' || !mcpToken.trim()) {
      throw new Error('HookServer requires a non-empty mcpToken');
    }
    this.port = port;
    this.hookToken = hookToken;
    this.mcpToken = mcpToken;
    this.expectedHookAuthBuf = Buffer.from(`Bearer ${hookToken}`);
    this.mcpTokenRawBuf = Buffer.from(mcpToken);
    this.app = Fastify({ logger: false });

    // onRequest 是 fastify 最早的 hook，在路由处理前触发。
    // 校验 /hook/ 与 /mcp 两类前缀路由（独立 token），其他路径（健康检查 / 未来扩展）不卡。
    this.app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/hook/')) {
        this.checkAuth(
          request.headers['authorization'],
          this.expectedHookAuthBuf,
          reply,
        );
        return;
      }
      if (request.url.startsWith('/mcp')) {
        this.checkMcpAuth(request, reply);
        return;
      }
    });

    // Fastify rejects malformed JSON before an adapter handler runs. Normalize that boundary too,
    // so parser details and raw input never escape through the hook HTTP response.
    this.app.setErrorHandler((error, request, reply) => {
      if (!request.url.startsWith('/hook/')) {
        reply.send(error);
        return;
      }
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
          ? (error as { statusCode?: unknown }).statusCode
          : undefined;
      const status =
        typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
          ? 400
          : 500;
      const route = safeHookRoute(request.routeOptions.url ?? request.url);
      const metadata = hookRouteMetadata(request.routeOptions.config);
      hookRouteDiagnostics.reportFailure({
        adapter: metadata?.adapter ?? 'unknown',
        route,
        event: metadata?.event ?? 'unknown',
        origin: hookOriginFromHeaders(
          request.headers as Record<string, string | string[] | undefined>,
        ),
        sessionId: null,
        phase: status === 400 ? 'validate' : 'preprocess',
        errorCategory: status === 400 ? 'invalid-body' : 'error',
      });
      reply
        .code(status)
        .send(
          status === 400
            ? INVALID_HOOK_BODY_RESPONSE
            : HOOK_PROCESSING_FAILED_RESPONSE,
        );
    });
  }

  /**
   * 共享的 token 校验逻辑：长度短路 + timingSafeEqual 常量时间比较。
   * @param authHeader Authorization 请求头原始值
   * @param expectedAuthBuf 预拼好的 `Bearer <token>` Buffer
   * @param reply fastify reply（401 直发）
   */
  private checkAuth(
    authHeader: unknown,
    expectedAuthBuf: Buffer,
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ): void {
    const auth = typeof authHeader === 'string' ? authHeader : '';
    // 用 timingSafeEqual 做常量时间比较：普通 `!==` 在比较过程中遇到第一个不同字节
    // 就立刻返回，本机其他低权限进程理论上可以通过测量 401 时延逐字猜 token
    // （loopback 抖动远大于字节差，实战意义有限，但修复成本接近零）。
    // 长度不一致时 timingSafeEqual 会 throw，所以先做长度短路；
    // 若长度不等则视为不通过，绕过 throw 直接 401。
    const authBuf = Buffer.from(auth);
    let ok = false;
    if (authBuf.length === expectedAuthBuf.length) {
      ok = timingSafeEqual(authBuf, expectedAuthBuf);
    }
    if (!ok) {
      reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  }

  /**
   * /mcp 分支专用 auth 逻辑。
   *
   * 与 /hook/ 不同，/mcp 鉴权除了校验 token 还要把 caller_session_id 反查结果通过
   * `request.raw.auth` 透传给 mcp-sdk transport；该字段会成为 handler 的
   * `extra.authInfo`。
   *
   * 三态分流：
   * 1. token 反查 mcpSessionTokenMap 命中 → 写 `{resolvedSid, fallbackToGlobal:false}`,
   *    handler 把 resolvedSid 当真正 caller（per-session 路径，应用 spawn 的 Codex CLI teammate）
   * 2. token 不命中但等于 mcpToken（全局）→ 写 `{resolvedSid:null, fallbackToGlobal:true}`,
   *    handler 视为 external caller（外部 Codex CLI / 非应用 spawn 路径只读不写）
   * 3. token 既不在 sessionTokenMap 也不等于 globalToken → 401
   *
   * timingSafeEqual：global token fallback 路径仍走常量时间比对（与 /hook/ 对称）；
   * per-session token 走 Map.get hash 不存在常量时间比对必要（V8 内部 hash 不逐字节）。
   */
  private checkMcpAuth(
    request: { headers: { authorization?: string | string[] }; raw: unknown },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ): void {
    const rawAuth = request.headers['authorization'];
    const auth = typeof rawAuth === 'string' ? rawAuth : '';
    const BEARER_PREFIX = 'Bearer ';
    if (!auth.startsWith(BEARER_PREFIX)) {
      reply.code(401).send({ ok: false, error: 'unauthorized' });
      return;
    }
    const token = auth.slice(BEARER_PREFIX.length);

    // (1) 优先反查 per-session token map
    const sid = mcpSessionTokenMap.get(token);
    if (sid !== null) {
      const authInfo: McpAuthInfo = { resolvedSid: sid, fallbackToGlobal: false };
      (request.raw as { auth?: McpAuthInfo }).auth = authInfo;
      return;
    }

    // (2) 不命中 → 比对全局 token (timingSafeEqual 常量时间)
    const tokenBuf = Buffer.from(token);
    let isGlobal = false;
    if (tokenBuf.length === this.mcpTokenRawBuf.length) {
      isGlobal = timingSafeEqual(tokenBuf, this.mcpTokenRawBuf);
    }
    if (isGlobal) {
      const authInfo: McpAuthInfo = { resolvedSid: null, fallbackToGlobal: true };
      (request.raw as { auth?: McpAuthInfo }).auth = authInfo;
      return;
    }

    // (3) 都不命中 → 401
    reply.code(401).send({ ok: false, error: 'unauthorized' });
  }

  /**
   * 路由注册必须在 `start()` 之前完成。应用层 guard 把顺序契约固定在
   * HookServer 边界，并让违规调用直接得到可操作的错误，而不是依赖 Fastify
   * listen 后的内部异常。所有 RouteRegistry 调用都属于启动前注册阶段。
   */
  registerRoute(options: RouteOptions): void {
    if (this.started) {
      throw new Error(
        'HookServer.registerRoute called after listen — routes must be registered during bootstrap before hookServer.start()',
      );
    }
    this.app.route(options);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.app.listen({ port: this.port, host: '127.0.0.1' });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.app.close();
    this.started = false;
  }

  get isRunning(): boolean {
    return this.started;
  }

  get listeningPort(): number {
    return this.port;
  }

  /** Hook route bearer token；installer 只把它写入 app-owned `0600` relay curl config。 */
  get bearerToken(): string {
    return this.hookToken;
  }

  /** MCP transport（HTTP /mcp + stdio）Bearer token，B'4 Codex CLI 自动注入用 + Settings UI 复制按钮用。 */
  get mcpBearerToken(): string {
    return this.mcpToken;
  }
}

function safeHookRoute(url: string): string {
  const route = url.split('?', 1)[0] ?? '';
  return /^\/hook\/[a-z0-9/-]+$/.test(route) ? route : '/hook/unknown';
}

function hookRouteMetadata(config: unknown): {
  adapter: HookAdapterId;
  event: string;
} | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const metadata = (config as { hookDiagnostics?: unknown }).hookDiagnostics;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const adapter = (metadata as { adapter?: unknown }).adapter;
  const event = (metadata as { event?: unknown }).event;
  if (
    adapter !== 'claude-code' &&
    adapter !== 'codex-cli' &&
    adapter !== 'grok-build'
  ) {
    return null;
  }
  return typeof event === 'string' && event ? { adapter, event } : null;
}
