/**
 * sdk-bridge 单测共享 fixture（CHANGELOG_105 拆分）。
 *
 * 抽出 TestBridge 子类 + emits 数组 + makeBridge factory，让 recovery 与 consume-fork 两组
 * test 复用。**vi.mock 必须**在每个 .test.ts 文件顶部独立声明（hoisted 到文件顶部生效），
 * 不能从此 helper 导出 —— 所以每个 sub-test 文件自己写一份 vi.mock。
 *
 * 但 import ClaudeSdkBridge 时只要 caller 已 hoisted vi.mock，sessionRepo / sessionManager
 * 等都是 mock 实例，安全。
 *
 * `emits` 是 module-level mutable array：vitest 默认 worker isolation 保证每个 test 文件
 * 独立 module instance，两个 sub-test 文件互不污染；每个 test 自己 beforeEach 清空。
 */

import { ClaudeSdkBridge } from '@main/adapters/claude-code/sdk-bridge';
import { RecoveryCancelledError } from '@main/adapters/shared/recovery-cancelled';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';

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
  permissionMode?: string;
  /**
   * REVIEW_36 HIGH-1 regression：让 recovery test 能断言 fallback 路径透传 claudeCodeSandbox
   * 给 createThunk（修前 fallback 漏传，导致 sandbox-resolve 走 settings 全局值 = 静默降级）。
   */
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  /**
   * plan cross-adapter-parity-20260515 Phase A.9 regression: 让 recovery test 能断言 fallback /
   * resume 路径都透传 extraAllowWrite 给 createThunk(修前缺持久化 + 透传断点 → SDK
   * sandbox.allowWrite 不含原 mainRepo,写 plan 文件静默失败)。
   */
  extraAllowWrite?: readonly string[];
  /**
   * **REVIEW_99 R3 cancellation-epoch MED 修法 regression**:让 recovery test 能断言 recover 路径
   * createThunk 收到 cancelCheck thunk(MED post-guard 窗口收口)。spawn / IPC / restart 路径不传。
   */
  cancelCheck?: () => boolean;
}

export class TestBridge extends ClaudeSdkBridge {
  /** 替身：每次调记录参数；resolved 控制是否立刻完成 */
  public createCalls: CreateSessionCall[] = [];
  /** 测试时控制 createSession 是否阻塞 / 抛错；undefined = 立刻 resolve */
  public createBehavior: 'resolve' | 'block' | 'reject' = 'resolve';
  public unblock?: () => void;
  public rejectWith?: Error;
  /** 默认让 jsonl "存在"，测试 fallback 路径时设 false */
  public jsonlExistsOverride = true;
  /**
   * CHANGELOG_99：cwd 存在性 mock。默认 boolean(true 让现有 case cwd precheck 不触发 fallback)。
   * 测试 fallback 真实行为时改用 Map<path, boolean> 让启发式按路径返回不同值,
   * 测启发式 1 (worktrees regex 命中) / 启发式 2 (parent walk) 真实算法路径,不直接 spy
   * findFallbackCwd 私有方法。
   */
  public cwdExistsOverride: boolean | Map<string, boolean> = true;
  /**
   * CHANGELOG_107: LLM 摘要 mock。默认 null 让 Step 2 helper 集成后 prependHistorySummary
   * 走 fallback 路径(不 prepend 摘要),不破现有 9 case 行为。Step 6 新加的「摘要成功」
   * case 显式覆盖返回字符串验证 prepend 路径。
   */
  public summariseOverride: string | null = null;
  /**
   * CHANGELOG_107 Step 6: 让 summariseForHandOff 抛错的 mock(测 thunk-throw failReason
   * 路径)。默认 null 不抛;set 为 Error 实例让 override 抛。优先级 > summariseOverride
   * (throw 检测在前)。
   */
  public summariseThrow: Error | null = null;
  /**
   * plan cross-adapter-parity-20260515 Phase B.4 regression: capture sendMessage 调用让
   * waiter Promise<string> regression test 能断言 inflight 等待者 path 拿 finalId 调
   * sendThunk(finalId, ...) 而非 sendThunk(OLD sid, ...)。
   *
   * **opt-in seam**:default 空 Set 时 sendMessage 走 super.sendMessage 原行为不破现有 case;
   * 测 waiter 行为时 caller 设 `interceptSidSet = new Set(['new-sid'])` 让仅特定 sid 的
   * sendMessage 调用 push 到 sendMessageCalls + 立即 return(模拟 sessions Map 在 recovery
   * 后已 sync 命中);其它 sid 走 super 原行为,让 p1/p2 第一波 OLD sid 真进 recoverer。
   */
  public sendMessageCalls: Array<{
    sessionId: string;
    text: string;
    attachments?: UploadedAttachmentRef[];
  }> = [];
  public interceptSidSet: Set<string> = new Set();
  /**
   * plan cross-adapter-parity-20260515 + REVIEW_41 MED-2 fix regression seam: 模拟 CLI
   * implicit fork — opts.resume 命中时 createSession 返回此 forked sid 而非 opts.resume。
   *
   * 默认 null:behavior 不变(`return { sessionId: opts.resume ?? 'new-sid' }`),不破现有 case。
   * set 为字符串时:opts.resume 命中走 forked path 返回此 sid,模拟 stream-processor.consume
   * `if (resumeId !== realId)` 触发 renameSdkSession 后 createSession 返回 NEW realId。
   */
  public forkOnResumeOverride: string | null = null;

  override async createSession(opts: {
    cwd: string;
    prompt?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    resume?: string;
    resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app';
    /** REVIEW_36 HIGH-1：fallback 透传 sandbox 档位 */
    claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
    /** plan cross-adapter-parity-20260515 Phase A.9: fallback / resume 透传 extra writable roots */
    extraAllowWrite?: readonly string[];
    /** REVIEW_99 R3 cancellation-epoch MED: recover 路径 pre-registration cancel guard thunk */
    cancelCheck?: () => boolean;
  }): Promise<{ sessionId: string; abort: () => void }> {
    this.createCalls.push({
      cwd: opts.cwd,
      prompt: opts.prompt,
      resume: opts.resume,
      resumeMode: opts.resumeMode,
      permissionMode: opts.permissionMode,
      claudeCodeSandbox: opts.claudeCodeSandbox,
      extraAllowWrite: opts.extraAllowWrite,
      cancelCheck: opts.cancelCheck,
    });
    if (this.createBehavior === 'block') {
      await new Promise<void>((res) => {
        this.unblock = res;
      });
    } else if (this.createBehavior === 'reject') {
      throw this.rejectWith ?? new Error('mock create reject');
    }
    // **REVIEW_99 R3 cancellation-epoch MED 修法 mock**:mirror 真实 create-session-sdk-query 的
    // pre-registration guard — createBehavior 解锁后(模拟 loadSdk / buildMcpServers await 完成)
    // 查一次 cancelCheck,返 true → throw RecoveryCancelledError(模拟「await 窗口内用户 close」)。
    // 让 MED post-guard 窗口测试不依赖真 SDK spawn 也能驱动 sentinel 路径。
    if (opts.cancelCheck?.()) {
      throw new RecoveryCancelledError(opts.resume ?? 'mock-temp-key');
    }
    // plan cross-adapter-parity-20260515 + REVIEW_41 MED-2 fix regression: 模拟 CLI implicit
    // fork — opts.resume 命中时返 forkOnResumeOverride 而非 opts.resume。让 B.4 fork case
    // 能验证 recoverer.recoverAndSend resume 路径返 handle.sessionId(NEW) 而非固定 sessionId(OLD)。
    if (opts.resume && this.forkOnResumeOverride !== null) {
      return { sessionId: this.forkOnResumeOverride, abort: () => undefined };
    }
    return { sessionId: opts.resume ?? 'new-sid', abort: () => undefined };
  }

  // 预检 jsonl 文件存在性是 main 进程实文件查询，单测环境下没有真 ~/.claude/projects/...
  // 默认返回 true 让测试走 resume 主路径；fallback case 显式设 false 验证降级路径
  protected resumeJsonlExists(_cwd: string, _sessionId: string): boolean {
    return this.jsonlExistsOverride;
  }

  /**
   * plan cross-adapter-parity-20260515 Phase B.4 regression test seam:让 waiter Promise<string>
   * 测 case 能断言 inflight 等待者 path 调 sendThunk 时收到的 sid 参数是 finalId 而非 OLD。
   *
   * `interceptSidSet.has(sessionId)` 时:capture 调用参数 + 立即 return(模拟 sessions Map 在
   * recovery 后已 sync,sendMessage 命中 internal session 直接 push prompt;否则 mock 环境
   * sessions Map 永空 → recoverer 递归撞 sessionRepo.get(NEW)=null → throw not found 干扰
   * 真要测的 fix 行为)。
   *
   * 其它 sid:走 super.sendMessage 原行为不破现有 case;让 p1/p2 第一波 OLD sid 真进 recoverer。
   *
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S5 修订**:反向 rename 后 applicationSid 不变,
   * recoverer 返 sessionId 与 caller 入参相同 → p1/p2 都用同 sid → 单纯 interceptSidSet.has 区分不了
   * "首次进 recoverer" vs "waiter post-recoverer 调"。新增 `interceptSkipFirstCalls` 计数:
   * 命中 interceptSidSet 时先扣计数,>0 时仍走 super(模拟 p1 首次 sendMessage 进 recoverer),
   * 计数 === 0 时才真 intercept (模拟 waiter post-recoverer sendThunk → bridge.sendMessage 命中)。
   */
  public interceptSkipFirstCalls = 0;
  override async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    if (this.interceptSidSet.has(sessionId)) {
      if (this.interceptSkipFirstCalls > 0) {
        this.interceptSkipFirstCalls -= 1;
        return super.sendMessage(sessionId, text, attachments);
      }
      this.sendMessageCalls.push({ sessionId, text, attachments });
      return;
    }
    return super.sendMessage(sessionId, text, attachments);
  }

  /**
   * CHANGELOG_99 cwd 失效 fallback test seam(同 jsonl override 模式)。
   * 默认 true 让现有 case 不受 cwd precheck 影响;新加的 cwd fallback case 显式设 false 或
   * Map 触发降级 + 测启发式行为。Map 形式让启发式 walk 算法按路径返回不同值,测真实路径。
   */
  protected cwdExists(cwd: string): boolean {
    if (typeof this.cwdExistsOverride === 'boolean') return this.cwdExistsOverride;
    return this.cwdExistsOverride.get(cwd) ?? false;
  }

  /**
   * CHANGELOG_107 LLM 摘要 test seam(同 resumeJsonlExists / cwdExists 模式)。
   * 默认 null 让 Step 2 集成后 prependHistorySummary 走 skip 路径(不 prepend),
   * 不破现有 9 case;Step 6 新加 case 显式覆盖 summariseOverride 验证 prepend 行为。
   */
  protected async summariseForHandOff(
    _cwd: string,
    _events: AgentEvent[],
  ): Promise<string | null> {
    if (this.summariseThrow) throw this.summariseThrow;
    return this.summariseOverride;
  }
}

export const emits: AgentEvent[] = [];

export function makeBridge(): TestBridge {
  return new TestBridge({
    emit: (e) => {
      emits.push(e);
    },
  });
}
