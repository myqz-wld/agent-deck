export const HOOK_FAILURE_COPY = {
  'claude-code': {
    status: 'Claude Code 终端 Hook 状态读取失败，请重试。',
    install: 'Claude Code 终端 Hook 安装失败，请重试。',
    uninstall: 'Claude Code 终端 Hook 卸载失败，请重试。',
  },
  'codex-cli': {
    status: 'Codex CLI 终端 Hook 状态读取失败，请重试。',
    install: 'Codex CLI 终端 Hook 安装失败，请重试。',
    uninstall: 'Codex CLI 终端 Hook 卸载失败，请重试。',
  },
  'grok-build': {
    status: 'Grok Build 终端 Hook 状态读取失败，请重试。',
    install: 'Grok Build 终端 Hook 安装失败，请重试。',
    uninstall: 'Grok Build 终端 Hook 卸载失败，请重试。',
  },
} as const;

export type HookAdapterId = keyof typeof HOOK_FAILURE_COPY;
