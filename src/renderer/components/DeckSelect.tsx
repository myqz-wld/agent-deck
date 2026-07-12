import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon } from './icons';

export interface DeckSelectOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  description?: ReactNode;
  disabled?: boolean;
}

interface DeckSelectProps<T extends string> {
  id?: string;
  value: T;
  options: readonly DeckSelectOption<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  menuMinWidth?: number;
  title?: string;
  ariaLabel?: string;
}

interface MenuStyle {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'up' | 'down';
}

const DEFAULT_BUTTON_CLASS =
  'w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50';
const MENU_GAP = 0;
const VIEWPORT_PADDING = 8;

function estimateMenuHeight<T extends string>(options: readonly DeckSelectOption<T>[]): number {
  if (options.length === 0) return 34;
  const menuPadding = 8;
  return (
    menuPadding +
    options.reduce((total, option) => total + (option.description ? 46 : 30), 0)
  );
}

export function DeckSelect<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled = false,
  className = 'w-full',
  buttonClassName = DEFAULT_BUTTON_CLASS,
  menuMinWidth = 160,
  title,
  ariaLabel,
}: DeckSelectProps<T>): JSX.Element {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<MenuStyle | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex] ?? options[0];

  const updateMenuGeometry = (): void => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const preferredMaxHeight = 260;
    const estimatedHeight = Math.min(preferredMaxHeight, estimateMenuHeight(options));
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING - MENU_GAP;
    const spaceAbove = rect.top - VIEWPORT_PADDING - MENU_GAP;
    const openUp = spaceBelow < 150 && spaceAbove > spaceBelow;
    const available = Math.max(120, openUp ? spaceAbove : spaceBelow);
    const maxHeight = Math.min(estimatedHeight, available);
    const width = Math.max(rect.width, menuMinWidth);
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
    const left = Math.min(Math.max(VIEWPORT_PADDING, rect.left), maxLeft);
    const top = openUp
      ? Math.max(VIEWPORT_PADDING, rect.top - MENU_GAP - maxHeight)
      : Math.min(rect.bottom + MENU_GAP, window.innerHeight - VIEWPORT_PADDING - maxHeight);
    setMenuStyle({ left, top, width, maxHeight, placement: openUp ? 'up' : 'down' });
  };

  const openMenu = (): void => {
    if (disabled) return;
    setActiveIndex(selectedIndex);
    updateMenuGeometry();
    setOpen(true);
  };

  const closeMenu = (): void => {
    setOpen(false);
  };

  const selectOption = (option: DeckSelectOption<T>): void => {
    if (option.disabled) return;
    onChange(option.value);
    closeMenu();
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const moveActive = (direction: 1 | -1): void => {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let i = 0; i < options.length; i++) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setActiveIndex(next);
  };

  useEffect(() => {
    if (!open) return;
    updateMenuGeometry();
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onViewportChange = (): void => updateMenuGeometry();
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
    // open lifecycle only; geometry reads from refs and latest selected index on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !menuStyle || menuStyle.placement !== 'up') return;
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const nextTop = Math.max(VIEWPORT_PADDING, rect.top - MENU_GAP - menuRect.height);
    if (Math.abs(nextTop - menuStyle.top) > 0.5) {
      setMenuStyle({ ...menuStyle, top: nextTop });
    }
  }, [open, menuStyle]);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={buttonRef}
        id={selectId}
        type="button"
        disabled={disabled}
        title={title ?? selected?.title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${selectId}-menu`}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!open) openMenu();
            else moveActive(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) openMenu();
            else moveActive(-1);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!open) {
              openMenu();
              return;
            }
            const option = options[activeIndex];
            if (option) selectOption(option);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu();
          }
        }}
        className={`no-drag relative min-w-0 ${buttonClassName} pr-6`}
      >
        <span className="block truncate">{selected?.label ?? ''}</span>
        <span
          className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-deck-muted/70 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        >
          <ChevronDownIcon className="h-3 w-3" />
        </span>
      </button>
      {open && menuStyle
        ? createPortal(
            <div
              ref={menuRef}
              id={`${selectId}-menu`}
              role="listbox"
              style={{
                left: menuStyle.left,
                top: menuStyle.top,
                width: menuStyle.width,
                maxHeight: menuStyle.maxHeight,
              }}
              className="fixed z-[1000] overflow-auto scrollbar-deck rounded-md border border-deck-border/80 bg-deck-bg-strong p-1 text-[11px] text-deck-text shadow-2xl backdrop-blur-xl"
            >
              {options.length === 0 ? (
                <div className="px-2 py-1.5 text-deck-muted/70">暂无选项</div>
              ) : (
                options.map((option, index) => {
                  const selectedOption = option.value === value;
                  const active = index === activeIndex;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={selectedOption}
                      disabled={option.disabled}
                      title={option.title}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectOption(option)}
                      className={`block w-full rounded px-2 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${
                        selectedOption
                          ? 'bg-white/[0.13] text-deck-text'
                          : active
                            ? 'bg-white/[0.08] text-deck-text'
                            : 'text-deck-muted hover:bg-white/[0.07] hover:text-deck-text'
                      }`}
                    >
                      <span className="block truncate">{option.label}</span>
                      {option.description && (
                        <span className="mt-0.5 block text-[10px] leading-snug text-deck-muted/70">
                          {option.description}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
