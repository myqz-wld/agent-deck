import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export interface SessionContextMenuPosition {
  x: number;
  y: number;
}

export interface SessionContextMenuAction {
  danger?: boolean;
  icon: ReactNode;
  label: string;
  run(): Promise<void> | void;
}

const MENU_MARGIN = 8;
const MENU_WIDTH = 128;
const MENU_ROW_HEIGHT = 30;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function sessionContextMenuPosition(
  requested: SessionContextMenuPosition,
  size: { height: number; width: number },
  viewport: { height: number; width: number },
): SessionContextMenuPosition {
  return {
    x: clamp(requested.x, MENU_MARGIN, Math.max(MENU_MARGIN, viewport.width - size.width - MENU_MARGIN)),
    y: clamp(requested.y, MENU_MARGIN, Math.max(MENU_MARGIN, viewport.height - size.height - MENU_MARGIN)),
  };
}

/** A shared pointer-anchored session menu used by both Live and History cards. */
export function SessionActionsContextMenu({
  actions,
  onClose,
  position,
}: {
  actions: readonly SessionContextMenuAction[];
  onClose(): void;
  position: SessionContextMenuPosition;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState(position);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const next = sessionContextMenuPosition(
      position,
      {
        height: Math.max(bounds.height, actions.length * MENU_ROW_HEIGHT),
        width: Math.max(bounds.width, MENU_WIDTH),
      },
      {
        height: window.innerHeight,
        width: window.innerWidth,
      },
    );
    setPlaced((current) => current.x === next.x && current.y === next.y ? current : next);
  }, [actions.length, position.x, position.y]);

  useLayoutEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="会话操作"
      className="fixed z-50 w-32 overflow-hidden rounded-md border border-white/10 bg-deck-bg-strong shadow-lg"
      style={{ left: placed.x, top: placed.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          className={`block w-full px-3 py-1.5 text-left text-[11px] hover:bg-white/10 ${
            action.danger ? 'text-status-waiting' : ''
          }`}
          onClick={() => {
            onClose();
            void action.run();
          }}
        >
          {action.icon}{action.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
