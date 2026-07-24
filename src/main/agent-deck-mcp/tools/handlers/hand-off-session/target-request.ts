import type { HandOffTargetRequest } from '@main/session/hand-off/target-resolver';
import type { SessionAdapterId } from '@shared/types';

import type { HandOffSessionArgs } from '../../schemas';

export function buildHandOffTargetRequest(
  args: HandOffSessionArgs,
  adapter: SessionAdapterId,
  cwd: string,
): HandOffTargetRequest {
  return {
    adapter,
    cwd,
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.thinking !== undefined ? { thinking: args.thinking } : {}),
    ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
    ...(args.sessionMode !== undefined ? { sessionMode: args.sessionMode } : {}),
    ...(args.codexSandbox !== undefined ? { codexSandbox: args.codexSandbox } : {}),
    ...(args.claudeCodeSandbox !== undefined
      ? { claudeCodeSandbox: args.claudeCodeSandbox }
      : {}),
    ...(args.extraAllowWrite !== undefined ? { extraAllowWrite: args.extraAllowWrite } : {}),
  };
}
