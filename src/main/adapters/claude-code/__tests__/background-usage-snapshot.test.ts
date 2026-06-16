import type {
  Query,
  SDKControlGetUsageResponse,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { readClaudeUsageSnapshotInBackground } from '../usage-snapshot';

class FakeClaudeUsageQuery implements AsyncIterable<unknown> {
  private frames: unknown[] = [];
  private waiter: ((value: IteratorResult<unknown>) => void) | null = null;
  private done = false;

  readonly close = vi.fn(() => {
    this.done = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  });
  readonly initializationResult = vi.fn().mockResolvedValue({ session_id: 'sdk-session' });
  readonly usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = vi
    .fn()
    .mockResolvedValue({
      session: {
        total_cost_usd: 0,
        total_api_duration_ms: 0,
        total_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: {},
      },
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: {
          utilization: 17,
          resets_at: '2026-06-16T08:00:00.000Z',
        },
        seven_day: {
          utilization: 41,
          resets_at: '2026-06-20T08:00:00.000Z',
        },
      },
      behaviors: null,
    } as SDKControlGetUsageResponse);

  push(frame: unknown): void {
    if (this.done) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: frame, done: false });
      return;
    }
    this.frames.push(frame);
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const frame = this.frames.shift();
        if (frame !== undefined) return Promise.resolve({ value: frame, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<unknown>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

describe('readClaudeUsageSnapshotInBackground', () => {
  it('reads usage after initialization with an idle prompt stream', async () => {
    const query = new FakeClaudeUsageQuery();
    const releaseHookClaim = vi.fn();
    const expectSdkSessionFn = vi.fn(() => releaseHookClaim);
    let promptNext: Promise<IteratorResult<SDKUserMessage>> | null = null;
    const queryFn = vi.fn(
      (args: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
        promptNext = args.prompt[Symbol.asyncIterator]().next();
        return query as unknown as Query;
      },
    );

    const snapshot = await readClaudeUsageSnapshotInBackground({
      loadSdkFn: async () => ({ query: queryFn }) as never,
      getRuntimeOptionsFn: () => ({ executable: 'node', env: { AGENT_DECK_TEST: '1' } }),
      resolveClaudeBinaryFn: () => '/opt/claude',
      getProbeCwdFn: () => '/agent-deck/userData/provider-usage-probe-cwd',
      expectSdkSessionFn,
      hookClaimHoldMs: 0,
    });

    expect(expectSdkSessionFn).toHaveBeenCalledWith(
      '/agent-deck/userData/provider-usage-probe-cwd',
      0,
    );
    expect(queryFn).toHaveBeenCalledWith({
      prompt: expect.any(Object),
      options: expect.objectContaining({
        cwd: '/agent-deck/userData/provider-usage-probe-cwd',
        permissionMode: 'plan',
        settingSources: [],
        executable: 'node',
        env: { AGENT_DECK_TEST: '1', AGENT_DECK_ORIGIN: 'sdk' },
        pathToClaudeCodeExecutable: '/opt/claude',
      }),
    });
    expect(query.initializationResult).toHaveBeenCalledTimes(1);
    expect(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).toHaveBeenCalledTimes(
      1,
    );
    expect(query.initializationResult.mock.invocationCallOrder[0]).toBeLessThan(
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.mock
        .invocationCallOrder[0],
    );
    expect(query.close).toHaveBeenCalled();
    await expect(promptNext).resolves.toEqual({ value: undefined, done: true });
    expect(snapshot).toMatchObject({
      provider: 'claude-code',
      status: 'ok',
    });
    expect(snapshot.windows.map((w) => w.usedPercent)).toEqual([17, 41]);
  });

  it('fails closed when Claude requests interactive authentication', async () => {
    const query = new FakeClaudeUsageQuery();
    const expectSdkSessionFn = vi.fn(() => vi.fn());
    query.initializationResult.mockImplementationOnce(
      () => new Promise(() => undefined) as Promise<unknown>,
    );
    const queryFn = vi.fn(() => query as unknown as Query);

    const snapshotPromise = readClaudeUsageSnapshotInBackground({
      loadSdkFn: async () => ({ query: queryFn }) as never,
      getRuntimeOptionsFn: () => ({ executable: 'node', env: {} }),
      resolveClaudeBinaryFn: () => undefined,
      cwd: '/repo',
      expectSdkSessionFn,
      hookClaimHoldMs: 0,
    });

    query.push({
      type: 'control_request',
      request: { subtype: 'claude_authenticate' },
    });

    const snapshot = await snapshotPromise;

    expect(query.close).toHaveBeenCalled();
    expect(expectSdkSessionFn).toHaveBeenCalledWith('/repo', 0);
    expect(
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET,
    ).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      provider: 'claude-code',
      status: 'error',
      message: '额度信息读取失败，请稍后重试',
    });
  });
});
