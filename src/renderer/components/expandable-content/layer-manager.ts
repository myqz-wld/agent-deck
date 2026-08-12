interface Layer {
  token: symbol;
  root: HTMLElement;
}

interface ElementIsolationState {
  ariaHidden: string | null;
  inert: boolean;
}

let layers: Layer[] = [];
let originalIsolationState = new Map<HTMLElement, ElementIsolationState>();
const listeners = new Set<() => void>();
let mountedHeavyView: symbol | null = null;

function rememberElement(element: HTMLElement): void {
  if (originalIsolationState.has(element)) return;
  originalIsolationState.set(element, {
    ariaHidden: element.getAttribute('aria-hidden'),
    inert: element.inert,
  });
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
  for (const [element, state] of originalIsolationState) restoreElement(element, state);
  originalIsolationState = new Map();
  const topRoot = layers.at(-1)?.root;
  if (!topRoot) return;

  // A modal may be rendered inside the application root rather than through a
  // body-level portal. Preserve the ancestor path that contains the modal and
  // isolate every sibling along that path. This keeps the dialog reachable
  // while preventing the rest of the application from receiving focus.
  let current: HTMLElement | null = topRoot;
  while (current?.parentElement) {
    const parent: HTMLElement = current.parentElement;
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === current) continue;
      rememberElement(sibling);
      sibling.inert = true;
      sibling.setAttribute('aria-hidden', 'true');
    }
    if (parent === document.body) break;
    current = parent;
  }
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
