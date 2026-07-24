/**
 * createSession 拿到 realId 之后的 finalize 链（CHANGELOG_85 Step 3.2）。
 *
 * 抽自 ClaudeSdkBridge.createSession 末段（emit session-start → setClaudeCodeSandbox →
 * emit 首条 user message）。把 realId 之后的固定动作收口到一处，让 facade
 * createSession 主体只关心 try/catch 内的 spawn + waitForRealSessionId 主路径。
 *
 * 行为（保持原 createSession 末段实现等价）：
 * 1. 主动 emit session-start 让 UI 立刻看到这个会话（同步派发到 sessionManager.ingest →
 *    sessionRepo.upsert 创建 record）
 * 2. setClaudeCodeSandbox 持久化 sandbox 档位（紧跟 emit session-start 后跑：record 已建
 *    必然命中。try/catch 兜底：DB 异常不应阻塞会话启动；最坏情况字段没存，下次会话
 *    fallback 到全局默认。与 codex setCodexSandbox 同模式）
 * 3. 如果有 opts.prompt 补 emit 一条 user message（首条 prompt 没走 sendMessage，
 *    直接塞进 pendingUserMessages 给 SDK，UI 活动流要看到「你」发的第一条话）
 */

import type { AgentEvent, HandOffMetadata, UploadedAttachmentRef } from '@shared/types';
import type { ClaudeCodeEffortLevel, InitialSessionRegistration } from '@main/adapters/types';
import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { eventBus } from '@main/event-bus';
import { AGENT_ID } from './constants';
import log from '@main/utils/logger';
import type { TrustedContinuationMetadata } from '@main/session/continuation-context/initial-turn';

const logger = log.scope('claude-finalize');

export interface FinalizeSessionStartArgs {
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S9 R3 HIGH-F + R6 MED-R6-1 修订**:
   * applicationSid 维度 (替代旧 realId 字段语义):spawn 主路径下 internal.applicationSid 已切到
   * realId 后冻结 (S3 isNewSpawn 三分支保护),emit session-start 用 applicationSid 与
   * 现有 emit session-start { sessionId: realId } 行为字面等价 (caller 仍拿 first realId)。
   * resume / fallback 路径下 applicationSid = caller 入参 opts.resume 全程不变。
   *
   * **R6 MED-R6-1 修订**: jsonl-missing fallback 路径（resumeMode='fresh-cli-reuse-app'）**不调**
   * finalizeSessionStart (S8 重写后 fresh fallback 复用 applicationSid 行 + 走
   * sessionManager.updateCliSessionId 黑名单链,不需 emit session-start 创建新 sessions row 撞唯一
   * 索引)。**调本 helper 的路径**:spawn 主路径 + normal resume 路径(create-session-impl.ts:178
   * `if (opts.resumeMode !== 'fresh-cli-reuse-app')` 守门 — normal resume resumeMode 默认
   * 'resume-cli' 也满足该条件;normal resume 走 ensure() revive 既有 row 不撞唯一索引 +
   * recover-and-send-impl.ts 显式传 skipFirstUserEmit=true 防双气泡)。**仅** fresh-cli-reuse-app 跳过。
   */
  applicationSid: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S9**:
   * SDK / CLI 当前 thread sid (= sessions.cli_session_id 列值)。spawn 主路径下 = realId
   * (与 applicationSid 同款 first realId 维度);如反向 rename 后 caller 显式传不同值,
   * 本 helper 内部 sessionRepo.updateCliSessionId(applicationSid, cliSessionId) 写库。
   * undefined → 跳过 cli_session_id 写库 (与 R6 MED-R6-1 修订 fresh fallback 路径不调本 helper 对应)。
   */
  cliSessionId?: string;
  cwd: string;
  prompt?: string;
  claudeSandboxMode: 'off' | 'workspace-write' | 'strict';
  /** Claude Gateway profile id; undefined keeps an existing persisted value. */
  runtimeProvider?: string;
  /**
   * plan model-wiring-and-handoff-20260514 Step 2.2：resolveClaudeModel 算出的 effective model。
   * undefined → 不持久化（保留 sessions.model 原值，resume 路径下保持原 model）；
   * 非 undefined → setModel 写入，让 dormant 唤醒 / SDK 重启 resume 仍用此 model。
   */
  claudeModel?: string;
  claudeCodeEffortLevel?: ClaudeCodeEffortLevel;
  /**
   * plan cross-adapter-parity-20260515 Phase A Step A.4 / REVIEW_40 R1 reviewer-codex MED-F:
   * caller 透传的 SDK sandbox 额外可写根。原 createSession 收 opts.extraAllowWrite 后仅
   * transient 注入 buildSandboxOptions(spawn 时一次性);本字段让 finalize 链 setExtraAllowWrite
   * 持久化到 sessions.extra_allow_write,recoverer fallback / resume 路径读回交还 SDK。
   * undefined / 空数组 → 不持久化(保留 sessions.extra_allow_write 原值,与 claudeModel 同款)。
   */
  extraAllowWrite?: readonly string[];
  /**
   * plan handoff-render-and-image-batch-20260521 Phase 3:createSession 首条 user message 的
   * 图片附件(spawn-time 透传,与 sendMessage 接口对齐)。漏传时 events.payload 不含 attachments
   * → message-row UploadedImageThumb 不渲染缩略图(create session 带图后看不到图 UX bug)。
   */
  attachments?: readonly UploadedAttachmentRef[];
  /**
   * plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 8 步 internal plumbing:
   * hand-off cold-start prompt metadata。spawn 主路径首条 user message emit 时 spread 进
   * events.payload,renderer 端 message-row 据此渲染 Hand-off badge + 折叠 adoptedBlock
   * disclosure。详 HandOffMetadata jsdoc(shared/types/session.ts) + plan §不变量 5+6。
   * **不变量 5 重申**:claude-code adapter 仅本 finalize × 1 emit 携带 handOff,其他路径
   * (sendMessage 后续 user message / fallback fresh CLI 路径)不携带。
   */
  handOff?: HandOffMetadata;
  continuationMetadata?: TrustedContinuationMetadata | null;
  /**
   * REVIEW_58 HIGH ✅ (deep-review 双方共识真问题修法):跳过本 finalize 内 emit 首条 user
   * message。详 sdk-bridge/index.ts createSession opts.skipFirstUserEmit jsdoc。
   *
   * **触发场景**:recoverer.recoverAndSend 入口已 emit user message 与 live 主路径
   * `sendMessage if(s)` 路径对称(避免双气泡),调 createThunk 时显式传 true 让 finalize 跳过 emit。
   *
   * **不影响其他 finalize 副作用** — 仅控制 emit user message 这一动作。emit session-start /
   * updateCliSessionId / setClaudeCodeSandbox / setModel / setExtraAllowWrite 都不动。
   */
  skipFirstUserEmit?: boolean;
  /**
   * New-session fast return can emit a temporary session-start before the SDK reports its real id.
   * After temp→real rename, finalize still persists metadata but must not emit a duplicate start.
   */
  skipSessionStartEmit?: boolean;
  initialSessionRegistration?: InitialSessionRegistration;
  emit: (e: AgentEvent) => void;
}

/**
 * createSession 在 streamProcessor.waitForRealSessionId 拿到 realId 后跑的 finalize 链。
 * 顺序与原 createSession 末段 100% 一致。
 *
 * **plan reverse-rename-sid-stability-20260520 §A.4-pre S9 R3 HIGH-F + R6 MED-R6-1 修订**:
 * 函数签名 realId 改为 applicationSid + cliSessionId 双入参 (语义双轨化)。spawn 主路径下
 * caller 传 internal.applicationSid (已切到 first realId 后冻结) + cliSessionId=realId,
 * emit session-start { sessionId: applicationSid } 与现有 emit session-start { sessionId: realId }
 * 行为字面等价 (S3 isNewSpawn 修订让 applicationSid === realId in spawn 路径)。
 *
 * **不调本 helper 的路径** (R6 MED-R6-1 修订):
 * - jsonl-missing fallback (resumeMode='fresh-cli-reuse-app', S8 重写后): fresh fallback 路径只调
 *   sessionManager.updateCliSessionId (manager 黑名单链),不创建新 sessions row 不 emit session-start
 *   (避免撞唯一索引)
 *
 * **调本 helper 的路径**: spawn 主路径 + normal resume 路径 (create-session-impl.ts:178 守门条件
 * `opts.resumeMode !== 'fresh-cli-reuse-app'` — normal resume resumeMode 默认 'resume-cli' 满足;
 * normal resume 走 ensure() revive 既有 row + caller 传 skipFirstUserEmit=true 防双气泡)。
 */
export function finalizeSessionStart(args: FinalizeSessionStartArgs): void {
  const {
    applicationSid,
    cliSessionId,
    cwd,
    prompt,
    claudeSandboxMode,
    runtimeProvider,
    claudeModel,
    claudeCodeEffortLevel,
    extraAllowWrite,
    attachments,
    handOff,
    continuationMetadata,
    skipFirstUserEmit,
    skipSessionStartEmit,
    initialSessionRegistration,
    emit,
  } = args;

  // 1. 主动 emit session-start
  if (!skipSessionStartEmit) {
    emit({
      sessionId: applicationSid,
      agentId: AGENT_ID,
      kind: 'session-start',
      payload: {
        cwd,
        source: 'sdk',
        ...(initialSessionRegistration
          ? { initialSpawnLink: initialSessionRegistration.spawnLink }
          : {}),
        ...(initialSessionRegistration?.hiddenFromHistory
          ? { initialHiddenFromHistory: true }
          : {}),
      },
      ts: Date.now(),
      source: 'sdk',
    });
    initialSessionRegistration?.onRegistered(applicationSid);
  }

  // 1b. **plan reverse-rename-sid-stability-20260520 §A.4-pre S9**: 写 cli_session_id 列。
  // spawn 主路径下 cliSessionId === applicationSid (S3 isNewSpawn 后两者同 first realId 值);
  // resume 路径下 cliSessionId 可能 != applicationSid (反向 rename 后场景,但本 helper
  // resume 路径不调,见上 jsdoc)。
  // ensure() 默认行为 (manager.ts:191 新建 row 时 cli_session_id 默认 NULL) 由本 helper
  // 显式 setCliSessionId 兜底覆盖,确保新 row 走 SDK 主路径时 cli_session_id 列填正确 realId。
  // R2 reviewer-claude MED 修法:统一走 sessionManager.updateCliSessionId wrapper(manager.ts:619-625
  // jsdoc 已列 6 处反向 rename 路径全走 wrapper 是契约层硬约束)。spawn 主路径下 oldCliSid ===
  // applicationSid === newCliSessionId,wrapper 内 L632 `oldCliSid !== newCliSessionId` 判断不
  // 写黑名单(语义等价直调 sessionRepo)。统一 wrapper 路径让黑名单链 SSOT 不被绕过,防御未来
  // fork 路径 / caller 误传不同 cliSessionId 时静默跳过黑名单写入。
  if (cliSessionId !== undefined) {
    try {
      sessionManager.updateCliSessionId(applicationSid, cliSessionId);
    } catch (err) {
      logger.warn(
        `[claude-bridge] updateCliSessionId(${applicationSid}, ${cliSessionId}) 失败`,
        err,
      );
    }
  }

  // 2. CHANGELOG_74：持久化 sandbox 档位（紧跟 emit session-start，record 已建必然命中）
  try {
    sessionRepo.setClaudeCodeSandbox(applicationSid, claudeSandboxMode);
  } catch (err) {
    logger.warn(
      `[claude-bridge] setClaudeCodeSandbox(${applicationSid}, ${claudeSandboxMode}) 失败`,
      err,
    );
  }

  if (runtimeProvider !== undefined) {
    try {
      sessionRepo.setRuntimeProvider(applicationSid, runtimeProvider);
    } catch (err) {
      logger.warn(
        `[claude-bridge] setRuntimeProvider(${applicationSid}, ${runtimeProvider}) 失败`,
        err,
      );
    }
  }

  // 2b. plan model-wiring-and-handoff-20260514 Step 2.2：持久化 model（与 sandbox 同位置同模式）。
  if (claudeModel !== undefined) {
    try {
      sessionRepo.setModel(applicationSid, claudeModel);
    } catch (err) {
      logger.warn(`[claude-bridge] setModel(${applicationSid}, ${claudeModel}) 失败`, err);
    }
  }

  if (claudeCodeEffortLevel !== undefined) {
    try {
      sessionRepo.setThinking(applicationSid, claudeCodeEffortLevel);
    } catch (err) {
      logger.warn(
        `[claude-bridge] setThinking(${applicationSid}, ${claudeCodeEffortLevel}) 失败`,
        err,
      );
    }
  }

  // 2c. plan cross-adapter-parity-20260515 Phase A Step A.4 / REVIEW_40 R1 MED-F:持久化
  // SDK sandbox 额外可写根(与 sandbox + model 同位置同模式)。
  if (extraAllowWrite !== undefined && extraAllowWrite.length > 0) {
    try {
      sessionRepo.setExtraAllowWrite(applicationSid, [...extraAllowWrite]);
    } catch (err) {
      logger.warn(
        `[claude-bridge] setExtraAllowWrite(${applicationSid}, [${extraAllowWrite.join(', ')}]) 失败`,
        err,
      );
    }
  }

  try {
    const updated = sessionRepo.get(applicationSid);
    if (updated) eventBus.emit('session-upserted', updated);
  } catch (err) {
    logger.warn(`[claude-bridge] emit session-upserted after finalize(${applicationSid}) 失败`, err);
  }

  // 3. 补 emit 首条 user message（覆盖新建会话 + 恢复会话两条路径）
  // REVIEW_58 HIGH ✅ 收口修法:caller 显式 skipFirstUserEmit=true 时跳过
  // (recoverer.recoverAndSend 入口已 emit,避免双气泡;详 args.skipFirstUserEmit jsdoc)
  if (prompt && !skipFirstUserEmit) {
    emit({
      sessionId: applicationSid,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text: prompt,
        role: 'user',
        ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
        ...(handOff ? { handOff } : {}),
        ...(continuationMetadata
          ? {
              messageOrigin: 'continuation',
              continuation: { ...continuationMetadata },
            }
          : {}),
      },
      ts: Date.now(),
      source: 'sdk',
    });
  }
}
