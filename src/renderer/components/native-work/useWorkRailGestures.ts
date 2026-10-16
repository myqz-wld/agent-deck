import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type UIEvent } from 'react';

interface Gesture {
  x: number; y: number; currentX: number; currentY: number; left: number; pointer: number;
  id: string | null; terminal: boolean; started: boolean;
  card: { left: number; top: number; width: number } | null;
  originalOrder: string[]; order: string[]; from: number; to: number; stride: number;
}
interface DragPreview {
  id: string; dx: number; dy: number;
  left: number; top: number; width: number; terminal: boolean; ready: boolean;
}
interface Options {
  ids: string[]; onStopAndDismiss: (id: string) => void; onDismiss: (id: string) => void;
  onReorder: (ids: string[]) => void;
}

/** Cards move freely: dropping inside sorts, dropping outside stops/dismisses. */
export function useWorkRailGestures(options: Options) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(options); latest.current = options;
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<DragPreview | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [collapseVersion, setCollapseVersion] = useState(0);
  const collapse = () => setCollapseVersion(value => value + 1);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || (e.target as Element).closest('[data-no-drag]') || (!e.deltaX && !e.deltaY)) return;
      setCollapseVersion(value => value + 1);
      if (node.scrollWidth <= node.clientWidth) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? node.clientWidth : 1;
      const next = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta * scale));
      if (next !== node.scrollLeft) { e.preventDefault(); node.scrollLeft = next; }
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { node.removeEventListener('wheel', wheel); if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, []);

  const outsideStrip = (active: Gesture, node: HTMLDivElement) => {
    const bounds = node.getBoundingClientRect();
    const horizontalTolerance = 28, verticalTolerance = 80;
    return active.currentX < bounds.left - horizontalTolerance || active.currentX > bounds.right + horizontalTolerance
      || active.currentY < bounds.top - verticalTolerance || active.currentY > bounds.bottom + verticalTolerance;
  };

  const updatePreview = (active: Gesture, node: HTMLDivElement) => {
    const dx = active.currentX - active.x, dy = active.currentY - active.y;
    if (!active.id) { node.scrollLeft = active.left - dx; return; }
    if (!active.id || !active.card) return;
    const ready = outsideStrip(active, node);
    if (!ready) {
      const moved = Math.round((dx + node.scrollLeft - active.left) / active.stride);
      const to = Math.max(0, Math.min(active.originalOrder.length - 1, active.from + moved));
      if (to !== active.to) {
        active.to = to;
        active.order = [...active.originalOrder];
        active.order.splice(active.from, 1); active.order.splice(to, 0, active.id);
        setOrder(active.order);
      }
    }
    setDrag({ id: active.id, dx, dy, ...active.card, terminal: active.terminal, ready });
  };

  const autoScroll = () => {
    frame.current = null;
    const active = gesture.current, node = ref.current;
    if (!active?.started || !active.id || !node) return;
    const bounds = node.getBoundingClientRect();
    const edge = 48;
    const speed = active.currentX < bounds.left + edge
      ? -Math.min(14, (bounds.left + edge - active.currentX) / 3)
      : active.currentX > bounds.right - edge ? Math.min(14, (active.currentX - bounds.right + edge) / 3) : 0;
    if (speed && !outsideStrip(active, node)) {
      const before = node.scrollLeft; node.scrollLeft += speed;
      if (node.scrollLeft !== before) updatePreview(active, node);
    }
    frame.current = requestAnimationFrame(autoScroll);
  };

  const clear = (e: PointerEvent<HTMLDivElement>) => {
    gesture.current = null; setDrag(null); setOrder(null); delete e.currentTarget.dataset.dragging;
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return {
    ref, drag, order, collapseVersion,
    handlers: {
      onScroll(e: UIEvent<HTMLDivElement>) { if (e.target === e.currentTarget) collapse(); },
      onPointerDown(e: PointerEvent<HTMLDivElement>) {
        if (e.button !== 0 || e.pointerType !== 'mouse') return;
        suppressClick.current = false;
        if ((e.target as Element).closest('[data-no-drag]')) return;
        const card = (e.target as Element).closest<HTMLElement>('[data-work-id]');
        const box = card?.getBoundingClientRect(), host = e.currentTarget.parentElement!.getBoundingClientRect();
        const ids = latest.current.ids;
        const from = ids.indexOf(card?.dataset.workId ?? '');
        gesture.current = { x: e.clientX, y: e.clientY, currentX: e.clientX, currentY: e.clientY,
          left: e.currentTarget.scrollLeft, pointer: e.pointerId, id: card?.dataset.workId ?? null,
          terminal: card?.dataset.dismissible === 'true', started: false,
          card: box ? { left: box.left - host.left, top: box.top - host.top, width: box.width } : null,
          originalOrder: [...ids], order: [...ids], from, to: from,
          stride: (box?.width ?? 0) + (parseFloat(getComputedStyle(e.currentTarget).columnGap) || 0) };
      },
      onPointerMove(e: PointerEvent<HTMLDivElement>) {
        const active = gesture.current;
        if (!active || active.pointer !== e.pointerId) return;
        if ((e.buttons & 1) === 0) { clear(e); return; }
        active.currentX = e.clientX; active.currentY = e.clientY;
        const dx = e.clientX - active.x, dy = e.clientY - active.y;
        if (!active.started) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
          active.started = true;
          suppressClick.current = true; collapse();
          e.currentTarget.setPointerCapture(e.pointerId);
          if (active.id) { setOrder(active.order); frame.current = requestAnimationFrame(autoScroll); }
        }
        e.preventDefault(); e.currentTarget.dataset.dragging = active.id ? 'card' : 'scroll';
        updatePreview(active, e.currentTarget);
      },
      onPointerUp(e: PointerEvent<HTMLDivElement>) {
        const active = gesture.current;
        if (active?.pointer !== e.pointerId) return;
        active.currentX = e.clientX; active.currentY = e.clientY;
        if (active.started && active.id) {
          updatePreview(active, e.currentTarget);
          if (outsideStrip(active, e.currentTarget)) {
            if (active.terminal) latest.current.onDismiss(active.id); else latest.current.onStopAndDismiss(active.id);
          } else if (active.to !== active.from) latest.current.onReorder(active.order);
        }
        clear(e);
      },
      onPointerCancel: clear,
      onLostPointerCapture: clear,
      onClickCapture(e: MouseEvent<HTMLDivElement>) {
        if (!suppressClick.current) return;
        e.preventDefault(); e.stopPropagation(); suppressClick.current = false;
      },
    },
  };
}
