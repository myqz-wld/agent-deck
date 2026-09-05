import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { HookServer } from '@main/hook-server/server';
import { buildHookRoutes } from '@main/adapters/claude-code/hook-routes';
import { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';

const require = createRequire(process.cwd() + '/package.json');
const inject = createRequire(require.resolve('fastify'))('light-my-request');

describe('lead verification of the production Hook route authentication boundary', () => {
  it('compares canonical and encoded requests using the actual Claude user-prompt route', async () => {
    const emitted: unknown[] = [];
    const server = new HookServer(0, 'fixture-hook-token', 'fixture-mcp-token');
    for (const route of buildHookRoutes((event) => emitted.push(event), new HookRouteDiagnostics())) {
      server.registerRoute(route);
    }
    const app = (server as unknown as { app: any }).app;
    await app.ready();
    const cases = [
      { target: '/hook/userpromptsubmit', token: undefined, expected: 401 },
      { target: '/hook/userpromptsubmit', token: 'Bearer fixture-hook-token', expected: 200 },
      { target: '/%68ook/userpromptsubmit', token: undefined, expected: 200 },
      { target: 'http://localhost/hook/userpromptsubmit', token: undefined, expected: 200 },
    ];
    try {
      for (const item of cases) {
        const before = emitted.length;
        const response = await inject((req: any, res: any) => {
          req.url = item.target;
          app.server.emit('request', req, res);
        }, {
          method: 'POST',
          url: '/probe',
          headers: item.token ? { authorization: item.token } : {},
          payload: { session_id: 'isolated-test-session', cwd: '/fixture-workspace', prompt: 'isolated synthetic prompt' },
        });
        console.log(JSON.stringify({ target: item.target, authenticated: !!item.token, status: response.statusCode, emitted: emitted.slice(before) }));
        expect(response.statusCode).toBe(item.expected);
        expect(emitted.length - before).toBe(item.expected === 401 ? 0 : 1);
      }
    } finally {
      await app.close();
    }
  });
});
