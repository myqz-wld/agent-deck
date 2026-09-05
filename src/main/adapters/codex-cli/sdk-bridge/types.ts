/**
 * 类型 — Codex bridge（CHANGELOG_52 Step 4a / 第三轮大文件拆分）。
 *
 * 抽自 codex-cli/sdk-bridge.ts 顶部 interface 段。
 */
import type {
  AgentEvent,
  ContextRuntimeIdentityEvidence,
  PermissionRequest,
  PermissionResponse,
} from '@shared/types';
import type { AdapterHookServerPort } from '@main/adapters/types/adapter-context';
import type { CodexAppServerThread } from '../app-server/client';
import type { CodexTokenUsageSnapshot } from '../app-server/token-usage-observation';
import type { CodexDeferredUserEvent, CodexPendingTurnQueue } from './pending-turn-queue';
import type { TrustedContinuationAcceptanceController } from '@main/adapters/trusted-continuation';
import type { CodexLiveTokenEstimateState } from './live-token-rate-core';
import type { RecoveryContinuationHost } from '@main/session/continuation-context/recovery-types';
import type { CodexBridgeRuntimeHost } from './runtime-host-core';

export type { CodexLiveTokenEstimateState } from './live-token-rate-core';

export type { CodexDeferredUserEvent } from './pending-turn-queue';

export interface CodexSubmittingUserMessage {
  event: CodexDeferredUserEvent;
  cancelled: boolean;
  kind?: 'turn' | 'steer';
  requestController?: AbortController;
}

export interface CodexPendingPermission {
  request: PermissionRequest;
  respond: (response: PermissionResponse) => void;
  cancel: (reason: 'cancelled' | 'timed-out') => void;
}

export interface CodexSessionHandle {
  sessionId: string;
}

export interface CodexBridgeOptions {
  emit: (e: AgentEvent) => void;
  recoveryContinuationHost: RecoveryContinuationHost;
  runtimeHost: CodexBridgeRuntimeHost;
  /** Native app-server approval request timeout. 0 keeps requests pending indefinitely. */
  permissionTimeoutMs?: number;
  /**
   * HookServer 实例引用（CHANGELOG_<X> R2 / B'4 + R1.A5 + R1.D7）。
   * lazy ref：bridge 构造时存指针，ensureCodex 调用时实时读 isRunning / mcpBearerToken /
   * listeningPort 计算 codex SDK config 字段（mcp_servers.agent-deck 自动注入）。
   *
   * Optional：null/undefined 时 codex 不挂 agent-deck MCP server（与 enableAgentDeckMcp
   * OFF 同语义）。便于单测注入 mock 或不挂场景。
   */
  hookServer?: AdapterHookServerPort;
}

export interface InternalSession {
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S2**:
   * applicationSid 生命周期分两类(详 claude InternalSession.applicationSid jsdoc):
   *
   * 【spawn 主路径】(无 opts.resume 起新 thread):
   * - ctor 时 applicationSid = tempKey
   * - first thread.started 到达时 (thread-loop.ts:142 isNewSpawn 分支保护):
   *   - 调 sessionManager.renameSdkSession(tempKey, realId)
   *   - internal.applicationSid = realId, internal.threadId = realId
   *
   * 【resume / jsonl-missing fallback / restart 路径】:
   * - ctor 时 applicationSid = caller 传入 opts.resume
   * - 全生命周期 applicationSid 不变 (反向 rename 仅改 threadId)
   *
   * codex 端 sessions Map / event sid / handle return / MCP token 全部用此字段。
   */
  applicationSid: string;
  /** 真实 thread_id，第一次 thread.started 事件后写入。resume 路径在创建时就有。
   *
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S2**: 与 v021 sessions.cli_session_id 列对齐,
   * SDK / CLI thread 当前 sid。codex case 3 fork (thread-loop.ts:263) 时 update 此字段,
   * applicationSid 不动。 */
  threadId: string | null;
  cwd: string;
  thread: CodexAppServerThread;
  /** Exact effective app-server model/provider identity, null until a native boundary proves it. */
  runtimeIdentity: ContextRuntimeIdentityEvidence | null;
  /** Present only while the first trusted continuation turn crosses its native readiness boundary. */
  trustedContinuationAcceptance?: TrustedContinuationAcceptanceController;
  /** Serialized turns retain lazy image paths, deferred user events and handoff metadata together. */
  pendingTurns: CodexPendingTurnQueue;
  /** Queued turn submitted to app-server but not yet accepted by turn/start. */
  submittingUserMessage?: CodexSubmittingUserMessage | null;
  /** Bounded in-memory acknowledgements for retry-safe internal provider turns. */
  acceptedEnqueueFingerprints?: Map<string, string>;
  /** 当前正在跑的 turn 的 AbortController；中断时调用 abort() */
  currentTurn: AbortController | null;
  /** app-server active turn id；turn/steer 的 expectedTurnId 必须匹配它。 */
  currentTurnId: string | null;
  /** turn loop 是否在跑（避免 sendMessage 重复启动） */
  turnLoopRunning: boolean;
  /** Non-steerable adapter command currently owns the provider input boundary. */
  activeControlCommand?: 'clear' | 'compact' | null;
  /** Generation-scoped worktree transition gate for dequeue and active-turn steering. */
  cwdTransitionGeneration?: number | null;
  /** Successful handoff sealed this source; finish only the active turn, then dispose runtime. */
  retireAfterCurrentTurn?: boolean;
  /** Idempotence guard for source runtime/client/claim/token cleanup. */
  retirementFinalized?: boolean;
  /** Ordinary close may reap queued uploads; handoff retirement preserves source-history paths. */
  deletePendingAttachmentsOnRetirement?: boolean;
  /**
   * 已被外部关闭（closeSession / 30s timeout fallback）—— 进 abort 之前置 true。
   * runTurnLoop catch 看到此标记一律静默退出，**不**再 emit `finished/message`。
   * REVIEW_4 H1：旧版 closeSession 后 runTurnLoop catch 仍 emit finished:interrupted，
   * 该 finished `source='sdk'` 不被 dedup 跳过 → ensureRecord 把已删 session 复活成幽灵。
   * REVIEW_4 M5：30s timeout 路径也经历同一条 abort，旧版会先 emit finished:error
   * （resolveWithFallback 内）+ 再 emit finished:interrupted（runTurnLoop catch），双 finished。
   * 用户主动 interrupt（interruptSession）**不**置此标记 —— UI 仍要看到「已中断」反馈。
   */
  intentionallyClosed: boolean;
  /** 生成中 tok/s display-only app-server usage 状态（不写库，turn 末清掉）。 */
  codexLiveTokenEstimate?: CodexLiveTokenEstimateState;
  /** Thread-lifetime cumulative usage watermark; survives turn boundaries and rejects replays. */
  codexTokenUsageWatermark?: CodexTokenUsageSnapshot;
  /** app-server initiated native approval requests awaiting a response in Agent Deck. */
  pendingPermissions: Map<string, CodexPendingPermission>;
}

/**
 * 打包后 (.app) 内置 codex vendored 二进制的平台映射，对齐 @openai/codex 平台包。
 */
export interface BundledBinarySpec {
  /** @openai/ 下的子包目录名，与 PLATFORM_PACKAGE_BY_TARGET 的 value 去掉 '@openai/' 前缀对齐 */
  pkgDir: string;
  /** vendor 子目录的 target triple */
  triple: string;
  /** 二进制文件名（windows = codex.exe，其余 = codex） */
  binName: string;
}
