import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

/**
 * 共享内嵌 HTTP server。Adapter 在初始化时通过 RouteRegistry.registerRoute()
 * 申请挂载自己的路由，HookServer 不知道任何具体 adapter 的存在。
 *
 * 鉴权（CHANGELOG_<X> R2 / B'0 ADR §5）：构造时传入两个独立 token：
 * - hookToken：所有 `/hook/*` 路由前置校验 `Authorization: Bearer <hookToken>`
 *   嵌进 CLI 子进程的 hook 命令，泄漏面广
 * - mcpToken：所有 `/mcp` 路由前置校验 `Authorization: Bearer <mcpToken>`
 *   仅嵌进 codex `~/.codex/config.toml` mcp_servers 段 + Settings UI 显示给用户复制，
 *   泄漏面窄。一旦 hookToken 泄漏，MCP 通道仍安全；反之亦然
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
  private expectedMcpAuthBuf: Buffer;
  private started = false;

  constructor(port: number, hookToken: string, mcpToken: string) {
    this.port = port;
    this.hookToken = hookToken;
    this.mcpToken = mcpToken;
    this.expectedHookAuthBuf = Buffer.from(`Bearer ${hookToken}`);
    this.expectedMcpAuthBuf = Buffer.from(`Bearer ${mcpToken}`);
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
        this.checkAuth(
          request.headers['authorization'],
          this.mcpToken,
          this.expectedMcpAuthBuf,
          reply,
          'mcp-server',
        );
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

  registerRoute(options: RouteOptions): void {
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
