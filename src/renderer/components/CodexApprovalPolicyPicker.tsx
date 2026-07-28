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
    <DeckSelect
      id={id}
      ariaLabel={ariaLabel}
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={CODEX_APPROVAL_POLICY_OPTIONS}
      buttonClassName={buttonClassName}
    />
  );
}
