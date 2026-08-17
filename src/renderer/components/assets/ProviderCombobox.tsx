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
  allowCustom?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  emptyMessage?: string;
  onChange: (value: string) => void;
}

/**
 * App-styled combobox for Claude and Codex Gateway ids.
 * Local callers keep free-text entry; Remote callers use the same presentation with a Core-owned
 * closed option set so an unadvertised provider can never become a mutation value.
 */
export function ProviderCombobox({
  value,
  options,
  disabled = false,
  allowCustom = true,
  ariaLabel = '模型网关',
  placeholder = '留空则跟随助手原生配置',
  emptyMessage = '没有匹配项，可直接输入自定义模型网关',
  onChange,
}: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [closedQuery, setClosedQuery] = useState('');
  const normalizedQuery = (allowCustom ? value : closedQuery).trim().toLocaleLowerCase();
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
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpen(false);
        setClosedQuery('');
      }
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  const choose = (option: ProviderOption): void => {
    onChange(option.id);
    setOpen(false);
    setClosedQuery('');
  };

  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));
  const displayedValue = allowCustom || !open ? value : closedQuery;

  const toggleOpen = (): void => {
    setActiveIndex(allowCustom ? 0 : selectedIndex);
    setClosedQuery(value);
    setOpen((current) => !current);
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <input
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        value={displayedValue}
        onFocus={() => {
          setActiveIndex(allowCustom ? 0 : selectedIndex);
          if (!allowCustom) setClosedQuery(value);
          setOpen(true);
        }}
        onChange={(event) => {
          if (allowCustom) onChange(event.target.value);
          else setClosedQuery(event.target.value);
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
            setClosedQuery(value);
          }
        }}
        disabled={disabled}
        title={disabled ? value || placeholder : undefined}
        placeholder={placeholder}
        className="no-drag w-full min-w-0 rounded border border-deck-border bg-white/[0.04] px-2 py-1 pr-7 text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
      />
      <button
        type="button"
        aria-label="展开配置选项"
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
