import { useEffect, useRef, useState, type JSX } from 'react';
import { ChevronDownIcon } from '../icons';

interface ProviderOption {
  id: string;
  name?: string;
}

interface Props {
  value: string;
  options: readonly ProviderOption[];
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  emptyMessage?: string;
  onChange: (value: string) => void;
}

/**
 * Choice-only combobox for discovered Claude and Codex Gateway ids.
 * Typing is intentionally disabled: every non-empty selection must come from the native catalog.
 */
export function ProviderCombobox({
  value,
  options,
  disabled = false,
  ariaLabel = '模型网关',
  placeholder = '留空则跟随助手原生配置',
  emptyMessage = '未发现其他可用的模型网关',
  onChange,
}: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectableOptions: readonly ProviderOption[] = [
    { id: '', name: placeholder },
    ...options.filter((option) => option.id !== ''),
  ];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  const choose = (option: ProviderOption): void => {
    onChange(option.id);
    setOpen(false);
  };

  const selectedIndex = Math.max(
    0,
    selectableOptions.findIndex((option) => option.id === value),
  );

  const toggleOpen = (): void => {
    setActiveIndex(selectedIndex);
    setOpen((current) => !current);
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <input
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="none"
        aria-expanded={open}
        value={value}
        readOnly
        onFocus={() => {
          setActiveIndex(selectedIndex);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((index) =>
              Math.min(index + 1, Math.max(0, selectableOptions.length - 1)));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => Math.max(0, index - 1));
          } else if (event.key === 'Enter' && open && selectableOptions[activeIndex]) {
            event.preventDefault();
            choose(selectableOptions[activeIndex]);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        disabled={disabled}
        title={disabled ? value || placeholder : undefined}
        placeholder={placeholder}
        className="no-drag w-full min-w-0 rounded border border-deck-border bg-white/[0.04] px-2 py-1 pr-7 text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
      />
      <button
        type="button"
        aria-label="展开模型网关选项"
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleOpen}
        className="absolute right-0 top-0 flex h-full w-7 items-center justify-center text-deck-muted/70 hover:text-deck-text disabled:opacity-50"
      >
        <ChevronDownIcon
          className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-0.5 max-h-40 overflow-auto rounded-md border border-deck-border/80 bg-deck-bg-strong p-1 text-[11px] shadow-2xl"
        >
          {selectableOptions.map((option, index) => (
            <button
              key={option.id || '__native_gateway__'}
              type="button"
              role="option"
              aria-selected={option.id === value}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
              className={`block w-full rounded px-2 py-1.5 text-left transition ${
                index === activeIndex
                  ? 'bg-white/[0.1] text-deck-text'
                  : 'text-deck-muted hover:bg-white/[0.07] hover:text-deck-text'
              }`}
            >
              <span className="block truncate">{option.name ?? option.id}</span>
              {option.name && option.id && (
                <code className="block truncate text-[9px] text-deck-muted/60">
                  {option.id}
                </code>
              )}
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-deck-muted/70">
              {emptyMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
