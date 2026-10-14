import { methods } from '@agentclientprotocol/sdk';
import { grokPermissionPreset, type SessionPermissionMode } from '@shared/permission-modes';
import type { GrokRuntime } from './runtime-types';
import { withTimeout } from './acp-process';

/** Grok's permission notification is process-scoped; each bridge runtime owns one ACP child. */
export async function applyGrokPermissionMode(
  runtime: GrokRuntime,
  mode: SessionPermissionMode,
  timeoutMs = 15_000,
): Promise<void> {
  if (!runtime.process || !runtime.nativeSessionId) throw new Error('Grok 会话尚未就绪。');
  const preset = grokPermissionPreset(mode);
  await withTimeout(runtime.process.connection.agent.notify('_x.ai/yolo_mode_changed', {
    yolo_mode: preset.yoloMode,
    auto_mode: preset.autoMode,
    permission_mode: mode === 'auto' ? 'auto' : 'always-approve',
  }), timeoutMs, 'Grok permission mode notification');
  // Exit a persisted planning/ask work mode before the next prompt. This acknowledged RPC also
  // follows the permission notification on the same ordered ACP transport.
  const controller = new AbortController();
  try {
    await withTimeout(runtime.process.connection.agent.request(methods.agent.session.setMode, {
      sessionId: runtime.nativeSessionId,
      modeId: 'default',
    }, { cancellationSignal: controller.signal }), timeoutMs, 'Grok permission work-mode reset');
  } finally {
    controller.abort();
  }
}
