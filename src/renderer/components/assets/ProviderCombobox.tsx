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
 * App-styled free-text combobox for Claude Gateway and Codex model_provider ids.
 *
 * DeckSelect intentionally accepts only a closed value set. Provider ids are user-defined in
 * the provider's config, so this keeps free-text input while replacing the browser-native
 * datalist popup.
 */
export function ProviderCombobox({
  value,
  options,
  disabled = false,
  ariaLabel = 'provider',
  placeholder = '留空则跟随 adapter 原生配置',
  emptyMessage = '没有匹配项，可直接输入自定义 provider',
  onChange,
}: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const normalizedQuery = value.trim().toLocaleLowerCase();
  const filtered = options.filter((option) => {
    if (!normalizedQuery) return true;
    return (
      option.id.toLocaleLowerCase().includes(normalizedQuery) ||
      option.name?.toLocaleLowerCase().includes(normalizedQuery)
    );
  });

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  const choose = (option: ProviderOption): void => {
    onChange(option.id);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        value={value}
        onFocus={() => {
          setActiveIndex(0);
          setOpen(true);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => Math.max(0, index - 1));
          } else if (event.key === 'Enter' && open && filtered[activeIndex]) {
            event.preventDefault();
            choose(filtered[activeIndex]);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        className="no-drag w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 pr-7 text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
      />
      <button
        type="button"
        aria-label="展开 provider 选项"
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
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
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-deck-muted/70">
              {emptyMessage}
            </div>
          ) : (
            filtered.map((option, index) => (
              <button
                key={option.id}
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
                {option.name && (
                  <code className="block truncate text-[9px] text-deck-muted/60">
                    {option.id}
                  </code>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
