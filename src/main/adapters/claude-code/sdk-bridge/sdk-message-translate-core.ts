/**
 * SDK message → AgentEvent 翻译（CHANGELOG_52 Step 3a / 第三轮大文件拆分）。
 *
 * 抽自 sdk-bridge.ts 内的 3 个 private 方法 (translate / maybeEmitFileChanged /
 * maybeEmitImageFileChanged)，行为与原版字节级等价。
 *
 * 这 3 个函数是**纯函数**：
 * - 入参全部 prop-drive（emit 函数 / sessionId / msg / internal 引用）
 * - 不依赖 ClaudeSdkBridge class 的任何 private state
 * - 唯一外部副作用是 emit + 显式 host ports（与原版一致）
 *
 * 护栏（不变）：
 * - REVIEW_11 Bug 2 — system.init/status 上行 frame 的 permissionMode 反向同步 + emit upsert
 * - REVIEW_13 Bug 6 — result frame `if (internal.expectedClose) return` 整段 return（红字 / finished UI / 系统通知三通道一起 skip）
 * - CHANGELOG_47 — maybeEmitImageFileChanged 内 internal.toolUseNames.delete 提到所有 tool_result 顶层
 * - thinking-prelude 启发式（紧邻另一个 text 的 当前 block 是 thinking-prelude）
 */
import type { AgentEvent } from '@shared/types';
import { buildClaudeCompactMessageText } from '../compact-message';
import {
  clearClaudeLiveTokenEstimateCore,
  completeClaudeLiveTokenEstimateCore,
  handleClaudeStreamEventForLiveRateCore,
  type ClaudeLiveRateHost,
} from './live-token-rate-core';
import { resetTurnUsageAccounting } from './authoritative-reasoning-usage';
import type { InternalSession } from './types';
import {
  syncClaudeRuntimeModelCore,
  type ClaudeRuntimeMetadataHost,
} from './runtime-metadata-core';
import {
  emitClaudeAssistantUsage,
  reconcileClaudeFinalResultUsage,
  type ClaudeFinalResultUsage,
} from './final-result-usage-core';
import { claudeFinishedPayload } from './result-outcome';
import {
  confirmClaudeUserMessageAcceptanceCore,
  discardClaudeSubmittingUserMessageCore,
  type ClaudeUserMessageAcceptanceHost,
} from './user-message-acceptance-core';
import {
  claudeAssistantContextTokens,
  claudeContextUsagePayload,
  claudeContextWindowPayload,
} from './context-usage-core';
import {
  claudeCompactFailureTextCore,
  resolveClaudeFallbackModelCore,
  syncClaudeReportedPermissionModeCore,
  type ClaudeMessageTranslationStateHost,
} from './message-translation-state-core';
import {
  consumePendingFileChangeIntentCore,
  maybeEmitImageFileChangedCore,
  pushFileChangeIntentCore,
} from './message-file-changes-core';

type EmitFn = (e: AgentEvent) => void;

export interface ClaudeSdkMessageTranslationHost
  extends ClaudeUserMessageAcceptanceHost {
  runtimeMetadata: ClaudeRuntimeMetadataHost;
  liveRate: ClaudeLiveRateHost;
  state: ClaudeMessageTranslationStateHost;
}

/**
 * 把 SDK 上行的 SDKMessage 翻译成 AgentEvent 流，按需 emit 一条或多条事件。
 * 调用方（class 内 consume loop）只需 `translateSdkMessage(emit, sessionId, msg, internal)`。
 *
 * 行为与原 ClaudeSdkBridge.translate 字节级等价。
 */
export function translateSdkMessageCore(
  emit: EmitFn,
  sessionId: string,
  msg: { type: string; [k: string]: unknown },
  internal: InternalSession,
  host: ClaudeSdkMessageTranslationHost,
): void {
  const ts = host.now();
  const e = (kind: AgentEvent['kind'], payload: unknown): void => {
    emit({ sessionId, agentId: host.agentId, kind, payload, ts, source: 'sdk' });
  };
  confirmClaudeUserMessageAcceptanceCore(emit, sessionId, msg, internal, host);

  // SDK system/init is the authoritative primary-model report for the main session. Keep this
  // separate from assistant.message.model: assistant frames may describe fallback/subagent routing.
  if (msg.type === 'system' && msg.subtype === 'init') {
    syncClaudeRuntimeModelCore(internal, msg.model, host.runtimeMetadata);
  }
  if (
    msg.type === 'system' &&
    msg.subtype === 'model_refusal_fallback' &&
    msg.scope !== 'local'
  ) {
    syncClaudeRuntimeModelCore(internal, msg.fallback_model, host.runtimeMetadata);
  }

  if (msg.type === 'assistant') {
    // m = msg.message = BetaMessage（id / model / usage / content 都在这层，不在 msg 顶层）。
    // plan §Phase 1 A2（F7 claude-INFO-3）：token-usage 采集的 id/model/usage 读自 m。
    const m = msg.message as {
      id?: string;
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        output_tokens_details?: { thinking_tokens?: number | null } | null;
      };
      content?: {
        type: string;
        text?: string;
        name?: string;
        input?: unknown;
        id?: string;
        thinking?: string;
      }[];
    };
    // SDK 给 assistant 消息附带 error 字段时（rate_limit / billing_error / auth 等），
    // 把它当成一条错误文案推到时间线，UI 能立刻看到 CLI 报的真实问题。
    const errCode = (msg as { error?: string }).error;
    if (errCode) {
      e('message', { text: `⚠ Claude API 错误：${errCode}`, error: true });
    }
    const contextTokens = claudeAssistantContextTokens(m?.usage);
    if (contextTokens !== null) {
      e(
        'context-usage',
        claudeContextUsagePayload(internal, { usedTokens: contextTokens }),
      );
    }
    const blocks = Array.isArray(m?.content) ? m.content : [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        // Anthropic API 标准 BetaThinkingBlock { type:'thinking', thinking, signature }
        // 与 BetaRedactedThinkingBlock { type:'redacted_thinking', data }；
        // redacted 内容已加密，UI 显示占位符即可。
        const text =
          block.type === 'thinking' ? (block.thinking ?? '').trim() : '[redacted thinking]';
        if (text) e('thinking', { text });
      } else if (block.type === 'text' && block.text) {
        // 同一帧 SDK assistant message 里出现多个连续 text block，是 Claude Code
        // 把 extended thinking block 压平成 text 推给 SDK 的产物：紧邻另一个 text 的
        // 当前 block 是 thinking-prelude，最后一段才是 final answer。
        // 判断条件「下一个紧邻 block 也是 text」覆盖：
        //   [text, text]            → block[0] thinking, block[1] message
        //   [text, tool_use]        → block[0] message （tool 调用前的解释，非 thinking）
        //   [text, tool_use, text]  → 两段 text 都是 message（被 tool_use 隔开）
        //   [text, text, tool_use]  → block[0] thinking, block[1] message
        const next = blocks[i + 1];
        const isThinkingPrelude = !!(next && next.type === 'text' && next.text);
        if (isThinkingPrelude) {
          e('thinking', { text: block.text });
        } else {
          e('message', { text: block.text, role: 'assistant' });
        }
      } else if (block.type === 'tool_use') {
        // 反查需要：tool_result block 只带 tool_use_id 没 toolName，必须靠这条记录
        if (block.id && block.name) {
          internal.toolUseNames.set(block.id, block.name);
        }
        e('tool-use-start', {
          toolName: block.name,
          toolInput: block.input,
          toolUseId: block.id,
        });
        // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.5 修法 (A1-MED-1 codex):
        // Edit / Write / MultiEdit intent 不在 tool_use 阶段立即 emit file-changed;改为 push
        // 到 internal.pendingFileChangeIntents,延迟到 user.tool_result + status='completed'
        // 再 emit (status='failed' 仅 delete 不 emit,避免 SDK 工具 fail 时仍发出脏 file-changed)。
        // 详 types.ts pendingFileChangeIntents 字段 jsdoc。
        pushFileChangeIntentCore(internal, block.name, block.input, block.id);
      }
    }
    // Assistant usage is per API call, unlike cumulative result.modelUsage. Persist it under the
    // provider message id; repeated/progressive frames max-merge safely in token_usage.
    try {
      emitClaudeAssistantUsage(
        e,
        resolveClaudeFallbackModelCore(internal, sessionId, host.state),
        m,
        internal,
      );
    } catch {
      // Usage telemetry must never interrupt assistant content translation.
    }
  } else if (msg.type === 'user') {
    const m = msg.message as {
      content?: { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[];
    };
    const blocks = Array.isArray(m?.content) ? m.content : [];
    const useStructuredToolResult =
      blocks.filter((block) => block.type === 'tool_result').length === 1 &&
      Object.prototype.hasOwnProperty.call(msg, 'tool_use_result');
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        // 反查 assistant tool_use 时记下的 name；renderer ToolEndRow 必须靠这个才能显示
        // 「<tool> 完成」而不是兜底的「工具 完成」。maybeEmitImageFileChanged 内部还会
        // 用同一个 map 然后 delete，所以这里只 get、不 delete。
        const toolName = block.tool_use_id
          ? internal.toolUseNames.get(block.tool_use_id)
          : undefined;
        // CHANGELOG_61 A1：tool-use-end status 跨 adapter 统一字段。
        // claude tool_result 含 `is_error: boolean` → 翻为 status='failed' / 'completed'，
        // 与 codex tool-use-end 的 status 对齐。UI ToolEndRow 据此显示红色边框 + ⚠ 徽标。
        // status 字段缺省视作 'completed'（老事件 / 老 hook 兜底）。
        const status: 'completed' | 'failed' = block.is_error ? 'failed' : 'completed';
        e('tool-use-end', {
          toolUseId: block.tool_use_id,
          toolName,
          toolResult: useStructuredToolResult ? msg.tool_use_result : block.content,
          status,
        });
        // plan §Phase 3 Step 3.5 修法 (A1-MED-1 codex): pendingFileChangeIntents 消费时序。
        // status='completed' → emit 之前 push 的 intent + delete;status='failed' 仅 delete
        // (intent 不 emit,避免 SDK 工具 fail 时发出脏 file-changed)。intent 没找到 (typically
        // 图片工具走 maybeEmitImageFileChanged 另一路径,本 Map 不参与) → no-op。
        consumePendingFileChangeIntentCore(e, internal, block.tool_use_id, status);
        // mcp 图片工具结果识别：反查 toolName，匹配则把 result.content 解析后翻译成 file-changed
        // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.8 修法**（M2 codex A1 MED-2）：
        // status 透传给 maybeEmitImageFileChanged，与 Step 3.5 修法对称 — failed 时不 emit
        // file-changed (避免 SDK 图片工具 fail 时发出脏 file-changed,与 Edit/Write/MultiEdit
        // 的 status='failed' 不 emit intent 行为对齐)。
        maybeEmitImageFileChangedCore(e, internal, block.tool_use_id, block.content, status);
      }
    }
  } else if (msg.type === 'result') {
    discardClaudeSubmittingUserMessageCore(internal);
    const r = msg as ClaudeFinalResultUsage & {
      subtype?: string;
      is_error?: boolean;
      result?: string;
      errors?: string[];
      terminal_reason?: string;
    };
    // REVIEW_13 Bug 6 / P17 双通道防护陷阱再撞：result frame 在 expectedClose=true 时
    // 必须**整体静默**，不只 gate 红字 message。REVIEW_11 D'2 修法只 gate 了 message emit
    // 漏了下面 finished emit，结果 approve-bypass 冷切走完后：
    //   - ok=false（r.is_error=true / r.subtype !== 'success'）
    //   - subtype !== 'interrupted'（典型 'error_max_turns' / 'error_during_execution'）
    // 进 routeEventToNotification → notifyUser({title:'Agent 出错',...}) → mac 系统通知
    // 弹「Agent 出错」横幅。OLD CLI 的 result frame 完全是应用主动 abort 的副产品，
    // OLD record 后续会被 renameSdkSession 整体迁到 NEW_ID，OLD 的 finished 既不影响
    // 新 record 状态推进（NEW SDK 自己会发 finished），也不应该污染 dock / 通知 / UI 时间线。
    // 修法：expectedClose 时整段 return，三个通道（红字 / finished UI / 系统通知）一起 skip。
    //
    // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.6 关联**：H1+H2 race 修法
    // (Phase 2.1+2.5) 在 fallback fire / createSession throw catch 双路径 fire-and-forget
    // interrupt()，spike1 case A 实证 SDK 仍 emit result frame subtype='error_during_execution'
    // (替代 success)。本 L159 已 land 的 `if (internal.expectedClose) return;` 覆盖该 result
    // frame 整段静默路径（不需 Phase 2 新增 skip 逻辑，复核确认 expectedClose 已 land 且覆盖
    // result frame 翻译）。
    if (internal.expectedClose) {
      clearClaudeLiveTokenEstimateCore(internal, sessionId, ts, host.liveRate);
      resetTurnUsageAccounting(internal);
      return;
    }
    const fallbackModel = resolveClaudeFallbackModelCore(internal, sessionId, host.state);
    const reconciledUsage = reconcileClaudeFinalResultUsage(e, fallbackModel, r, internal);
    resetTurnUsageAccounting(internal);
    completeClaudeLiveTokenEstimateCore(
      internal,
      sessionId,
      reconciledUsage.outputTokens,
      ts,
      reconciledUsage.liveRateModel,
      host.liveRate,
    );
    const contextWindowPayload = claudeContextWindowPayload(internal, r.modelUsage);
    if (contextWindowPayload !== null) {
      e('context-usage', contextWindowPayload);
    }
    if (r.is_error || (r.subtype && r.subtype !== 'success')) {
      const detail = r.errors?.join('\n') ?? r.result ?? r.subtype ?? 'unknown error';
      e('message', { text: `⚠ ${detail}`, error: true });
    }
    e('finished', claudeFinishedPayload(r));
  } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    const metadata = (msg as {
      compact_metadata?: {
        trigger?: unknown;
        pre_tokens?: unknown;
        post_tokens?: unknown;
        duration_ms?: unknown;
      };
    }).compact_metadata;
    const postTokens =
      typeof metadata?.post_tokens === 'number' &&
      Number.isFinite(metadata.post_tokens) &&
      metadata.post_tokens >= 0
        ? Math.trunc(metadata.post_tokens)
        : null;
    e(
      'context-usage',
      claudeContextUsagePayload(internal, { usedTokens: postTokens }),
    );
    e('message', {
      text: buildClaudeCompactMessageText({
        trigger: metadata?.trigger,
        preTokens: metadata?.pre_tokens,
        postTokens: metadata?.post_tokens,
        durationMs: metadata?.duration_ms,
      }),
      role: 'assistant',
    });
  } else if (
    msg.type === 'system' &&
    (msg.subtype === 'init' || msg.subtype === 'status') &&
    typeof msg.permissionMode === 'string'
  ) {
    // REVIEW_11 Bug 2：SDK 在 init 与 status 上行 frame 里附带的 permissionMode 是 CLI 内部
    // 真实运行态的权威来源。CLI 自己翻 mode（典型：approve ExitPlanMode 后退 plan、resume
    // 时从 jsonl 读出的 mode、外部 settings 改 mode 等）应用层只能靠这两条 frame 知道。
    // 之前直接忽略 → DB 留旧值、不 emit upsert、store 卡旧值、详情面板显示器卡旧值。
    // 修法：白名单校验 → 与 DB 比 → 不同则写 DB + emit upsert（renderer 走原有 listener）。
    //
    // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 3 修法 (H3 D7)**：先同步 internal
    // cache，再走 DB 比对路径。
    //
    // 真根因：旧 impl 仅写 sessionRepo（DB） + emit upsert，**没**同步 internal.permissionMode
    // (canUseTool bypass 短路读 internal.permissionMode 不读 sessionRepo,详 types.ts permissionMode
    // 字段 jsdoc)。SDK 上行 init/status frame 把 mode 改为 bypassPermissions 等关键档位时,
    // canUseTool 仍按旧 cache 的 'default' 走 fail-secure 路径 → 弹 unwanted permission-request
    // (CLI 实际已是 bypass 但应用以为还在 default)。
    //
    // 不变量 2: DB/UI ↔ internal cache 单一源（跨字段约束）— 凡 internal cache 镜像 sessionRepo
    // 字段，任一方向 update 必同时更新两边。本 step 修 permissionMode 路径；其他字段 cache split
    // 风险作为后续 review focus 立项 (cwd / claudeCodeSandbox / extraAllowWrite / model)。
    syncClaudeReportedPermissionModeCore(
      internal,
      sessionId,
      msg.permissionMode,
      host.state,
    );
    const compactFailure = claudeCompactFailureTextCore(
      msg as { compact_result?: unknown; compact_error?: unknown },
    );
    if (compactFailure) e('message', { text: compactFailure, error: true });
  } else if (msg.type === 'system' && msg.subtype === 'status') {
    const compactFailure = claudeCompactFailureTextCore(
      msg as { compact_result?: unknown; compact_error?: unknown },
    );
    if (compactFailure) e('message', { text: compactFailure, error: true });
  } else if (msg.type === 'stream_event') {
    handleClaudeStreamEventForLiveRateCore(
      internal,
      sessionId,
      msg,
      ts,
      host.liveRate,
    );
  }
  // 其他 system subtype 与未知 type 忽略
}
