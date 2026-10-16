// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useWorkRailGestures } from './useWorkRailGestures';

const ids = ['a', 'b', 'c'];
const stopAndDismiss = vi.fn(), dismiss = vi.fn(), reorder = vi.fn();
function Harness({ terminal = false }: { terminal?: boolean }) {
  const [saved, setSaved] = useState(ids);
  const [opened, setOpened] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, string>>({ a: terminal ? 'completed' : 'running' });
  const visible = saved.filter(id => !dismissed.includes(id));
  const work = useWorkRailGestures({ ids: visible,
    onStopAndDismiss: id => { stopAndDismiss(id); setStates(values => ({ ...values, [id]: 'stopped' })); setDismissed(values => [...values, id]); },
    onDismiss: id => { dismiss(id); setDismissed(values => [...values, id]); },
    onReorder: next => { reorder(next); setSaved(next); } });
  return <section><div ref={work.ref} data-testid="rail" style={{ columnGap: '7px' }} {...work.handlers}>
    {(work.order ?? visible).map(id => <div key={id} data-work-id={id} data-dismissible={terminal}>
      <button onClick={() => setOpened(true)}>{id}</button>
    </div>)}
  </div><output data-testid="collapse">{work.collapseVersion}</output><output data-testid="opened">{String(opened)}</output>
    <output data-testid="state-a">{states.a}</output><output data-testid="position">{work.drag && `${work.drag.dx},${work.drag.dy}`}</output>
    <output data-testid="ready">{String(work.drag?.ready ?? false)}</output></section>;
}
const pointer = (x: number, y: number) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y });
function start(terminal = false) {
  const view = render(<Harness terminal={terminal} />), rail = view.getByTestId('rail'), card = view.getByText('a');
  Object.defineProperties(rail, { clientWidth: { value: 900 }, scrollWidth: { value: 1334 } });
  fireEvent.pointerDown(card, pointer(100, 100));
  return { view, rail, card };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { left: 0, top: 76, width: this.dataset.workId ? 440 : 900, height: 48, right: 900, bottom: 124, x: 0, y: 76, toJSON() {} };
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('task-strip gestures', () => {
  it.each([[0, -130], [0, 130], [90, -130], [-160, 10], [900, 10]])('stops and hides running work dropped outside at %s, %s', (dx, dy) => {
    const { rail, view } = start();
    fireEvent.pointerMove(rail, pointer(100 + dx, 100 + dy));
    fireEvent.pointerUp(rail, pointer(100 + dx, 100 + dy));
    expect(stopAndDismiss).toHaveBeenCalledTimes(1); expect(stopAndDismiss).toHaveBeenCalledWith('a'); expect(dismiss).not.toHaveBeenCalled();
    expect(view.getByTestId('state-a').textContent).toBe('stopped'); expect(view.queryByText('a', { selector: 'button' })).toBeNull();
  });
  it.each([-130, 130])('dismisses terminal work on vertical release %s without stopping it', dy => {
    const { rail, view } = start(true);
    fireEvent.pointerMove(rail, pointer(103, 100 + dy));
    fireEvent.pointerUp(rail, pointer(103, 100 + dy));
    expect(dismiss).toHaveBeenCalledTimes(1); expect(dismiss).toHaveBeenCalledWith('a'); expect(stopAndDismiss).not.toHaveBeenCalled();
    expect(view.getByTestId('state-a').textContent).toBe('completed'); expect(view.queryByText('a', { selector: 'button' })).toBeNull();
  });
  it('keeps a short vertical drag reversible', () => {
    const { rail } = start();
    fireEvent.pointerMove(rail, pointer(100, 130)); fireEvent.pointerUp(rail, pointer(100, 130));
    expect(stopAndDismiss).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
  });
  it.each([[false, -104], [false, 104], [true, -104], [true, 104]] as const)(
    'keeps terminal=%s visible at the vertical safety boundary %s', (terminal, dy) => {
      const { rail, view } = start(terminal);
      fireEvent.pointerMove(rail, pointer(110, 100 + dy));
      expect(view.getByTestId('ready').textContent).toBe('false');
      fireEvent.pointerUp(rail, pointer(110, 100 + dy));
      expect(stopAndDismiss).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
      expect(view.queryByText('a', { selector: 'button' })).not.toBeNull();
    });
  it.each([[false, -105], [false, 105], [true, -105], [true, 105]] as const)(
    'closes terminal=%s only after crossing the vertical safety boundary %s', (terminal, dy) => {
      const { rail, view } = start(terminal);
      fireEvent.pointerMove(rail, pointer(110, 100 + dy));
      expect(view.getByTestId('ready').textContent).toBe('true');
      fireEvent.pointerUp(rail, pointer(110, 100 + dy));
      expect(terminal ? dismiss : stopAndDismiss).toHaveBeenCalledWith('a');
      expect(view.queryByText('a', { selector: 'button' })).toBeNull();
    });
  it('previews horizontal sorting, commits on release, and suppresses the drag click', () => {
    const { rail, view, card } = start();
    fireEvent.pointerMove(rail, pointer(600, 136));
    expect(view.getByTestId('position').textContent).toBe('500,36');
    expect([...rail.children].map(node => (node as HTMLElement).dataset.workId)).toEqual(['b', 'a', 'c']);
    expect(reorder).not.toHaveBeenCalled();
    fireEvent.pointerUp(rail, pointer(600, 136)); fireEvent.click(card);
    expect(reorder).toHaveBeenCalledTimes(1); expect(reorder).toHaveBeenCalledWith(['b', 'a', 'c']);
    expect(stopAndDismiss).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
    expect(view.getByTestId('opened').textContent).toBe('false');
    expect(Number(view.getByTestId('collapse').textContent)).toBeGreaterThan(0);
  });
  it('uses the final drop position even when movement starts horizontally', () => {
    const { rail } = start();
    fireEvent.pointerMove(rail, pointer(600, 102)); fireEvent.pointerMove(rail, pointer(600, 220));
    fireEvent.pointerUp(rail, pointer(600, 220));
    expect(reorder).not.toHaveBeenCalled(); expect(stopAndDismiss).toHaveBeenCalledWith('a'); expect(dismiss).not.toHaveBeenCalled();
  });
  it('lets a card return into the strip to sort instead of closing', () => {
    const { rail } = start();
    fireEvent.pointerMove(rail, pointer(200, 220)); fireEvent.pointerMove(rail, pointer(600, 105));
    fireEvent.pointerUp(rail, pointer(600, 105));
    expect(reorder).toHaveBeenCalledWith(['b', 'a', 'c']); expect(stopAndDismiss).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
  });
  it('restores the saved order when a drag is cancelled', () => {
    const { rail } = start();
    fireEvent.pointerMove(rail, pointer(600, 102)); fireEvent.pointerCancel(rail, pointer(600, 102));
    expect([...rail.children].map(node => (node as HTMLElement).dataset.workId)).toEqual(ids);
    expect(reorder).not.toHaveBeenCalled();
  });
  it('requests collapse on strip scrolling and ignores detail scroll events', () => {
    const { rail, card, view } = start();
    fireEvent.scroll(card);
    expect(view.getByTestId('collapse').textContent).toBe('0');
    fireEvent.scroll(rail);
    expect(view.getByTestId('collapse').textContent).toBe('1');
  });
});
