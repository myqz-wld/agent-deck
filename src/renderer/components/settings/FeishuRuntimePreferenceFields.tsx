import type { JSX } from 'react';
import type { FeishuRuntimeOptionKey, SessionConsoleCreateOptionDescriptor,
  SessionConsoleSandboxDescriptor } from '@contracts/index';
import { ADAPTER_SESSION_MODES } from '@shared/types';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import { CODEX_APPROVAL_POLICY_OPTIONS, PERMISSION_OPTIONS } from '@renderer/lib/sandbox-options';
import { DeckSelect, type DeckSelectOption } from '../DeckSelect';
import { remoteSandboxOptions } from '../new-session/remote-sandbox-options';

const LABELS = { permissionMode: '权限模式', approvalPolicy: '审批策略', sessionMode: '会话模式',
  claudeCodeSandbox: '沙盒', codexSandbox: '沙盒', grokSandbox: '沙盒' } as const;

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
  const selected = value ?? descriptor?.defaultValue ?? '';
  const choices: DeckSelectOption<string>[] = field === sandbox.optionKey
    ? remoteSandboxOptions(sandbox.choices, sandbox.optionKey)
      .filter(option => descriptor?.allowedValues?.includes(option.value))
    : (descriptor?.allowedValues ?? []).map(option => ({ value: option,
      label: nativeLabels.find(item => item.value === option)?.label ?? option }));
  if (selected && !choices.some(option => option.value === selected)) {
    choices.push({ value: selected, label: `${selected}（暂不可用）`, disabled: true });
  }
  return <label className="text-[10px] text-deck-muted">{LABELS[field]}
    <DeckSelect ariaLabel={`${purposeLabel} ${LABELS[field]}`} value={selected} options={choices}
      disabled={disabled || !descriptor?.enabled} onChange={value => onChange(value || null)} />
  </label>;
}
