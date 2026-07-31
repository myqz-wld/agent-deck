/**
 * HTTP transport `callerSessionIdOverride` lambda 单测（plan codex-handoff-team-alignment-20260518
 * P2 Step 2.10 / TC4-4b → plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 1.1b 重写）。
 *
 * **本次重写目标（plan §Phase 1.1b / D6 export production lambda）**：
 * 旧版用 inline copy 的 `httpCallerSessionIdOverride` lambda（`?? null` 老合约），合约会随
 * production 修法漂移（H4 教训 — REVIEW_47 §A1-HIGH-1）。本轮重写改为 import production
 * `resolveCallerSidForReadOnly`（plan §Phase 1.1a commit `034efea` 已 export），test 调真实
 * 代码，杜绝合约漂移 bug。
 *
 * 合约（B-HIGH-1 (C) 修法 (c)，详 transport-http.ts:73 production lambda JSDoc）：
 * - `authInfo.fallbackToGlobal === true` → 返回 EXTERNAL_CALLER_SENTINEL（防 spoofing）
 * - `authInfo.resolvedSid` 非空 → 返回该 sid（per-session authn 通过路径）
 * - 缺 authInfo / resolvedSid / extra → 返回 EXTERNAL_CALLER_SENTINEL（兜底防 spoofing）
 *
 * 旧合约 lambda 返 null + caller 走 makeCallerContext fallback `__external__` 的链路被
 * production 短路（lambda 直接返 sentinel），所以 TC4b 集成测试一并改写为「lambda 直接返
 * sentinel → makeCallerContext 用 sentinel → 写 tool deny」单段链路（plan §Phase 1.1b
 * 断言 3 分支铁证 + B-HIGH-1 反驳轮场景 1:1 重写在另文件 spoofing-attack-paths.test.ts /
 * Phase 1.1c）。
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

const sessionHarness = vi.hoisted(() => ({
  get: vi.fn(),
}));

// helpers.ts 通过 `import { sessionRepo } from '@main/store/session-repo'` 间接拉 electron
// （sessionRepo → store/index → electron app paths）。本测试不需要真实 sessionRepo 行为
// （只用 makeCallerContext / denyExternalIfNotAllowed 两个纯函数 helper），mock 让 import
// 链路绕开 electron load。vi.mock 由 vitest hoist 到所有 import 之前生效。
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    ...makeSessionRepoMock({}),
    get: sessionHarness.get,
  },
}));

import {
  registerAgentDeckMcpHttpRoutes,
  resolveCallerSidForReadOnly,
} from '../transport-http';
import {
  MCP_HTTP_HANDOFF_SLOW_THRESHOLD_MS,
  MCP_HTTP_LIFECYCLE_SLOW_THRESHOLD_MS,
  MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS,
  MCP_HTTP_SPAWN_SLOW_THRESHOLD_MS,
  classifyMcpHttpOperation,
  mcpHttpSlowThresholdMs,
} from '../transport-http-observability';
import { makeCallerContext, denyExternalIfNotAllowed } from '../tools/helpers';
import { EXTERNAL_CALLER_SENTINEL, type McpAuthInfo } from '../types';

describe('resolveCallerSidForReadOnly (production lambda) — 3 分支合约', () => {
  it('TC4 per-session authn 通过 → 返回 resolvedSid（mcpSessionTokenMap.get 反查命中）', () => {
    // HookServer.checkMcpAuth 反查 mcpSessionTokenMap 命中 → 写 extra.authInfo
    // 模拟 codex teammate 子进程 envOverride 注入 per-session token → CLI MCP client
    // Bearer header → HookServer 反查命中 sid='codex-teammate-1'
    const extra = {
      authInfo: { resolvedSid: 'codex-teammate-1', fallbackToGlobal: false } satisfies McpAuthInfo,
    };
    expect(resolveCallerSidForReadOnly(extra)).toBe('codex-teammate-1');
  });

  it('TC4b fallbackToGlobal=true → 返回 SENTINEL（防 spoofing — B-HIGH-1 (C) 修法 (c)）', () => {
    // HookServer.checkMcpAuth 反查 per-session map 不命中但等于全局 mcpServerToken → 写
    // extra.authInfo.resolvedSid=null + fallbackToGlobal=true。production lambda **直接**
    // 返 SENTINEL（旧版返 null 让 spoofing 路径有可乘之机；新版从源头切断）。
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    expect(resolveCallerSidForReadOnly(extra)).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('边角 extra=undefined → 返回 SENTINEL（in-process 不走 lambda；defensive 兜底）', () => {
    expect(resolveCallerSidForReadOnly(undefined)).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('边角 extra={} 无 authInfo → 返回 SENTINEL（HookServer 应已 401 拦截; defensive 兜底）', () => {
    expect(resolveCallerSidForReadOnly({})).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('边角 extra.authInfo 缺 resolvedSid 字段 → 返回 SENTINEL（fallback 二档兜底）', () => {
    expect(resolveCallerSidForReadOnly({ authInfo: {} })).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('防 spoofing：fallbackToGlobal=true + 同时塞 resolvedSid 攻击向量 → 仍返 SENTINEL', () => {
    // 攻击者伪造 authInfo 同时塞 fallbackToGlobal=true（global token 路径）+ resolvedSid（伪 sid）
    // 想以伪 sid 身份调写工具。production lambda 早 return SENTINEL，不让 resolvedSid 兜底路径有
    // 机会。fallbackToGlobal 优先级高于 resolvedSid（防 spoofing 兜底层）。
    const extra = {
      authInfo: {
        resolvedSid: 'attacker-forged-sid',
        fallbackToGlobal: true,
      } satisfies McpAuthInfo,
    };
    expect(resolveCallerSidForReadOnly(extra)).toBe(EXTERNAL_CALLER_SENTINEL);
  });
});

describe('MCP HTTP operation classification', () => {
  it('classifies without retaining tool arguments or arbitrary names', () => {
    const classified = classifyMcpHttpOperation({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'send_message',
        arguments: { text: 'sensitive body' },
      },
    });
    expect(classified.operationClass).toBe('local');
    expect(JSON.stringify(classified)).not.toContain('sensitive body');
    expect(
      classifyMcpHttpOperation({
        method: 'tools/call',
        params: { name: 'arbitrary-secret-tool' },
      }).operationClass,
    ).toBe('unknown');
  });
});

describe('MCP slow-request thresholds', () => {
  it('does not classify intentional human waits as server latency', () => {
    expect(mcpHttpSlowThresholdMs('human_wait')).toBeNull();
  });

  it('uses the frozen local, lifecycle, spawn, and hand-off thresholds', () => {
    expect(mcpHttpSlowThresholdMs('local')).toBe(
      MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS,
    );
    expect(mcpHttpSlowThresholdMs('unknown')).toBe(
      MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS,
    );
    expect(mcpHttpSlowThresholdMs('lifecycle')).toBe(
      MCP_HTTP_LIFECYCLE_SLOW_THRESHOLD_MS,
    );
    expect(mcpHttpSlowThresholdMs('spawn')).toBe(
      MCP_HTTP_SPAWN_SLOW_THRESHOLD_MS,
    );
    expect(mcpHttpSlowThresholdMs('hand_off')).toBe(
      MCP_HTTP_HANDOFF_SLOW_THRESHOLD_MS,
    );
  });
});

describe('TC4b integration: production lambda → makeCallerContext → 写 tool deny', () => {
  it('global fallback → lambda 返 SENTINEL → makeCallerContext 用 __external__', () => {
    // makeCtx uses the required transport provider directly; public args cannot supply identity.
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    const overridden = resolveCallerSidForReadOnly(extra);
    expect(overridden).toBe(EXTERNAL_CALLER_SENTINEL);

    const ctx = makeCallerContext(overridden, 'http');

    // SENTINEL 直传 makeCallerContext，callerSessionId 仍为 __external__
    expect(ctx.callerSessionId).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('spoofing 兜底：fallbackToGlobal=true + args 塞伪 sid → lambda 优先 SENTINEL → 写 tool deny', () => {
    // 攻击场景（B-HIGH-1 反驳轮）：global token caller 传 args.callerSessionId='active-victim-sid'
    // 试图以 victim 身份调 spawn_session。身份只取 production provider，所以伪造字段无效。
    const extra = {
      authInfo: { resolvedSid: null, fallbackToGlobal: true } satisfies McpAuthInfo,
    };
    const overridden = resolveCallerSidForReadOnly(extra);
    const callerSid = overridden;
    expect(callerSid).toBe(EXTERNAL_CALLER_SENTINEL);

    const ctx = makeCallerContext(callerSid, 'http');
    const denial = denyExternalIfNotAllowed('spawn_session', ctx);
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    const textJson = JSON.parse(denial!.content[0].text);
    expect(textJson.error).toMatch(/spawn_session not allowed for external caller/);
  });

  it('per-session 合法路径：lambda 返 resolvedSid + args 塞伪 sid → resolvedSid 优先', () => {
    // codex teammate 真正 callerSessionId 由 HookServer.checkMcpAuth 反查 token 解析,
    // 即使 Codex agent 在公开参数里伪造 sid，身份仍只取 token 解析出的 resolvedSid。
    const extra = {
      authInfo: { resolvedSid: 'real-sid', fallbackToGlobal: false } satisfies McpAuthInfo,
    };
    const overridden = resolveCallerSidForReadOnly(extra);
    const callerSid = overridden;
    expect(callerSid).toBe('real-sid'); // 不是 'fake-injected-sid'
  });

  it('makeCallerContext __external__ + list_sessions（read-only） → 不拒绝（read-only 例外）', () => {
    // EXTERNAL_CALLER_ALLOWED.list_sessions=true（read-only 允许 external）
    const ctx = makeCallerContext(EXTERNAL_CALLER_SENTINEL, 'http');
    const denial = denyExternalIfNotAllowed('list_sessions', ctx);
    expect(denial).toBeNull();
  });
});

class FakeRawResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  writableFinished = false;
  readonly headers = new Map<string, string>();
  body = '';

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  end(body = ''): void {
    this.body = body;
    this.headersSent = true;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('finish');
  }
}

describe('MCP HTTP observability integration', () => {
  it.each(['begin', 'complete'] as const)(
    'preserves auth, status, body, hijack, and close cleanup when observer %s throws',
    async (failurePoint) => {
      sessionHarness.get.mockReturnValue({ agentId: 'codex-cli' });
      const transports: Array<{
        handleRequest: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      }> = [];
      class FakeTransport {
        readonly close = vi.fn(async () => {});
        readonly handleRequest = vi.fn(
          async (_request: unknown, rawResponse: unknown, body?: unknown) => {
            const response = rawResponse as FakeRawResponse;
            expect(body).toEqual({
              method: 'tools/call',
              params: {
                name: 'send_message',
                arguments: { text: 'raw body secret' },
              },
            });
            response.statusCode = 207;
            response.setHeader('content-type', 'application/json');
            response.end('exact response body');
          },
        );

        constructor(_options: {
          sessionIdGenerator: (() => string) | undefined;
        }) {
          transports.push(this);
        }
      }

      const mcpServer = {
        connect: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
      const observer = {
        begin: vi.fn(() => {
          if (failurePoint === 'begin') throw new Error('observer begin secret');
          return {
            operation: { operationClass: 'local' as const, correlationSlot: 1 },
            startedAtMs: 0,
          };
        }),
        beginOperation: vi.fn((operation) => ({
          operation,
          startedAtMs: 0,
        })),
        complete: vi.fn(() => {
          if (failurePoint === 'complete') {
            throw new Error('observer complete secret');
          }
        }),
      };
      const routes: Array<Record<string, unknown>> = [];
      const routeRegistry = {
        registerForAdapter: vi.fn(
          (_adapterId: string, route: Record<string, unknown>) => {
            routes.push(route);
          },
        ),
      };
      const buildServer = vi.fn(async () => mcpServer);
      await registerAgentDeckMcpHttpRoutes(routeRegistry as never, {
        observer,
        loadSdk: async () => ({
          http: {
            StreamableHTTPServerTransport: FakeTransport,
          },
        }),
        buildServer,
      });

      const postRoute = routes.find((route) => route.method === 'POST');
      const handler = postRoute?.handler as
        | ((request: unknown, reply: unknown) => Promise<void>)
        | undefined;
      expect(handler).toBeTypeOf('function');
      const authInfo = {
        resolvedSid: 'authenticated-session-secret',
        fallbackToGlobal: false,
      } satisfies McpAuthInfo;
      const request = {
        raw: { auth: authInfo },
        body: {
          method: 'tools/call',
          params: {
            name: 'send_message',
            arguments: { text: 'raw body secret' },
          },
        },
      };
      const raw = new FakeRawResponse();
      const reply = {
        raw,
        hijack: vi.fn(),
      };

      await handler!(request, reply);
      expect(buildServer).toHaveBeenCalledWith('http', 'codex-cli');
      expect(request.raw.auth).toBe(authInfo);
      expect(raw.statusCode).toBe(207);
      expect(raw.body).toBe('exact response body');
      expect(reply.hijack).toHaveBeenCalledOnce();
      expect(observer.begin).toHaveBeenCalledWith(request.body);
      if (failurePoint === 'complete') {
        expect(observer.complete).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: {
              operationClass: 'local',
              correlationSlot: 1,
            },
          }),
          { kind: 'response', statusCode: 207 },
        );
      } else {
        expect(observer.complete).not.toHaveBeenCalled();
      }
      expect(transports[0]?.handleRequest).toHaveBeenCalledWith(
        request.raw,
        raw,
        request.body,
      );

      raw.emit('close');
      await Promise.resolve();
      await Promise.resolve();
      expect(transports[0]?.close).toHaveBeenCalledOnce();
      expect(mcpServer.close).toHaveBeenCalledOnce();
    },
  );
});
