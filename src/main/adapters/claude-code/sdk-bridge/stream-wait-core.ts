import type { AgentEvent } from '@shared/types';
import type { InternalSession } from './types';

export const CLAUDE_FIRST_MESSAGE_TIMEOUT_MS = 30_000;

export interface ClaudeStreamWaitContext {
  readonly sessions: Map<string, InternalSession>;
  readonly emit: (event: AgentEvent) => void;
}

export interface ClaudeStreamWaitHost {
  readonly agentId: string;
  now(): number;
  warn(message: string, error?: unknown): void;
}

export type ConsumeClaudeStreamForId = (
  onFirstId: (sessionId: string) => void,
) => Promise<string | null>;

/** Race provider consumption against the bounded first-message startup fallback. */
export function waitForClaudeStreamIdCore(
  ctx: ClaudeStreamWaitContext,
  internal: InternalSession,
  tempKey: string,
  resumeId: string | undefined,
  consume: ConsumeClaudeStreamForId,
  host: ClaudeStreamWaitHost,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let resolved = false;
    const fallback = setTimeout(() => {
      if (resolved) return;
      if (!internal.interruptFired) {
        internal.expectedClose = true;
        internal.interruptFired = true;
        void internal.query?.interrupt?.().catch((error: unknown) => {
          host.warn('[sdk-bridge] interrupt during setTimeout fallback failed:', error);
        });
      }
      resolved = true;
      const fallbackId = resumeId ?? tempKey;
      host.warn(`[sdk-bridge] no SDKMessage in 30s, falling back to id ${fallbackId}`);
      internal.cliSessionId = fallbackId;
      if (!resumeId) internal.applicationSid = fallbackId;
      if (tempKey !== fallbackId) {
        ctx.sessions.delete(tempKey);
        ctx.sessions.set(fallbackId, internal);
      }
      ctx.emit({
        sessionId: fallbackId,
        agentId: host.agentId,
        kind: 'message',
        payload: {
          text:
            '⚠ SDK 30 秒内未收到任何消息。可能原因：SDK 启动失败 / 鉴权错误 / 代理超限 / 模型不可用。' +
            '请检查 `~/.claude/.credentials.json` 是否存在且有效，或在终端运行 `claude -p "hi"` 验证。',
          error: true,
        },
        ts: host.now(),
        source: 'sdk',
      });
      resolve(fallbackId);
    }, CLAUDE_FIRST_MESSAGE_TIMEOUT_MS);

    void (async () => {
      const realId = await consume((id) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(fallback);
        resolve(id);
      });
      if (!resolved) {
        clearTimeout(fallback);
        resolved = true;
        resolve(realId ?? tempKey);
      }
    })();
  });
}
