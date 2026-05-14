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
import { AGENT_ID } from './constants';

export interface FinalizeSessionStartArgs {
  realId: string;
  cwd: string;
  prompt?: string;
  claudeSandboxMode: 'off' | 'workspace-write' | 'strict';
  /**
   * plan model-wiring-and-handoff-20260514 Step 2.2：resolveClaudeModel 算出的 effective model。
   * undefined → 不持久化（保留 sessions.model 原值，resume 路径下保持原 model）；
   * 非 undefined → setModel 写入，让 dormant 唤醒 / SDK 重启 resume 仍用此 model。
   */
  claudeModel?: string;
  emit: (e: AgentEvent) => void;
}

/**
 * createSession 在 streamProcessor.waitForRealSessionId 拿到 realId 后跑的 finalize 链。
 * 顺序与原 createSession 末段 100% 一致。
 */
export function finalizeSessionStart(args: FinalizeSessionStartArgs): void {
  const { realId, cwd, prompt, claudeSandboxMode, claudeModel, emit } = args;

  // 1. 主动 emit session-start
  emit({
    sessionId: realId,
    agentId: AGENT_ID,
    kind: 'session-start',
    payload: { cwd, source: 'sdk' },
    ts: Date.now(),
    source: 'sdk',
  });

  // 2. CHANGELOG_74：持久化 sandbox 档位（紧跟 emit session-start，record 已建必然命中）
  try {
    sessionRepo.setClaudeCodeSandbox(realId, claudeSandboxMode);
  } catch (err) {
    console.warn(
      `[claude-bridge] setClaudeCodeSandbox(${realId}, ${claudeSandboxMode}) 失败`,
      err,
    );
  }

  // 2b. plan model-wiring-and-handoff-20260514 Step 2.2：持久化 model（与 sandbox 同位置同模式）。
  // claudeModel undefined → 跳过（resume 路径下 sessionRepo.model 已存 → 保留原值；
  // 新建未传 model 的会话 → 字段保持 NULL，SDK 跑默认 model）。
  // 非 undefined → setModel 写入，让 dormant 唤醒 / SDK 重启 resume 仍用此 model。
  if (claudeModel !== undefined) {
    try {
      sessionRepo.setModel(realId, claudeModel);
    } catch (err) {
      console.warn(`[claude-bridge] setModel(${realId}, ${claudeModel}) 失败`, err);
    }
  }

  // 3. 补 emit 首条 user message（覆盖新建会话 + 恢复会话两条路径）
  if (prompt) {
    emit({
      sessionId: realId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: { text: prompt, role: 'user' },
      ts: Date.now(),
      source: 'sdk',
    });
  }
}
