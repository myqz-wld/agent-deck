import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';

/**
 * 共享内嵌 HTTP server。Adapter 在初始化时通过 RouteRegistry.registerRoute()
 * 申请挂载自己的路由，HookServer 不知道任何具体 adapter 的存在。
 */
export class HookServer {
  private app: FastifyInstance;
  private port: number;
  private started = false;

  constructor(port: number) {
    this.port = port;
    this.app = Fastify({ logger: false });
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
}
