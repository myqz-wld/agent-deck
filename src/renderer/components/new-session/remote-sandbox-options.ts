import type { SessionConsoleSandboxChoiceDescriptor } from '@contracts/index';
import type { DeckSelectOption } from '@renderer/components/DeckSelect';
import {
  CLAUDE_SANDBOX_OPTIONS,
  CODEX_APPROVAL_POLICY_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  GROK_SANDBOX_MODE_OPTIONS,
  PERMISSION_OPTIONS,
} from '@renderer/lib/sandbox-options';

const LABELS = new Map<string, DeckSelectOption<string>>([
  ...PERMISSION_OPTIONS,
  ...CODEX_APPROVAL_POLICY_OPTIONS,
  ...CODEX_SANDBOX_OPTIONS,
  ...CLAUDE_SANDBOX_OPTIONS,
  ...GROK_SANDBOX_MODE_OPTIONS,
].map((option) => [option.value, option]));

function sandboxOptionMap(
  options: readonly DeckSelectOption<string>[],
): ReadonlyMap<string, DeckSelectOption<string>> {
  return new Map(options.map((option) => [option.value, option]));
}

const SANDBOX_LABELS: Record<
  'claudeCodeSandbox' | 'codexSandbox' | 'grokSandbox',
  ReadonlyMap<string, DeckSelectOption<string>>
> = {
  claudeCodeSandbox: sandboxOptionMap(CLAUDE_SANDBOX_OPTIONS),
  codexSandbox: sandboxOptionMap(CODEX_SANDBOX_OPTIONS),
  grokSandbox: sandboxOptionMap(GROK_SANDBOX_MODE_OPTIONS),
};

export function closedSessionOptions(
  values: readonly string[],
): DeckSelectOption<string>[] {
  return values.map((value) => LABELS.get(value) ?? { value, label: value });
}

export function remoteSandboxOptions(
  choices: readonly SessionConsoleSandboxChoiceDescriptor[],
  optionKey: 'claudeCodeSandbox' | 'codexSandbox' | 'grokSandbox',
): DeckSelectOption<string>[] {
  return choices.map((choice) => ({
    ...(SANDBOX_LABELS[optionKey].get(choice.value) ?? {
      value: choice.value,
      label: choice.value,
    }),
    ...(choice.effectiveAccess === 'workspace-read-write'
      ? { label: '⚠️ Workspace 内完全开放' }
      : {}),
    disabled: !choice.enabled,
    title: choice.disabledReason ?? description(choice.effectiveAccess, optionKey),
    description: choice.disabledReason ?? description(choice.effectiveAccess, optionKey),
  }));
}

function description(
  access: SessionConsoleSandboxChoiceDescriptor['effectiveAccess'],
  optionKey: 'claudeCodeSandbox' | 'codexSandbox' | 'grokSandbox',
): string {
  if (access === 'workspace-read-write') {
    return '可在 Remote Workspace 内读写；不能访问 Worker 私有目录或主机其他路径。';
  }
  if (access === 'selected-directory-read-write') {
    return optionKey === 'grokSandbox'
      ? '仅能读写当前会话目录；不能读取 Workspace 其他目录、Worker 私有目录或主机路径。'
      : '可读取 Remote Workspace，仅能写入当前会话目录；不能访问 Worker 私有目录或 Workspace 外路径。';
  }
  if (access === 'workspace-read-only') {
    return 'Remote Workspace 只读；不能写入 Workspace 或访问 Worker 私有目录。';
  }
  return '使用运行时原生严格策略，并保留 Remote Workspace 外层边界。';
}
