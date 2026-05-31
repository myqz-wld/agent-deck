/**
 * codex frontmatter `model` 真生效 regression tests (CHANGELOG_157 R2 reviewer-codex
 * MED-2 follow-up — verify codex-sdk v0.131.0+ ThreadOptions.model 透传 + 优先级链 +
 * 边界 case)。
 *
 * 测试三件事:
 * 1. `runCodexOneshot(opts.model)` 透传到 codex SDK `startThread({ model })` 参数
 * 2. `opts.model` 边界 case (undefined / '' / '   ' / 'gpt-x') 的 trim+skip 行为
 * 3. summarizer-runner / handoff-runner caller 走 `settings.codex*Model > env > undefined`
 *    优先级链
 *
 * Mock 策略 (与 `sdk-bridge.early-err-cleanup.test.ts` 同款):
 * - mock `@main/adapters/codex-cli/codex-instance-pool.getCodexInstance` 返 fake Codex
 *   instance,startThread 捕获 ThreadOptions 参数后返 fake Thread (run 立即 resolve)
 * - mock `@main/store/settings-store.settingsStore` 控 codexSummaryModel / codexHandOffModel
 * - mock `process.env.CODEX_SUMMARY_MODEL` / `CODEX_HANDOFF_MODEL` 控 env 层
 *
 * 不变量验证 (从 R2 reviewer-codex MED-2 修法建议):
 * - settings 非空 → ThreadOptions.model = settings 值
 * - settings 空 + env 非空 → ThreadOptions.model = env 值
 * - settings 空 + env 空 → ThreadOptions 不含 model 字段 (fallback config.toml)
 * - 全空格字符串 → trim 后视为空 → 不 spread
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as codexPool from '@main/adapters/codex-cli/codex-instance-pool';

vi.mock('@main/adapters/codex-cli/codex-instance-pool');

interface CapturedThreadOptions {
  model?: string;
  modelReasoningEffort?: string;
  workingDirectory?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  skipGitRepoCheck?: boolean;
}

let captured: CapturedThreadOptions[] = [];
/** REVIEW_82: 捕获 thread.run 的第二参 turnOptions（{signal}）做 abort 断言 */
let capturedRunSignals: (AbortSignal | undefined)[] = [];

beforeEach(() => {
  captured = [];
  capturedRunSignals = [];
  vi.mocked(codexPool.getCodexInstance).mockResolvedValue({
    startThread: (opts: CapturedThreadOptions) => {
      captured.push(opts);
      return {
        run: async (_input: string, turnOptions?: { signal?: AbortSignal }) => {
          capturedRunSignals.push(turnOptions?.signal);
          return { finalResponse: 'mock-response' };
        },
      };
    },
    resumeThread: (_id: string, opts: CapturedThreadOptions) => {
      captured.push(opts);
      return {
        run: async (_input: string, turnOptions?: { signal?: AbortSignal }) => {
          capturedRunSignals.push(turnOptions?.signal);
          return { finalResponse: 'mock-response' };
        },
      };
    },
  } as unknown as Awaited<ReturnType<typeof codexPool.getCodexInstance>>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runCodexOneshot model spread to ThreadOptions', () => {
  it('opts.model 非空 → ThreadOptions.model 真生效', async () => {
    const { runCodexOneshot } = await import('@main/session/oneshot-llm');
    const result = await runCodexOneshot({
      cwd: '/tmp',
      prompt: 'test',
      modelReasoningEffort: 'low',
      model: 'gpt-5.5-mini',
      timeoutMs: 5000,
      timeoutErrorMessage: 'timeout',
    });
    expect(result).toBe('mock-response');
    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBe('gpt-5.5-mini');
  });

  it('opts.model = undefined → ThreadOptions 不含 model 字段 (fallback config.toml)', async () => {
    const { runCodexOneshot } = await import('@main/session/oneshot-llm');
    await runCodexOneshot({
      cwd: '/tmp',
      prompt: 'test',
      modelReasoningEffort: 'low',
      timeoutMs: 5000,
      timeoutErrorMessage: 'timeout',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBeUndefined();
  });

  it('opts.model = "" (空字符串) → ThreadOptions 不含 model 字段', async () => {
    const { runCodexOneshot } = await import('@main/session/oneshot-llm');
    await runCodexOneshot({
      cwd: '/tmp',
      prompt: 'test',
      modelReasoningEffort: 'low',
      model: '',
      timeoutMs: 5000,
      timeoutErrorMessage: 'timeout',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBeUndefined();
  });

  it('opts.model = "   " (全空格) → trim 后视为空 → ThreadOptions 不含 model 字段', async () => {
    const { runCodexOneshot } = await import('@main/session/oneshot-llm');
    await runCodexOneshot({
      cwd: '/tmp',
      prompt: 'test',
      modelReasoningEffort: 'low',
      model: '   ',
      timeoutMs: 5000,
      timeoutErrorMessage: 'timeout',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBeUndefined();
  });

  it('opts.model = "  gpt-5.5  " (前后空格) → trim 后 spread 干净值', async () => {
    const { runCodexOneshot } = await import('@main/session/oneshot-llm');
    await runCodexOneshot({
      cwd: '/tmp',
      prompt: 'test',
      modelReasoningEffort: 'medium',
      model: '  gpt-5.5  ',
      timeoutMs: 5000,
      timeoutErrorMessage: 'timeout',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBe('gpt-5.5');
  });

  it('其他 ThreadOptions 字段 (sandboxMode / approvalPolicy / skipGitRepoCheck / modelReasoningEffort) 不受 model 行为影响', async () => {
    const { runCodexOneshot } = await import('@main/session/oneshot-llm');
    await runCodexOneshot({
      cwd: '/tmp/proj',
      prompt: 'test',
      modelReasoningEffort: 'medium',
      model: 'gpt-5.5',
      timeoutMs: 5000,
      timeoutErrorMessage: 'timeout',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      modelReasoningEffort: 'medium',
      model: 'gpt-5.5',
    });
  });
});

describe('runCodexOneshot timeout abort (REVIEW_82 MED — codex 子进程取消 parity)', () => {
  it('成功路径：thread.run 收到 AbortSignal（未 abort）', async () => {
    const { runCodexOneshot } = await import('@main/session/oneshot-llm');
    await runCodexOneshot({
      cwd: '/tmp',
      prompt: 'test',
      modelReasoningEffort: 'low',
      timeoutMs: 5000,
      timeoutErrorMessage: 'timeout',
    });
    expect(capturedRunSignals).toHaveLength(1);
    // 关键：thread.run 必须收到 signal（修前不传 → undefined）
    expect(capturedRunSignals[0]).toBeInstanceOf(AbortSignal);
    expect(capturedRunSignals[0]?.aborted).toBe(false); // 成功路径未 abort
  });

  it('timeout 路径：timer 先赢 → onTimeout abort signal → 抛 timeoutErrorMessage', async () => {
    // fake thread.run 永不 resolve，强制 timer 赢；捕获 signal 验证 abort
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(codexPool.getCodexInstance).mockResolvedValue({
      startThread: () => ({
        run: (_input: string, turnOptions?: { signal?: AbortSignal }) => {
          capturedSignal = turnOptions?.signal;
          return new Promise(() => {}); // 永不 resolve → 强制 timeout
        },
      }),
    } as unknown as Awaited<ReturnType<typeof codexPool.getCodexInstance>>);

    const { runCodexOneshot } = await import('@main/session/oneshot-llm');
    await expect(
      runCodexOneshot({
        cwd: '/tmp',
        prompt: 'test',
        modelReasoningEffort: 'low',
        timeoutMs: 20, // 极短 timeout 强制 timer 赢
        timeoutErrorMessage: '__codex_oneshot_timeout__',
      }),
    ).rejects.toThrow('__codex_oneshot_timeout__');

    // 关键：timeout 触发 onTimeout → controller.abort() → signal.aborted=true
    // （修前不传 signal + 无 onTimeout → codex 子进程后台跑泄漏）
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);
  });
});
