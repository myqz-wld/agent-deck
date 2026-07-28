import type { JSX } from 'react';
import {
  CODEX_APPROVAL_POLICY_OPTIONS,
  type CodexApprovalPolicyChoice,
} from '@renderer/lib/sandbox-options';
import { DeckSelect } from './DeckSelect';

interface Props {
  id?: string;
  ariaLabel?: string;
  value: CodexApprovalPolicyChoice;
  onChange: (value: CodexApprovalPolicyChoice) => void;
  disabled?: boolean;
  buttonClassName: string;
}

export function CodexApprovalPolicyPicker({
  id,
  ariaLabel,
  value,
  onChange,
  disabled,
  buttonClassName,
}: Props): JSX.Element {
  return (
    <div className="space-y-1">
      <DeckSelect
        id={id}
        ariaLabel={ariaLabel}
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={CODEX_APPROVAL_POLICY_OPTIONS}
        buttonClassName={buttonClassName}
      />
      <p className="text-[10px] leading-snug text-deck-muted/70">
        只控制是否暂停询问，不会扩大沙盒权限；从不询问时，需审批的操作可能直接失败。
      </p>
    </div>
  );
}
