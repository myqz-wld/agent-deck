interface Layer {
  token: symbol;
  root: HTMLElement;
}

interface ElementIsolationState {
  ariaHidden: string | null;
  inert: boolean;
}

let layers: Layer[] = [];
let originalBodyState = new Map<HTMLElement, ElementIsolationState>();
const listeners = new Set<() => void>();
let mountedHeavyView: symbol | null = null;

function rememberBodyChildren(): void {
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement) || originalBodyState.has(element)) continue;
    originalBodyState.set(element, {
      ariaHidden: element.getAttribute('aria-hidden'),
      inert: element.inert,
    });
  }
}

function restoreElement(
  element: HTMLElement,
  state: ElementIsolationState | undefined,
): void {
  if (!state) {
    element.inert = false;
    element.removeAttribute('aria-hidden');
    return;
  }
  element.inert = state.inert;
  if (state.ariaHidden === null) element.removeAttribute('aria-hidden');
  else element.setAttribute('aria-hidden', state.ariaHidden);
}

function synchronizeDocumentIsolation(): void {
  rememberBodyChildren();
  const topRoot = layers.at(-1)?.root;
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement)) continue;
    if (topRoot && element === topRoot) {
      restoreElement(element, originalBodyState.get(element));
    } else if (topRoot) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    } else {
      restoreElement(element, originalBodyState.get(element));
    }
  }
  if (!topRoot) originalBodyState = new Map();
}

function notify(): void {
  synchronizeDocumentIsolation();
  for (const listener of listeners) listener();
}

export function registerExpandableLayer(token: symbol, root: HTMLElement): () => void {
  layers = [...layers.filter((layer) => layer.token !== token), { token, root }];
  notify();
  return () => {
    const next = layers.filter((layer) => layer.token !== token);
    if (next.length === layers.length) return;
    layers = next;
    notify();
  };
}

export function isTopExpandableLayer(token: symbol): boolean {
  return layers.at(-1)?.token === token;
}

export function subscribeExpandableLayers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerHeavyView(token: symbol): () => number {
  if (mountedHeavyView && mountedHeavyView !== token) {
    throw new Error('ExpandableContent permits only one mounted heavy view.');
  }
  mountedHeavyView = token;
  return () => {
    if (mountedHeavyView === token) mountedHeavyView = null;
    return mountedHeavyView ? 1 : 0;
  };
}

export function mountedHeavyViewCount(): number {
  return mountedHeavyView ? 1 : 0;
}
