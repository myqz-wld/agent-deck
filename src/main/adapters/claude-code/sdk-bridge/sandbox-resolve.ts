/**
 * Claude SDK sandbox mode 解析（CHANGELOG_85 Step 3.2）。
 *
 * 抽自 ClaudeSdkBridge.createSession 内 sandbox mode 计算段（原 ~13 行 + 注释）。
 * 把 fallback 链统一收口，让 facade createSession 用一行 `resolveClaudeSandboxMode(opts)`
 * 拿到 effective sandbox mode。
 *
 * fallback 链（CHANGELOG_74）：
 * 1. opts.claudeCodeSandbox（NewSessionDialog / ComposerSdk 显式传入）
 * 2. resume 路径下 sessionRepo.claudeCodeSandbox（重启应用 resume 历史会话还原）
 * 3. settings 全局默认（settingsStore 'claudeCodeSandbox'）
 * 4. 'off' 兜底
 *
 * 与 codex codexSandbox 字面镜像（详 codex-cli/sdk-bridge/index.ts:resolveCodexSandbox）。
 */

import { sessionRepo } from '@main/store/session-repo';
import { settingsStore } from '@main/store/settings-store';

export type ClaudeSandboxMode = 'off' | 'workspace-write' | 'strict';

export function resolveClaudeSandboxMode(opts: {
  resume?: string;
  claudeCodeSandbox?: ClaudeSandboxMode;
}): ClaudeSandboxMode {
  const persisted: ClaudeSandboxMode | null = opts.resume
    ? (sessionRepo.get(opts.resume)?.claudeCodeSandbox ?? null)
    : null;
  return (
    opts.claudeCodeSandbox ??
    persisted ??
    settingsStore.get('claudeCodeSandbox') ??
    'off'
  );
}
