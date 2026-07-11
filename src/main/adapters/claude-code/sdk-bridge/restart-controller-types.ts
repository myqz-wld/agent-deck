import type { AgentEvent, SessionRecord } from '@shared/types';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
  RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type {
  JsonlExistsThunk,
  JsonlMtimeMsThunk,
  LatestConversationMessageTsThunk,
} from './recoverer';
import type { SdkSessionHandle } from './types';

export interface RestartCreateOpts {
  cwd: string;
  prompt?: string;
  trustedContinuation?: TrustedContinuationInitialTurn;
  resume?: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §C.1 R3 MED-R3-2 修订**:
   * 反向 rename 后 createSession opts.resume 是 applicationSid 维度;但 SDK CLI `--resume` 字段
   * 需要 cli sid 才能找到正确 jsonl 文件。caller (restart-controller) 显式传 resumeCliSid =
   * `sessionRepo.get(currentSid)?.cliSessionId ?? currentSid`,让 createSession bridge 内部
   * effectiveResumeCliSid 解析 resolver 直接拿 cli sid (不依赖反查)。
   */
  resumeCliSid?: string;
  /**
   * **plan restart-controller-jsonl-precheck-20260521 §Step 3b 修法**:
   * 与 bridge CreateSessionOpts.resumeMode 字段对齐(create-session/_deps.ts — REVIEW_105 MED-1 SSOT 锚点;
   * 修前误对齐 facade ClaudeCreateOpts, 现已从 facade type 删除)让 ctx.createSession
   * 透传 fallback 路径不丢精度。helper `maybeJsonlFallback` fellBack=true 路径调 ctx.createSession
   * 时显式传 'fresh-cli-reuse-app' 触发 index.ts:419 finalize guard 跳过整个 finalizeSessionStart。
   *
   * - 'resume-cli' (default): normal resume 行为 (与 restartWithPermissionMode / restartWithClaudeCodeSandbox 现行路径 line 182-198 / 331-346 字面等价)
   * - 'fresh-cli-reuse-app': jsonl-missing fallback 专用 — 仅 helper 内部使用,RestartCreateOpts caller 不直接传
   */
  resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app';
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  /**
   * plan cross-adapter-parity-20260515 Phase A + REVIEW_41 MED-3 fix: cold-restart 路径
   * (restartWithPermissionMode / restartWithClaudeCodeSandbox)透传 extra writable roots。
   * 修前 restart-controller 调 createSession 时不带 extraAllowWrite → 用户在 detail 切
   * acceptEdits/bypass / 切 OS sandbox 档冷重启后 SDK 子进程 sandbox.allowWrite 不含原
   * mainRepo → 写 plan 文件静默失败(与 plan 主旨 app 重启同款 bug,触发条件不同)。
   */
  extraAllowWrite?: readonly string[];
}

export interface RestartCtx {
  /**
   * 与 facade 共享的单飞 Map（CHANGELOG_52 Step 3d/F2 修法：facade 持权威 ref，
   * recoverer 与 restart-controller 双方 mutate 同一份）。同 sessionId 的并发
   * recoverAndSend / restartWithX 排队执行。
   */
  recovering: Map<string, Promise<unknown>>;
  emit: (event: AgentEvent) => void;
  /** thunk 反调 facade.closeSession，避免直接持有 facade ref */
  closeSession: (
    sessionId: string,
    opts?: { markRecentlyDeleted?: boolean },
  ) => Promise<void>;
  /** thunk 反调 facade.createSession，restart 路径用 resume + 新 mode/sandbox 重建 */
  createSession: (opts: RestartCreateOpts) => Promise<SdkSessionHandle>;
  jsonlExistsThunk: JsonlExistsThunk;
  jsonlMtimeMsThunk: JsonlMtimeMsThunk;
  latestConversationMessageTsThunk: LatestConversationMessageTsThunk;
  captureRecoveryContinuation: (input: {
    session: SessionRecord;
    overrides?: RecoveryRuntimeOverrides;
  }) => CapturedRecoveryContinuation;
  prepareRecoveryContinuation: (input: {
    capture: CapturedRecoveryContinuation;
    continuationInstruction: string;
    signal?: AbortSignal;
  }) => Promise<PreparedRecoveryContinuation>;
  cleanupRecoveryContinuation: (capture: CapturedRecoveryContinuation) => void;
}
