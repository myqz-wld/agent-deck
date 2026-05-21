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

import type { AgentEvent } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { AGENT_ID } from './constants';

export interface FinalizeSessionStartArgs {
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S9 R3 HIGH-F + R6 MED-R6-1 修订**:
   * applicationSid 维度 (替代旧 realId 字段语义):spawn 主路径下 internal.applicationSid 已切到
   * realId 后冻结 (S3 isNewSpawn 三分支保护),emit session-start 用 applicationSid 与
   * 现有 emit session-start { sessionId: realId } 行为字面等价 (caller 仍拿 first realId)。
   * resume / fallback 路径下 applicationSid = caller 入参 opts.resume 全程不变。
   *
   * **R6 MED-R6-1 修订**: jsonl-missing fallback 路径**不调** finalizeSessionStart (S8 重写后
   * fresh fallback 复用 applicationSid 行 + 走 sessionManager.updateCliSessionId 黑名单链,不需
   * emit session-start 创建新 sessions row 撞唯一索引)。仅 spawn 主路径调本 helper。
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
  /**
   * plan model-wiring-and-handoff-20260514 Step 2.2：resolveClaudeModel 算出的 effective model。
   * undefined → 不持久化（保留 sessions.model 原值，resume 路径下保持原 model）；
   * 非 undefined → setModel 写入，让 dormant 唤醒 / SDK 重启 resume 仍用此 model。
   */
  claudeModel?: string;
  /**
   * plan cross-adapter-parity-20260515 Phase A Step A.4 / REVIEW_40 R1 reviewer-codex MED-F:
   * caller 透传的 SDK sandbox 额外可写根。原 createSession 收 opts.extraAllowWrite 后仅
   * transient 注入 buildSandboxOptions(spawn 时一次性);本字段让 finalize 链 setExtraAllowWrite
   * 持久化到 sessions.extra_allow_write,recoverer fallback / resume 路径读回交还 SDK。
   * undefined / 空数组 → 不持久化(保留 sessions.extra_allow_write 原值,与 claudeModel 同款)。
   */
  extraAllowWrite?: readonly string[];
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
 * - jsonl-missing fallback (S8 重写后): fresh fallback 路径只调 sessionManager.updateCliSessionId
 *   (manager 黑名单链),不创建新 sessions row 不 emit session-start (避免撞唯一索引)
 */
export function finalizeSessionStart(args: FinalizeSessionStartArgs): void {
  const { applicationSid, cliSessionId, cwd, prompt, claudeSandboxMode, claudeModel, extraAllowWrite, emit } = args;

  // 1. 主动 emit session-start
  emit({
    sessionId: applicationSid,
    agentId: AGENT_ID,
    kind: 'session-start',
    payload: { cwd, source: 'sdk' },
    ts: Date.now(),
    source: 'sdk',
  });

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
      console.warn(
        `[claude-bridge] updateCliSessionId(${applicationSid}, ${cliSessionId}) 失败`,
        err,
      );
    }
  }

  // 2. CHANGELOG_74：持久化 sandbox 档位（紧跟 emit session-start，record 已建必然命中）
  try {
    sessionRepo.setClaudeCodeSandbox(applicationSid, claudeSandboxMode);
  } catch (err) {
    console.warn(
      `[claude-bridge] setClaudeCodeSandbox(${applicationSid}, ${claudeSandboxMode}) 失败`,
      err,
    );
  }

  // 2b. plan model-wiring-and-handoff-20260514 Step 2.2：持久化 model（与 sandbox 同位置同模式）。
  if (claudeModel !== undefined) {
    try {
      sessionRepo.setModel(applicationSid, claudeModel);
    } catch (err) {
      console.warn(`[claude-bridge] setModel(${applicationSid}, ${claudeModel}) 失败`, err);
    }
  }

  // 2c. plan cross-adapter-parity-20260515 Phase A Step A.4 / REVIEW_40 R1 MED-F:持久化
  // SDK sandbox 额外可写根(与 sandbox + model 同位置同模式)。
  if (extraAllowWrite !== undefined && extraAllowWrite.length > 0) {
    try {
      sessionRepo.setExtraAllowWrite(applicationSid, [...extraAllowWrite]);
    } catch (err) {
      console.warn(
        `[claude-bridge] setExtraAllowWrite(${applicationSid}, [${extraAllowWrite.join(', ')}]) 失败`,
        err,
      );
    }
  }

  // 3. 补 emit 首条 user message（覆盖新建会话 + 恢复会话两条路径）
  if (prompt) {
    emit({
      sessionId: applicationSid,
      agentId: AGENT_ID,
      kind: 'message',
      payload: { text: prompt, role: 'user' },
      ts: Date.now(),
      source: 'sdk',
    });
  }
}
