import { useEffect, useState, type JSX } from 'react';
import { DeckSelect } from './DeckSelect';
import {
  GROK_SANDBOX_MODE_OPTIONS,
  type GrokSandboxChoice,
} from '@renderer/lib/sandbox-options';
import { isGrokBuiltinSandboxProfile } from '@shared/grok-sandbox';
import type { DeckSelectOption } from './DeckSelect';

const CUSTOM_VALUE = '__agent_deck_custom_grok_sandbox__';

interface Props {
  value: GrokSandboxChoice;
  onChange: (value: GrokSandboxChoice) => void;
  disabled?: boolean;
  allowUnset?: boolean;
  followLabel?: string;
  profileOptions?: readonly DeckSelectOption<string>[];
  buttonClassName?: string;
  ariaLabel?: string;
}

/** Built-in Grok Build profiles plus an editable sandbox.toml configuration name. */
export function GrokSandboxPicker({
  value,
  onChange,
  disabled = false,
  allowUnset = true,
  followLabel = '跟随设置（默认）',
  profileOptions = GROK_SANDBOX_MODE_OPTIONS,
  buttonClassName,
  ariaLabel = 'Grok Build 沙盒请求档位',
}: Props): JSX.Element {
  const valueIsSelectableBuiltin = profileOptions.some((option) => option.value === value);
  const valueIsCustom =
    value !== '' &&
    (!isGrokBuiltinSandboxProfile(value) || !valueIsSelectableBuiltin);
  const [customActive, setCustomActive] = useState(valueIsCustom);

  useEffect(() => {
    if (valueIsCustom) setCustomActive(true);
    else if (value !== '') setCustomActive(false);
  }, [value, valueIsCustom]);

  const selected = customActive
    ? CUSTOM_VALUE
    : value || (allowUnset ? '' : 'workspace');
  const options = [
    ...(allowUnset
      ? [{
          value: '',
          label: followLabel,
          title: '不添加会话级覆盖，使用 Agent Deck 设置或 Grok Build 原生配置',
        }]
      : []),
    ...profileOptions,
    {
      value: CUSTOM_VALUE,
      label: '自定义配置…',
      title: '使用 ~/.grok/sandbox.toml 或项目 .grok/sandbox.toml 中定义的配置名称',
    },
  ];

  return (
    <div className="space-y-1">
      <DeckSelect
        value={selected}
        onChange={(next) => {
          if (next === CUSTOM_VALUE) {
            setCustomActive(true);
          } else {
            setCustomActive(false);
            onChange(next);
          }
        }}
        disabled={disabled}
        options={options}
        buttonClassName={buttonClassName}
        ariaLabel={ariaLabel}
      />
      {customActive && (
        <input
          type="text"
          value={valueIsCustom ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          maxLength={128}
          placeholder="输入自定义 sandbox.toml 配置名称"
          aria-label="Grok Build 自定义沙盒配置名称"
          className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
        />
      )}
    </div>
  );
}
