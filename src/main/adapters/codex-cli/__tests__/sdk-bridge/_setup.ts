/**
 * codex sdk-bridge 单测共享 fixture（codex-tests-plan P1 Step 1.1）。
 *
 * 镜像 claude `claude-code/__tests__/sdk-bridge/_setup.ts` TestBridge extend pattern。
 * 抽出 TestCodexBridge 子类 + emits 数组 + makeBridge factory，让 recovery 与 consume-fork
 * 两组 test 复用。
 *
 * **vi.mock 必须**在每个 .test.ts 文件顶部独立声明（hoisted 到文件顶部生效），不能从此
 * helper 导出 —— 所以每个 sub-test 文件自己写一份 vi.mock（与 claude 同款约束）。
 *
 * `emits` 是 module-level mutable array：vitest 默认 worker isolation 保证每个 test 文件
 * 独立 module instance，两个 sub-test 文件互不污染；每个 test 自己 beforeEach 清空。
 *
 * **codex 与 claude 关键差异（影响 TestBridge 形态）**：
 * - codex 的 `cwdExists` / `codexResumeJsonlExists` 是 protected method（不是 jsonlExists）
 * - recovery uses the shared provider-neutral continuation engine
 * - codex 没有 `claudeCodeSandbox` —— per-session 沙盒字段叫 `codexSandbox`
 * - codex 没有 `permissionMode` —— SDK approvalPolicy 写死 'never'
 * - createSession 接 `attachments` + `model` + `codexSandbox`（不是 claudeCodeSandbox）
 */

import { CodexSdkBridge } from '@main/adapters/codex-cli/sdk-bridge';
import { RecoveryCancelledError } from '@main/adapters/shared/recovery-cancelled';
import type { AgentEvent, SessionRecord, UploadedAttachmentRef } from '@shared/types';
import type { CodexThinkingLevel } from '@shared/session-metadata';
import type { CreateSessionOpts } from '@main/adapters/codex-cli/sdk-bridge/create-session/_deps';
import {
  createTrustedContinuationInitialTurn,
  type TrustedContinuationInitialTurn,
} from '@main/session/continuation-context/initial-turn';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
  RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery';
import type {
  ContinuationQuality,
  PreparedContinuationContext,
} from '@main/session/continuation-context/types';

export interface CreateSessionCall {
  cwd: string;
  prompt?: string;
  resume?: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R3 HIGH-G + R7 HIGH-R7-1**:
   * jsonl-missing fallback 走 resumeMode='fresh-cli-reuse-app' 让 SDK 不带 resume 起 fresh CLI thread
   * 但复用 caller 入参 sid 作 applicationSid (不创建新 row)。recovery test 断言此字段。
   */
  resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app';
  /**
   * codex per-session sandbox 档位透传校验（与 claude HIGH-1 同款 — fallback 路径漏传
   * 会让 sandbox-resolve 走 settings 全局值静默降级）。
   */
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  /**
   * codex SDK ThreadOptions.model（v0.131.0+ 支持 per-thread override）— sdk-bridge 已
   * spread 进 ThreadOptions runtime 真切 model；fallback / resume 路径必须显式透传
   * record.model 否则已 spawn 的 codex 实际跑默认 model 而 DB record 显示原 model 不一致。
   */
  model?: string;
  modelReasoningEffort?: CodexThinkingLevel;
  trustedContinuation?: TrustedContinuationInitialTurn;
  /**
   * plan codex-recover-network-dirs-parity-20260602：recover / restart 透传校验 —— reviewer-codex
   * spawn-time 持久化的 network/dirs 必须经 recover createSession 重新交还 codex SDK，否则
   * recover 后 reviewer 失去 web search + 跨目录访问。recovery test 断言这俩字段透传。
   */
  networkAccessEnabled?: boolean;
  additionalDirectories?: readonly string[];
  attachments?: UploadedAttachmentRef[];
  /**
   * **REVIEW_99 R3 cancellation-epoch MED 修法 regression (codex 对称 claude)**:让 recovery test
   * 能断言 recover 路径 createThunk 收到 cancelCheck thunk(MED post-guard 窗口收口)。
   */
  cancelCheck?: () => boolean;
  resumeOnly?: boolean;
  skipFirstUserEmit?: boolean;
}

function preparedRecovery(
  instruction: string,
  providerPrompt: string,
  quality: ContinuationQuality,
  spoolId: string,
): PreparedContinuationContext {
  return {
    version: 1,
    providerPrompt,
    persistedUserText: instruction,
    source: { eventRevision: 7, rebuildAfterRevision: 0, maxEventId: 7 },
    checkpoint: { id: null, throughRevision: 0, formatVersion: 1, refreshed: false },
    projection: { canonicalHash: null, omittedFacts: 0 },
    quality,
    metrics: {
      rawRetentionCeilingTokens: 64_000,
      targetPromptCapacityTokens: 100_000,
      checkpointProjectionBudgetTokens: 12_000,
      generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 100,
      checkpointTokens: 0,
      rawTailTokens: quality === 'instruction-only' ? 0 : 20,
      includedUserMessages: quality === 'instruction-only' ? 0 : 1,
      truncatedBoundaryMessages: 0,
      foldCalls: 0,
      repairCalls: 0,
      elapsedMs: 1,
      uncoveredRevisionRange: null,
    },
    warnings: [],
    preparationHash: 'c'.repeat(64),
    spoolId,
  };
}

export class TestCodexBridge extends CodexSdkBridge {
  /** 替身：每次调记录参数；resolved 控制是否立刻完成 */
  public createCalls: CreateSessionCall[] = [];
  /** 测试时控制 createSession 是否阻塞 / 抛错；undefined = 立刻 resolve */
  public createBehavior: 'resolve' | 'block' | 'reject' = 'resolve';
  public unblock?: () => void;
  public rejectWith?: Error;
  /** 默认让 jsonl "存在"，测试 fallback 路径时设 false */
  public jsonlExistsOverride = true;
  /**
   * cwd 存在性 mock。默认 boolean(true 让现有 case cwd precheck 不触发 fallback)。
   * 测试 fallback 真实行为时改用 Map<path, boolean> 让启发式按路径返回不同值,
   * 测启发式 1 (worktrees regex 命中) / 启发式 2 (parent walk) 真实算法路径,不直接 spy
   * findFallbackCwd 私有方法（与 claude TestBridge cwdExistsOverride 同款）。
   */
  public cwdExistsOverride: boolean | Map<string, boolean> = true;
  public captureCalls: Array<{
    sessionId: string;
    overrides: RecoveryRuntimeOverrides | undefined;
    userEventsAtCapture: number;
  }> = [];
  public prepareCalls: Array<{ spoolId: string; instruction: string }> = [];
  public cleanupCalls: string[] = [];
  public captureError: Error | null = null;
  public prepareError: Error | null = null;
  public preparedQuality: ContinuationQuality = 'instruction-only';
  public preparedProviderPrompt: string | null = null;

  override async createSession(opts: CreateSessionOpts): Promise<{ sessionId: string }> {
    this.createCalls.push({
      cwd: opts.cwd,
      prompt: opts.prompt,
      resume: opts.resume,
      resumeMode: opts.resumeMode,
      codexSandbox: opts.codexSandbox,
      model: opts.model,
      modelReasoningEffort: opts.modelReasoningEffort,
      trustedContinuation: opts.trustedContinuation,
      networkAccessEnabled: opts.networkAccessEnabled,
      additionalDirectories: opts.additionalDirectories,
      attachments: opts.attachments,
      cancelCheck: opts.cancelCheck,
      resumeOnly: opts.resumeOnly,
      skipFirstUserEmit: opts.skipFirstUserEmit,
    });
    if (this.createBehavior === 'block') {
      await new Promise<void>((res) => {
        this.unblock = res;
      });
    } else if (this.createBehavior === 'reject') {
      throw this.rejectWith ?? new Error('mock create reject');
    }
    // **REVIEW_99 R3 cancellation-epoch MED 修法 mock (对称 claude)**:mirror 真实
    // create-session-resume 的 pre-registration guard — createBehavior 解锁后(模拟 ensureCodex /
    // resumeThread await 完成)查一次 cancelCheck,返 true → throw RecoveryCancelledError(模拟
    // 「await 窗口内用户 close」),让 MED post-guard 窗口测试不依赖真 codex spawn 也能驱动 sentinel。
    if (opts.cancelCheck?.()) {
      throw new RecoveryCancelledError(opts.resume ?? 'mock-temp-key');
    }
    return { sessionId: opts.resume ?? 'new-sid' };
  }

  /**
   * codex jsonl 预检 protected wrapper（codex 端命名 `codexResumeJsonlExists` ≠ claude
   * 端 `resumeJsonlExists`；签名也不同 — codex 用 (threadId, startedAt) 因 jsonl 路径含
   * createdAt 日期段，详 recoverer.ts:96-99 注释）。
   *
   * 默认返 true 让测试走 resume 主路径；fallback case 显式设 false 验证降级路径。
   */
  protected override codexResumeJsonlExists(_threadId: string, _startedAt: number): boolean {
    return this.jsonlExistsOverride;
  }

  /**
   * cwd 失效 fallback test seam（与 claude 同款 Map / boolean 双形态）。
   * 默认 true 让现有 case 不受 cwd precheck 影响；新加的 cwd fallback case 显式设 false 或
   * Map 触发降级 + 测启发式行为。Map 形式让启发式 walk 算法按路径返回不同值,测真实路径。
   */
  protected override cwdExists(cwd: string): boolean {
    if (typeof this.cwdExistsOverride === 'boolean') return this.cwdExistsOverride;
    return this.cwdExistsOverride.get(cwd) ?? false;
  }

  protected override captureRecoveryContext(
    session: SessionRecord,
    overrides?: RecoveryRuntimeOverrides,
  ): CapturedRecoveryContinuation {
    this.captureCalls.push({
      sessionId: session.id,
      overrides,
      userEventsAtCapture: emits.filter(
        (event) => event.kind === 'message' && (event.payload as { role?: string }).role === 'user',
      ).length,
    });
    if (this.captureError) throw this.captureError;
    return {
      sourceSessionId: session.id,
      spoolId: `spool-${session.id}`,
      generator: {
        adapter: 'claude-code',
        model: 'sonnet',
        thinking: 'low',
        contextWindowTokens: null,
        configFingerprint: 'generator-test',
      },
      target: {
        adapter: 'codex-cli',
        model: session.model ?? null,
        thinking: null,
        sandbox: null,
        permissionMode: null,
        networkAccessEnabled: null,
        additionalDirectories: [],
        contextWindowTokens: 128_000,
        runtimeFingerprint: 'target-test',
      },
      rawRetentionCeilingTokens: 64_000,
    };
  }

  protected override prepareRecoveryContext(
    capture: CapturedRecoveryContinuation,
    continuationInstruction: string,
  ): Promise<PreparedRecoveryContinuation> {
    this.prepareCalls.push({ spoolId: capture.spoolId, instruction: continuationInstruction });
    if (this.prepareError) return Promise.reject(this.prepareError);
    const prepared = preparedRecovery(
      continuationInstruction,
      this.preparedProviderPrompt ?? `FULL RECOVERY CONTEXT\n${continuationInstruction}`,
      this.preparedQuality,
      capture.spoolId,
    );
    return Promise.resolve({
      prepared,
      turn: createTrustedContinuationInitialTurn(prepared, capture.sourceSessionId),
    });
  }

  protected override cleanupRecoveryContext(capture: CapturedRecoveryContinuation): void {
    this.cleanupCalls.push(capture.spoolId);
  }
}

export const emits: AgentEvent[] = [];

export function makeBridge(): TestCodexBridge {
  return new TestCodexBridge({
    emit: (e) => {
      emits.push(e);
    },
  });
}
