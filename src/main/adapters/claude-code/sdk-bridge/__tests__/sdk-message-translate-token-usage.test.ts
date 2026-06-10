/**
 * sdk-message-translate token-usage 采集单测
 * （plan model-token-stats-and-dashboard-20260602 §Phase 1 A2 / 测试矩阵「claude 翻译」行）。
 *
 * 聚焦 assistant 分支的 token-usage 采集 + max-merge 快路径去重（§不变量 5 / G2）：
 * - 同 id 4 指标全相同多帧 → 只 emit 一次（Map 快路径剪枝）
 * - 同 id output 更大 → 重新 emit（F1 max-merge）
 * - 同 id output 相同但 cacheRead/input 更大 → 也重新 emit（G2 4 指标任一更大放行）
 * - 不同 id → 各计一次
 * - cache_* 为 null → 填 0
 * - assistant 无 usage → 不 emit token-usage
 * - 采集 throw 不打断主 message emit（§不变量 3，构造坏 usage 触发）
 *
 * sessionRepo / eventBus mock 掉（assistant token-usage 分支不碰它们，仅 result/system 分支用）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/store/session-repo', () => ({ sessionRepo: { get: vi.fn(), setPermissionMode: vi.fn() } }));
vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));

import { translateSdkMessage } from '../sdk-message-translate';
import { makeInternalSession } from '../types';
import type { AgentEvent } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';

const sessionGetMock = vi.mocked(sessionRepo.get);

function setup() {
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent): void => {
    events.push(e);
  };
  const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-1' });
  return { events, emit, internal };
}

/** 构造一条 assistant SDKMessage（BetaMessage shape：id/model/usage/content）。 */
function assistantMsg(opts: {
  id?: string;
  model?: string;
  usage?: Record<string, number | null>;
  content?: unknown[];
}) {
  return {
    type: 'assistant',
    message: {
      id: opts.id,
      model: opts.model,
      usage: opts.usage,
      content: opts.content ?? [],
    },
  };
}

function resultMsg(opts: {
  uuid?: string;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
  usage?: Record<string, number>;
}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: opts.uuid ?? 'result-uuid-1',
    usage: opts.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: opts.modelUsage ?? {},
  };
}

function tokenEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.kind === 'token-usage');
}

describe('translateSdkMessage token-usage 采集', () => {
  beforeEach(() => {
    sessionGetMock.mockReset();
  });

  it('基本采集：id/model/usage → 一条 token-usage（cache_* 正常）', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        id: 'm1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
        },
      }),
      internal,
    );
    const tu = tokenEvents(events);
    expect(tu).toHaveLength(1);
    expect(tu[0].payload).toEqual({
      messageId: 'm1',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
    });
  });

  it('assistant usage 缺 model 时归到 claude-default', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        id: 'm1',
        usage: {
          input_tokens: 5,
          output_tokens: 3,
        },
      }),
      internal,
    );

    expect(tokenEvents(events)[0].payload).toMatchObject({
      messageId: 'm1',
      model: 'claude-default',
      inputTokens: 5,
      outputTokens: 3,
    });
  });

  it('cache_* 为 null → 填 0（NOT NULL 列防崩，已知踩坑 2）', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        id: 'm1',
        model: 'opus',
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
      internal,
    );
    expect(tokenEvents(events)[0].payload).toMatchObject({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('同 id 4 指标全相同多帧 → 只 emit 一次（Map 快路径剪枝）', () => {
    const { events, emit, internal } = setup();
    const u = { input_tokens: 100, output_tokens: 50 };
    translateSdkMessage(emit, 'sid-1', assistantMsg({ id: 'm1', model: 'opus', usage: u }), internal);
    translateSdkMessage(emit, 'sid-1', assistantMsg({ id: 'm1', model: 'opus', usage: u }), internal);
    expect(tokenEvents(events)).toHaveLength(1);
  });

  it('同 id output 更大 → 重新 emit（F1 max-merge）', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({ id: 'm1', model: 'opus', usage: { input_tokens: 100, output_tokens: 50 } }),
      internal,
    );
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({ id: 'm1', model: 'opus', usage: { input_tokens: 100, output_tokens: 90 } }),
      internal,
    );
    const tu = tokenEvents(events);
    expect(tu).toHaveLength(2);
    expect((tu[1].payload as { outputTokens: number }).outputTokens).toBe(90);
  });

  it('同 id output 相同但 cacheRead 更大 → 也重新 emit（G2 4 指标任一更大）', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        id: 'm1',
        model: 'opus',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
      }),
      internal,
    );
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        id: 'm1',
        model: 'opus',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 },
      }),
      internal,
    );
    const tu = tokenEvents(events);
    expect(tu).toHaveLength(2);
    expect((tu[1].payload as { cacheReadTokens: number }).cacheReadTokens).toBe(200);
  });

  it('不同 id → 各计一次', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({ id: 'm1', model: 'opus', usage: { input_tokens: 1, output_tokens: 1 } }),
      internal,
    );
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({ id: 'm2', model: 'opus', usage: { input_tokens: 1, output_tokens: 1 } }),
      internal,
    );
    expect(tokenEvents(events)).toHaveLength(2);
  });

  it('assistant 无 usage → 不 emit token-usage（但 message 正常）', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({ id: 'm1', model: 'opus', content: [{ type: 'text', text: 'hi' }] }),
      internal,
    );
    expect(tokenEvents(events)).toHaveLength(0);
    expect(events.some((e) => e.kind === 'message')).toBe(true);
  });

  it('无 id（usage 有但 id 缺）→ 不 emit（去重锚点缺失）', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({ model: 'opus', usage: { input_tokens: 1, output_tokens: 1 } }),
      internal,
    );
    expect(tokenEvents(events)).toHaveLength(0);
  });

  it('采集 throw 不打断主 message emit（§不变量 3）', () => {
    const { events, emit, internal } = setup();
    // 用 getter 抛错的 usage 触发采集 try 内异常；message block 应已先 emit
    const badUsage = {
      get input_tokens(): number {
        throw new Error('boom');
      },
    };
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        id: 'm1',
        model: 'opus',
        usage: badUsage as unknown as Record<string, number>,
        content: [{ type: 'text', text: 'hello' }],
      }),
      internal,
    );
    // 主 message 不受影响
    expect(events.some((e) => e.kind === 'message')).toBe(true);
    // token-usage 因 throw 被 catch 吞，未 emit
    expect(tokenEvents(events)).toHaveLength(0);
  });

  it('result.modelUsage 补齐 assistant 帧缺失的 output delta（MiniMax-M3 tok/s=0 回归）', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        id: 'm1',
        model: 'MiniMax-M3',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 80_242,
          cache_creation_input_tokens: 0,
        },
      }),
      internal,
    );
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        uuid: 'result-1',
        modelUsage: {
          'MiniMax-M3': {
            inputTokens: 754,
            outputTokens: 147,
            cacheReadInputTokens: 80_242,
            cacheCreationInputTokens: 0,
          },
        },
      }),
      internal,
    );

    const tu = tokenEvents(events);
    expect(tu).toHaveLength(2);
    expect(tu[0].payload).toMatchObject({
      messageId: 'm1',
      model: 'MiniMax-M3',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 80_242,
    });
    expect(tu[1].payload).toEqual({
      messageId: 'result:result-1:minimax-m3',
      model: 'MiniMax-M3',
      inputTokens: 754,
      outputTokens: 147,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('result.modelUsage 与 assistant 已采集值一致时不重复计数', () => {
    const { events, emit, internal } = setup();
    translateSdkMessage(
      emit,
      'sid-1',
      assistantMsg({
        id: 'm1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
        },
      }),
      internal,
    );
    translateSdkMessage(
      emit,
      'sid-1',
      resultMsg({
        uuid: 'result-2',
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 10,
          },
        },
      }),
      internal,
    );

    expect(tokenEvents(events)).toHaveLength(1);
  });
});
