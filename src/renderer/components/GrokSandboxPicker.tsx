import { useEffect, useState, type JSX } from 'react';
import { DeckSelect } from './DeckSelect';
import {
  GROK_SANDBOX_MODE_OPTIONS,
  type GrokSandboxChoice,
} from '@renderer/lib/sandbox-options';
import { isGrokBuiltinSandboxProfile } from '@shared/grok-sandbox';

const CUSTOM_VALUE = '__agent_deck_custom_grok_sandbox__';

interface Props {
  value: GrokSandboxChoice;
  onChange: (value: GrokSandboxChoice) => void;
  disabled?: boolean;
  followLabel?: string;
  buttonClassName?: string;
  ariaLabel?: string;
}

/** Built-in Grok profiles plus an editable custom sandbox.toml profile name. */
export function GrokSandboxPicker({
  value,
  onChange,
  disabled = false,
  followLabel = '跟随设置（默认）',
  buttonClassName,
  ariaLabel = 'Grok 沙盒请求档位',
}: Props): JSX.Element {
  const valueIsCustom = value !== '' && !isGrokBuiltinSandboxProfile(value);
  const [customActive, setCustomActive] = useState(valueIsCustom);

  useEffect(() => {
    if (valueIsCustom) setCustomActive(true);
    else if (value !== '') setCustomActive(false);
  }, [value, valueIsCustom]);

  const selected = customActive ? CUSTOM_VALUE : value;
  const options = [
    {
      value: '',
      label: followLabel,
      title: '不添加会话级覆盖，使用 Agent Deck 设置或 Grok 原生配置',
    },
    ...GROK_SANDBOX_MODE_OPTIONS,
    {
      value: CUSTOM_VALUE,
      label: '自定义 profile…',
      title: '使用 ~/.grok/sandbox.toml 或项目 .grok/sandbox.toml 中定义的名称',
    },
  ];

  return (
    <div className="space-y-1">
      <DeckSelect
        value={selected}
        onChange={(next) => {
          if (next === CUSTOM_VALUE) {
            setCustomActive(true);
            if (!valueIsCustom) onChange('');
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
          placeholder="输入自定义 sandbox profile 名"
          aria-label="Grok 自定义沙盒 profile"
          className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
        />
      )}
    </div>
  );
}
