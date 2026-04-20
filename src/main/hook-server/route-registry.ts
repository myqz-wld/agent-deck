import type { RouteOptions } from 'fastify';
import type { HookServer } from './server';

/**
 * 适配器通过 RouteRegistry 申请挂载路由。RouteRegistry 只是一个薄包装，
 * 主要价值是提供「按 adapter 标记路由」的能力，未来若要按 adapter 启停可基于此扩展。
 */
export class RouteRegistry {
  private byAdapter = new Map<string, RouteOptions[]>();
  constructor(private hookServer: HookServer) {}

  registerForAdapter(adapterId: string, route: RouteOptions): void {
    const arr = this.byAdapter.get(adapterId) ?? [];
    arr.push(route);
    this.byAdapter.set(adapterId, arr);
    this.hookServer.registerRoute(route);
  }

  listForAdapter(adapterId: string): RouteOptions[] {
    return this.byAdapter.get(adapterId) ?? [];
  }
}
