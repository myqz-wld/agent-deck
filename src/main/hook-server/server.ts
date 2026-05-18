import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import type { McpAuthInfo } from '@main/agent-deck-mcp/types';

/**
 * 共享内嵌 HTTP server。Adapter 在初始化时通过 RouteRegistry.registerRoute()
 * 申请挂载自己的路由，HookServer 不知道任何具体 adapter 的存在。
 *
 * 鉴权（CHANGELOG_<X> R2 / B'0 ADR §5）：构造时传入两个独立 token：
 * - hookToken：所有 `/hook/*` 路由前置校验 `Authorization: Bearer <hookToken>`
 *   嵌进 CLI 子进程的 hook 命令，泄漏面广
 * - mcpToken：所有 `/mcp` 路由前置校验。**plan codex-handoff-team-alignment-20260518
 *   P2 Step 2.2 升级**：先优先反查 `mcpSessionTokenMap.get(token)`（per-session
 *   token），命中 → 写 `request.raw.auth = {resolvedSid, fallbackToGlobal: false}`
 *   让 mcp-sdk 把 sid 注入到 tool handler `extra.authInfo`；不命中但等于
 *   `mcpToken`（应用全局 token）→ 写 `{resolvedSid: null, fallbackToGlobal: true}`
 *   handler 视为 external caller（EXTERNAL_CALLER_ALLOWED 表 spawn/send/shutdown
 *   全 deny，仅 list/get 允许）；都不命中 → 401。详见 D1 ADR §(b) fallback 命中策略。
 *
 * 监听只在 127.0.0.1，但本机任何进程（多用户 / 容器 / 恶意 npm post-install）都能
 * 直接 curl，没有 token 就能伪造 AgentEvent 污染 SQLite / 调 MCP tool 起会话。
 * token 不为空时强制校验；为空时仅日志告警放行（防止 token 系统出问题导致整个链路停摆）。
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
          this.hookToken,
          this.expectedHookAuthBuf,
          reply,
          'hook-server',
        );
        return;
      }
      if (request.url.startsWith('/mcp')) {
        this.checkMcpAuth(request, reply);
        return;
      }
    });
  }

  /**
   * 共享的 token 校验逻辑：长度短路 + timingSafeEqual 常量时间比较。
   * @param authHeader Authorization 请求头原始值
   * @param expectedToken 期望 token（用于空值时打 warn 标识）
   * @param expectedAuthBuf 预拼好的 `Bearer <token>` Buffer
   * @param reply fastify reply（401 直发）
   * @param tag 日志前缀
   */
  private checkAuth(
    authHeader: unknown,
    expectedToken: string,
    expectedAuthBuf: Buffer,
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    tag: string,
  ): void {
    if (!expectedToken) {
      // token 异常缺失（不应发生）：放行但每次都打 warn，让用户能从日志注意到
      console.warn(`[${tag}] WARN: empty token, request not authenticated`);
      return;
    }
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
   * /mcp 分支专用 auth 逻辑（plan codex-handoff-team-alignment-20260518 P2 Step 2.2）。
   *
   * 与 /hook/ 不同，/mcp 鉴权除了校验 token 还要把 caller_session_id 反查结果通过
   * `request.raw.auth` 透传给 mcp-sdk transport（spike-p2-fastify5-mini 端到端实证：
   * fastify request.raw.auth → mcp-sdk extra.authInfo 通路 OK）。
   *
   * 三态分流：
   * 1. token 反查 mcpSessionTokenMap 命中 → 写 `{resolvedSid, fallbackToGlobal:false}`,
   *    handler 把 resolvedSid 当真正 caller（per-session 路径，应用 spawn 的 codex teammate）
   * 2. token 不命中但等于 mcpToken（全局）→ 写 `{resolvedSid:null, fallbackToGlobal:true}`,
   *    handler 视为 external caller（D1 §(b) — 外部 codex CLI / 非应用 spawn 路径只读不写）
   * 3. token 既不在 sessionTokenMap 也不等于 globalToken → 401
   *
   * timingSafeEqual：global token fallback 路径仍走常量时间比对（与 /hook/ 对称）；
   * per-session token 走 Map.get hash 不存在常量时间比对必要（V8 内部 hash 不逐字节）。
   */
  private checkMcpAuth(
    request: { headers: { authorization?: string | string[] }; raw: unknown },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ): void {
    if (!this.mcpToken) {
      // 全局 token 异常缺失（不应发生）：放行但每次都打 warn。
      // per-session 路径仍可能命中（mcpSessionTokenMap），但本分支为简单起见跳过 token 校验。
      console.warn('[mcp-server] WARN: empty mcpToken, request not authenticated');
      return;
    }

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
   * 路由注册必须在 `start()` 之前完成。fastify 5.x lib/route.js:208 已有等价检查
   * （listen 后再 addRoute 抛 FST_ERR_INSTANCE_ALREADY_LISTENING，错误位置在
   * fastify 内层）。这里加应用层 invariant 把契约固定在 HookServer 边界，
   * 错误文案直接指向修法（详见 REVIEW_27 / CHANGELOG_70：bootstrap 5.5 PRE_LISTEN
   * vs 6 POST_LISTEN 分水岭，所有 routeRegistry 调用必须在 5.5 阶段完成）。
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

  /** Hook 命令 Bearer token，hook-installer 需要把它嵌进 curl 命令的 Authorization 头。 */
  get bearerToken(): string {
    return this.hookToken;
  }

  /** MCP transport（HTTP /mcp + stdio）Bearer token，B'4 codex 自动注入用 + Settings UI 复制按钮用。 */
  get mcpBearerToken(): string {
    return this.mcpToken;
  }
}
