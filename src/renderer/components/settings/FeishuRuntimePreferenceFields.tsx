import type { JSX } from 'react';
import type { FeishuRuntimeOptionKey, SessionConsoleCreateOptionDescriptor,
  SessionConsoleSandboxDescriptor } from '@contracts/index';
import { ADAPTER_SESSION_MODES } from '@shared/types';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import { CODEX_APPROVAL_POLICY_OPTIONS, PERMISSION_OPTIONS } from '@renderer/lib/sandbox-options';
import { DeckSelect } from '../DeckSelect';

const LABELS = { permissionMode: '权限模式', approvalPolicy: '审批策略', sessionMode: '会话模式',
  claudeCodeSandbox: '沙盒', codexSandbox: '沙盒', grokSandbox: '沙盒' } as const;
const ACCESS = { 'provider-strict': '严格限制', 'selected-directory-read-write': '工作目录可写',
  'workspace-read-only': 'Workspace 只读', 'workspace-read-write': 'Workspace 可写' } as const;

export function FeishuRuntimePreferenceFields({ field, purposeLabel, value, descriptor, sandbox, disabled, onChange }: {
  field: FeishuRuntimeOptionKey;
  purposeLabel: string;
  value: string | null;
  descriptor: SessionConsoleCreateOptionDescriptor | undefined;
  sandbox: SessionConsoleSandboxDescriptor;
  disabled: boolean;
  onChange(value: string | null): void;
}): JSX.Element {
  const nativeLabels: ReadonlyArray<{ value: string; label: string }> = field === 'permissionMode' ? PERMISSION_OPTIONS
    : field === 'approvalPolicy' ? CODEX_APPROVAL_POLICY_OPTIONS
      : field === 'sessionMode' ? adapterSessionModeOptions(ADAPTER_SESSION_MODES) : [];
  const label = (option: string): string => {
    const choice = field === sandbox.optionKey ? sandbox.choices.find(item => item.value === option) : null;
    return choice ? `${ACCESS[choice.effectiveAccess]} · ${option}`
      : nativeLabels.find(item => item.value === option)?.label ?? option;
  };
  const choices = [{ value: '', label: `跟随新建默认值${descriptor?.defaultValue ? `（${label(descriptor.defaultValue)}）` : ''}`, disabled: false },
    ...(descriptor?.allowedValues ?? []).map(option => ({ value: option, label: label(option), disabled: false }))];
  if (value && !choices.some(option => option.value === value)) {
    choices.push({ value, label: `${value}（暂不可用）`, disabled: true });
  }
  return <label className="text-[10px] text-deck-muted">{LABELS[field]}
    <DeckSelect ariaLabel={`${purposeLabel} ${LABELS[field]}`} value={value ?? ''} options={choices}
      disabled={disabled || !descriptor?.enabled} onChange={value => onChange(value || null)} />
  </label>;
}
