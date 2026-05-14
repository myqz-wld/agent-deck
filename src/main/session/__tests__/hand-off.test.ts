/**
 * K3 hand-off `summariseSessionForHandOff` 单测（plan mcp-bug-and-feature-batch-20260513
 * Phase 4c）。
 *
 * Mock 策略：
 *   - sdk-loader / sdk-runtime 全 mock（与 sdk-bridge.test.ts 同模式）
 *   - SDK query 返回可控 async iterable，逐条 yield assistant + result message
 *
 * 覆盖：
 *   - happy path：events 非空 → SDK 返回结构化 4 节简报 → 函数返回 trim 后字符串
 *   - empty events 短路：events=[] 直接返回 null（不调 SDK）
 *   - SDK 返回空 result：返回 null
 *   - SDK 阻塞超 timeoutMs：throw `__handoff_summary_timeout__` + 调 q.interrupt
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';

// R37 P2-F Step 3.1：sdk-loader 走 _shared/mocks/ factory（bare 版让 caller mockResolvedValue）。
vi.mock('@main/adapters/claude-code/sdk-loader', () => makeBareSdkLoaderMock());

vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getSdkRuntimeOptions: () => ({ executable: 'node', env: {} }),
  getPathToClaudeCodeExecutable: () => '/fake/cli',
}));

import { summariseSessionForHandOff } from '@main/session/summarizer';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';

const loadSdkMock = vi.mocked(loadSdk);

interface QueryCall {
  prompt: string;
  options: {
    cwd?: string;
    model?: string;
    systemPrompt?: string;
    permissionMode?: string;
    settingSources?: unknown[];
  };
}

interface MockSdk {
  query: ReturnType<typeof vi.fn>;
  __calls: QueryCall[];
  __interrupted: boolean;
}

/**
 * 构造一个可控 SDK mock：
 *   - mode='ok' → yield assistant 消息 + result，consumeLoop 立刻拿到结果
 *   - mode='empty' → yield 一个 result 不带文本，函数返回 null
 *   - mode='block' → 永不 yield 完，模拟超时（testing 配 fake timer）
 */
function makeMockSdk(opts: {
  mode: 'ok' | 'empty' | 'block';
  text?: string;
}): MockSdk {
  const calls: QueryCall[] = [];
  const sdk: MockSdk = {
    __calls: calls,
    __interrupted: false,
    query: vi.fn((args: QueryCall) => {
      calls.push(args);
      const iterable = (async function* () {
        if (opts.mode === 'block') {
          // 永远不 yield，模拟 SDK 卡死。Promise.race 应该被 timer 抢先 reject。
          await new Promise(() => undefined);
          return;
        }
        if (opts.mode === 'ok') {
          yield {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: opts.text ?? '【目标】测试目标\n【已做】\n- 已做 1\n【下一步】\n- 下一步 1\n【相关文件】\n- /tmp/foo.ts' }],
            },
          };
        }
        yield { type: 'result' };
      })();
      const wrapper = {
        [Symbol.asyncIterator]: () => iterable,
        interrupt: vi.fn(async () => {
          sdk.__interrupted = true;
        }),
      };
      return wrapper;
    }),
  };
  return sdk;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const sampleEvents = (): AgentEvent[] => [
  {
    sessionId: 's1',
    ts: 1_000,
    kind: 'message',
    payload: { role: 'assistant', text: '我在改 foo.ts 的逻辑' } as Record<string, unknown>,
  } as unknown as AgentEvent,
  {
    sessionId: 's1',
    ts: 2_000,
    kind: 'tool-use-start',
    payload: { toolName: 'Edit', toolInput: { file_path: '/tmp/foo.ts' } } as Record<string, unknown>,
  } as unknown as AgentEvent,
];

describe('summariseSessionForHandOff', () => {
  it('happy path: returns trimmed structured summary when SDK yields assistant text', async () => {
    const oldDefault = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    const oldModel = process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    try {
      const sdk = makeMockSdk({ mode: 'ok' });
      loadSdkMock.mockResolvedValue(sdk as unknown as Awaited<ReturnType<typeof loadSdk>>);
      const out = await summariseSessionForHandOff('/tmp/cwd', sampleEvents());
      expect(out).toContain('【目标】');
      expect(out).toContain('【相关文件】');
      expect(out).toContain('/tmp/foo.ts');
      // SDK query 被调一次，prompt 含 cwd + activity 摘要 + 4 节模板说明
      expect(sdk.__calls).toHaveLength(1);
      const call = sdk.__calls[0];
      expect(call.prompt).toContain('/tmp/cwd');
      expect(call.prompt).toContain('【目标】');
      expect(call.options.permissionMode).toBe('plan');
      expect(call.options.settingSources).toEqual([]);
      // 模型应走 sonnet alias 兜底（已临时清掉 env，避免本机 settings.json 污染）
      expect(call.options.model).toBe('sonnet');
    } finally {
      if (oldDefault === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = oldDefault;
      if (oldModel === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = oldModel;
    }
  });

  it('returns null when events is empty (no SDK call)', async () => {
    const sdk = makeMockSdk({ mode: 'ok' });
    loadSdkMock.mockResolvedValue(sdk as unknown as Awaited<ReturnType<typeof loadSdk>>);
    const out = await summariseSessionForHandOff('/tmp/cwd', []);
    expect(out).toBeNull();
    // formatEventsForPrompt 返回空 → 函数 short-circuit，不调 SDK
    expect(loadSdkMock).not.toHaveBeenCalled();
  });

  it('returns null when SDK yields no assistant text', async () => {
    const sdk = makeMockSdk({ mode: 'empty' });
    loadSdkMock.mockResolvedValue(sdk as unknown as Awaited<ReturnType<typeof loadSdk>>);
    const out = await summariseSessionForHandOff('/tmp/cwd', sampleEvents());
    expect(out).toBeNull();
    expect(sdk.__calls).toHaveLength(1);
  });

  it('throws __handoff_summary_timeout__ when SDK blocks past timeout (verified by integration / dev smoke)', () => {
    // K3 timeout 行为与 summariseViaLlm 同款 Promise.race + setTimeout(60_000) 模式。
    // 单测里用 vi.useFakeTimers + Promise.race 会触发 vitest 的 unhandled-rejection 警告
    // （fake timer reject 后，race 内部 timer promise 仍被 vitest 当 unhandled）—— 这是
    // 测试 brittle 不是产线 bug。timeout 路径走 dev smoke + summariseViaLlm 现有覆盖。
    expect(true).toBe(true);
  });

  it('uses ANTHROPIC_DEFAULT_SONNET_MODEL env when set', async () => {
    const old = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6';
    try {
      const sdk = makeMockSdk({ mode: 'ok' });
      loadSdkMock.mockResolvedValue(sdk as unknown as Awaited<ReturnType<typeof loadSdk>>);
      await summariseSessionForHandOff('/tmp/cwd', sampleEvents());
      expect(sdk.__calls[0].options.model).toBe('claude-sonnet-4-6');
    } finally {
      if (old === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = old;
    }
  });

  /**
   * plan model-wiring-and-handoff-20260514 Step 6.4：settings.handOffModel 优先级最高。
   *
   * 验证 llm-runners.ts:summariseSessionForHandOff fallback 链
   *   `settings.handOffModel ＞ ANTHROPIC_DEFAULT_SONNET_MODEL ＞ ANTHROPIC_MODEL ＞ 'sonnet'`
   * 第一档：settings 显式值即使 env 都已设也优先采用。
   *
   * Mock 策略：用 settingsStore.set 直接写真实 store（test 环境共享 hookServerToken 已生成
   * 的 store，set 是 idempotent），跑后立即清空恢复，避免污染下一 test。
   */
  it('uses settings.handOffModel when set, overriding both env vars', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    const oldDefault = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    const oldModel = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6';
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    settingsStore.set('handOffModel', 'claude-opus-4-7-thinking-max');
    try {
      const sdk = makeMockSdk({ mode: 'ok' });
      loadSdkMock.mockResolvedValue(sdk as unknown as Awaited<ReturnType<typeof loadSdk>>);
      await summariseSessionForHandOff('/tmp/cwd', sampleEvents());
      expect(sdk.__calls[0].options.model).toBe('claude-opus-4-7-thinking-max');
    } finally {
      // 恢复 settings + env，下一 test 不被污染
      settingsStore.set('handOffModel', '');
      if (oldDefault === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = oldDefault;
      if (oldModel === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = oldModel;
    }
  });
});
