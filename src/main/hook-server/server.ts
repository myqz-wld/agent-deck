import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';

/**
 * 共享内嵌 HTTP server。Adapter 在初始化时通过 RouteRegistry.registerRoute()
 * 申请挂载自己的路由，HookServer 不知道任何具体 adapter 的存在。
 *
 * 鉴权：构造时传入 token，所有 /hook/* 路由前置校验 `Authorization: Bearer <token>`。
 * 监听只在 127.0.0.1，但本机任何进程（多用户 / 容器 / 恶意 npm post-install）都能
 * 直接 curl，没有 token 就能伪造 AgentEvent 污染 SQLite。token 不为空时强制校验；
 * 为空时仅日志告警放行（防止 token 系统出问题导致整个 hook 链路停摆）。
 */
export class HookServer {
  private app: FastifyInstance;
  private port: number;
  private token: string;
  private started = false;

  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
    this.app = Fastify({ logger: false });

    // onRequest 是 fastify 最早的 hook，在路由处理前触发。
    // 只校验 /hook/ 前缀路由，其他路径（健康检查 / 未来扩展）不卡。
    this.app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/hook/')) return;
      if (!this.token) {
        // token 异常缺失（不应发生）：放行但每次都打 warn，让用户能从日志注意到
        console.warn('[hook-server] WARN: empty token, request not authenticated');
        return;
      }
      const auth = request.headers['authorization'];
      const expected = `Bearer ${this.token}`;
      if (auth !== expected) {
        reply.code(401).send({ ok: false, error: 'unauthorized' });
      }
    });
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

  /** Bearer token，hook-installer 需要把它嵌进 curl 命令的 Authorization 头。 */
  get bearerToken(): string {
    return this.token;
  }
}
