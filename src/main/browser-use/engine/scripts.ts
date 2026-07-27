/**
 * Injected page scripts for semantic browser actions.
 *
 * These strings run inside the page through `webContents.executeJavaScript`, so they must be
 * self-contained, side-effect-light, and free of TypeScript-only syntax. Every script returns a
 * JSON string; structured results are parsed on the main-process side.
 *
 * Element references (`ref`) are handed to agents instead of selectors. A ref is
 * `<generation>-<index>` and is only valid for the snapshot that produced it, which is what makes a
 * stale ref a clear error instead of a silent mis-click.
 */

const REF_STATE_KEY = '__agentDeckBrowserRefs__';
const MAX_OPEN_DOM_SCAN = 20_000;

const REF_LOOKUP = `
  var state = window['${REF_STATE_KEY}'];
  if (!state) throw new Error('NO_SNAPSHOT');
  var parts = String(ref).split('-');
  var gen = Number(parts[0]);
  var index = Number(parts[1]);
  if (!state.gen || gen !== state.gen) throw new Error('STALE_REF');
  var el = state.els[index - 1];
  if (!el) throw new Error('STALE_REF');
  if (!el.isConnected) throw new Error('DETACHED_REF');
  var frameHosts = (state.frameHosts && state.frameHosts[index - 1]) || [];
  for (var hostIndex = 0; hostIndex < frameHosts.length; hostIndex += 1) {
    if (!frameHosts[hostIndex] || !frameHosts[hostIndex].isConnected) {
      throw new Error('DETACHED_REF');
    }
  }
`;

const OPEN_DOM_VISIBILITY = `
  function ownVisible(node) {
    if (!node || !node.isConnected || !node.getBoundingClientRect) return false;
    var rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var view = node.ownerDocument && node.ownerDocument.defaultView;
    var style = view && view.getComputedStyle ? view.getComputedStyle(node) : null;
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  }
  function visible(node, frameHosts) {
    if (!ownVisible(node)) return false;
    for (var hostIndex = 0; hostIndex < frameHosts.length; hostIndex += 1) {
      if (!ownVisible(frameHosts[hostIndex])) return false;
    }
    return true;
  }
`;

const OPEN_DOM_TRAVERSAL = `
  function walkOpenDom(onElement, onDocument) {
    var coverage = {
      documents: 0,
      sameOriginFrames: 0,
      inaccessibleFrames: 0,
      openShadowRoots: 0,
      scannedElements: 0,
      scanLimitReached: false,
    };
    var seenRoots = new Set();
    var stopped = false;

    function visitRoot(root, frameHosts, shadowDepth) {
      if (!root || stopped || seenRoots.has(root)) return;
      seenRoots.add(root);
      var isDocument = root.nodeType === 9;
      var ownerDocument = isDocument ? root : root.ownerDocument;
      if (!ownerDocument || !ownerDocument.createTreeWalker) return;
      if (isDocument) {
        coverage.documents += 1;
        if (onDocument) onDocument(root);
      }

      var walker = ownerDocument.createTreeWalker(root, 1);
      var node = walker.nextNode();
      while (node && !stopped) {
        if (coverage.scannedElements >= MAX_SCAN_NODES) {
          coverage.scanLimitReached = true;
          stopped = true;
          break;
        }
        coverage.scannedElements += 1;
        onElement(node, frameHosts, shadowDepth);

        if (node.shadowRoot) {
          coverage.openShadowRoots += 1;
          visitRoot(node.shadowRoot, frameHosts, shadowDepth + 1);
        }
        if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
          try {
            var childDocument = node.contentDocument;
            if (childDocument && childDocument.documentElement) {
              coverage.sameOriginFrames += 1;
              visitRoot(childDocument, frameHosts.concat([node]), shadowDepth);
            } else {
              coverage.inaccessibleFrames += 1;
            }
          } catch (_error) {
            coverage.inaccessibleFrames += 1;
          }
        }
        node = walker.nextNode();
      }
    }

    visitRoot(document, [], 0);
    return coverage;
  }
`;

const SCROLL_REF_TARGET = `
  function scrollRefTarget(target, frameHosts) {
    for (var hostIndex = 0; hostIndex < frameHosts.length; hostIndex += 1) {
      var host = frameHosts[hostIndex];
      if (host && host.scrollIntoView) {
        host.scrollIntoView({ block: 'center', inline: 'center' });
      }
    }
    if (target.scrollIntoView) {
      target.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }
`;

const DESCRIBE_ELEMENT = `
  function describe(node) {
    var text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
    return {
      tag: node.tagName ? node.tagName.toLowerCase() : 'unknown',
      name: (node.getAttribute && node.getAttribute('aria-label')) || text.slice(0, 120) || undefined,
      value: typeof node.value === 'string' ? node.value.slice(0, 200) : undefined,
    };
  }
`;

const PAGE_STATE = `
  function pageState() {
    return { url: location.href, title: document.title };
  }
`;

export function snapshotScript(options: {
  limit: number;
  includeText: boolean;
  textLimit: number;
}): string {
  return `(() => {
  var LIMIT = ${options.limit};
  var INCLUDE_TEXT = ${options.includeText ? 'true' : 'false'};
  var TEXT_LIMIT = ${options.textLimit};
  var MAX_SCAN_NODES = ${MAX_OPEN_DOM_SCAN};
  var state = window['${REF_STATE_KEY}'] || (window['${REF_STATE_KEY}'] = { gen: 0, els: [], frameHosts: [] });
  state.gen = (state.gen || 0) + 1;
  state.els = [];
  state.frameHosts = [];
  var SELECTOR = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="textbox"],[contenteditable="true"],[onclick]';
  ${OPEN_DOM_VISIBILITY}
  ${OPEN_DOM_TRAVERSAL}
  function label(el) {
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return String(aria).trim().slice(0, 120);
    if (el.labels && el.labels[0] && el.labels[0].innerText) {
      return String(el.labels[0].innerText).replace(/\\s+/g, ' ').trim().slice(0, 120);
    }
    var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 120);
    var fallback = el.placeholder || el.title || (el.getAttribute && el.getAttribute('alt')) || el.name || '';
    return String(fallback).trim().slice(0, 120);
  }
  var elements = [];
  var eligibleElementCount = 0;
  var textParts = [];
  var textLength = 0;
  var coverage = walkOpenDom(function (el, frameHosts, shadowDepth) {
    if (!el.matches || !el.matches(SELECTOR) || !visible(el, frameHosts)) return;
    eligibleElementCount += 1;
    if (elements.length >= LIMIT) return;
    state.els.push(el);
    state.frameHosts.push(frameHosts.slice());
    elements.push({
      ref: state.gen + '-' + state.els.length,
      tag: el.tagName ? el.tagName.toLowerCase() : 'unknown',
      type: el.getAttribute && el.getAttribute('type') ? el.getAttribute('type') : undefined,
      role: el.getAttribute && el.getAttribute('role') ? el.getAttribute('role') : undefined,
      name: label(el),
      value: typeof el.value === 'string' ? el.value.slice(0, 120) : undefined,
      checked: el.type === 'checkbox' || el.type === 'radio' ? !!el.checked : undefined,
      disabled: el.disabled === true ? true : undefined,
      href: el.tagName === 'A' && el.getAttribute ? el.getAttribute('href') || undefined : undefined,
      frameDepth: frameHosts.length || undefined,
      shadowDepth: shadowDepth || undefined,
    });
  }, function (childDocument) {
    if (!INCLUDE_TEXT || textLength >= TEXT_LIMIT || !childDocument.body) return;
    var text = String(childDocument.body.innerText || childDocument.body.textContent || '')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
    if (!text) return;
    var separator = textParts.length > 0 ? '\\n\\n' : '';
    var remaining = TEXT_LIMIT - textLength;
    var part = (separator + text).slice(0, remaining);
    textParts.push(part);
    textLength += part.length;
  });
  return JSON.stringify({
    refGeneration: state.gen,
    url: location.href,
    title: document.title,
    elementCount: elements.length,
    eligibleElementCount: eligibleElementCount,
    truncated: eligibleElementCount > elements.length || coverage.scanLimitReached,
    elements: elements,
    coverage: coverage,
    text: INCLUDE_TEXT ? textParts.join('') : undefined,
  });
})()`;
}

export function clickScript(ref: string): string {
  return `(() => {
  var ref = ${JSON.stringify(ref)};
  ${REF_LOOKUP}
  ${DESCRIBE_ELEMENT}
  ${PAGE_STATE}
  ${SCROLL_REF_TARGET}
  scrollRefTarget(el, frameHosts);
  if (el.focus) el.focus();
  var target = describe(el);
  el.click();
  return JSON.stringify({ clicked: target, frameDepth: frameHosts.length, page: pageState() });
})()`;
}

export function typeScript(ref: string, text: string, clear: boolean): string {
  return `(() => {
  var ref = ${JSON.stringify(ref)};
  var value = ${JSON.stringify(text)};
  var clear = ${clear ? 'true' : 'false'};
  ${REF_LOOKUP}
  ${DESCRIBE_ELEMENT}
  ${PAGE_STATE}
  ${SCROLL_REF_TARGET}
  scrollRefTarget(el, frameHosts);
  if (el.focus) el.focus();
  var editable = el.isContentEditable === true;
  if (editable) {
    if (clear) el.textContent = '';
    el.textContent = (el.textContent || '') + value;
  } else {
    var next = clear ? value : String(el.value == null ? '' : el.value) + value;
    var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) || {}, 'value');
    if (setter && setter.set) setter.set.call(el, next);
    else el.value = next;
  }
  var view = el.ownerDocument && el.ownerDocument.defaultView;
  var EventConstructor = view && view.Event ? view.Event : Event;
  el.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  el.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  return JSON.stringify({ typedInto: describe(el), frameDepth: frameHosts.length, page: pageState() });
})()`;
}

/**
 * Key press for tabs that cannot take synthesized input events, which is every background tab:
 * Electron delivers `sendInputEvent` only to a focused window.
 *
 * Dispatching a `KeyboardEvent` alone is not enough because untrusted events carry no default
 * behavior, so Enter would never submit and Tab would never move focus. The native effects are
 * therefore reproduced explicitly, and skipped when the page called `preventDefault`, which mirrors
 * what a real key press would do.
 */
export function pressFallbackScript(key: string): string {
  return `(() => {
  var key = ${JSON.stringify(key)};
  var MAX_SCAN_NODES = ${MAX_OPEN_DOM_SCAN};
  ${PAGE_STATE}
  ${OPEN_DOM_VISIBILITY}
  ${OPEN_DOM_TRAVERSAL}
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  function deepActiveElement(rootDocument) {
    var active = rootDocument.activeElement || rootDocument.body;
    var depth = 0;
    while (active && depth < 32) {
      var next = null;
      if (active.shadowRoot && active.shadowRoot.activeElement) {
        next = active.shadowRoot.activeElement;
      } else if (active.tagName === 'IFRAME' || active.tagName === 'FRAME') {
        try {
          var childDocument = active.contentDocument;
          next = childDocument && (childDocument.activeElement || childDocument.body);
        } catch (_error) {
          next = null;
        }
      }
      if (!next || next === active) break;
      active = next;
      depth += 1;
    }
    return active || rootDocument.body;
  }
  var target = deepActiveElement(document);
  var targetView = target.ownerDocument && target.ownerDocument.defaultView;
  var KeyboardEventConstructor =
    targetView && targetView.KeyboardEvent ? targetView.KeyboardEvent : KeyboardEvent;
  var EventConstructor = targetView && targetView.Event ? targetView.Event : Event;
  var init = { key: key, bubbles: true, cancelable: true };
  var allowDefault = target.dispatchEvent(new KeyboardEventConstructor('keydown', init));
  var effect = 'dispatched';

  if (allowDefault && key.length === 1) {
    if (target.isContentEditable === true) {
      target.textContent = (target.textContent || '') + key;
      target.dispatchEvent(new EventConstructor('input', { bubbles: true }));
      effect = 'inserted';
    } else if (typeof target.value === 'string') {
      var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target) || {}, 'value');
      var next = target.value + key;
      if (setter && setter.set) setter.set.call(target, next);
      else target.value = next;
      target.dispatchEvent(new EventConstructor('input', { bubbles: true }));
      effect = 'inserted';
    }
  } else if (allowDefault && key === 'Enter') {
    if (target.form && target.form.requestSubmit) {
      target.form.requestSubmit();
      effect = 'submitted';
    } else if (
      target.tagName === 'BUTTON'
      || target.tagName === 'A'
      || (target.getAttribute && target.getAttribute('role') === 'button')
    ) {
      target.click();
      effect = 'activated';
    }
  } else if (allowDefault && key === 'Tab') {
    var focusable = [];
    walkOpenDom(function (el, frameHosts) {
      if (el.matches && el.matches(FOCUSABLE) && visible(el, frameHosts)) {
        focusable.push(el);
      }
    });
    if (focusable.length > 0) {
      var index = focusable.indexOf(target);
      var next = focusable[(index + 1) % focusable.length];
      if (next && next.focus) {
        next.focus();
        effect = 'focus-moved';
      }
    }
  }

  target.dispatchEvent(new KeyboardEventConstructor('keyup', init));
  return JSON.stringify({ pressed: key, effect: effect, page: pageState() });
})()`;
}

export function scrollScript(options: {
  ref?: string;
  to?: 'top' | 'bottom';
  dx: number;
  dy: number;
}): string {
  return `(() => {
  var ref = ${options.ref == null ? 'null' : JSON.stringify(options.ref)};
  var to = ${options.to == null ? 'null' : JSON.stringify(options.to)};
  var dx = ${options.dx};
  var dy = ${options.dy};
  ${PAGE_STATE}
  if (ref) {
    ${REF_LOOKUP}
    ${SCROLL_REF_TARGET}
    scrollRefTarget(el, frameHosts);
  } else if (to === 'top') {
    window.scrollTo(0, 0);
  } else if (to === 'bottom') {
    window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
  } else {
    window.scrollBy(dx, dy);
  }
  return JSON.stringify({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    frameDepth: ref ? frameHosts.length : 0,
    page: pageState(),
  });
})()`;
}

export function evaluateScript(expression: string): string {
  return `(async () => {
  var result = await (${expression});
  var type = typeof result;
  if (result === undefined) return JSON.stringify({ type: 'undefined' });
  if (result === null) return JSON.stringify({ type: 'null', value: null });
  if (type === 'function') return JSON.stringify({ type: 'function', value: String(result).slice(0, 400) });
  if (result instanceof Element) {
    return JSON.stringify({ type: 'element', value: result.outerHTML.slice(0, 2000) });
  }
  try {
    return JSON.stringify({ type: type, value: result });
  } catch (err) {
    return JSON.stringify({ type: type, value: String(result).slice(0, 2000), note: 'value was not JSON serializable' });
  }
})()`;
}

export function selectorProbeScript(selector: string): string {
  return `(() => {
  var selector = ${JSON.stringify(selector)};
  var MAX_SCAN_NODES = ${MAX_OPEN_DOM_SCAN};
  try {
    document.createDocumentFragment().querySelector(selector);
  } catch (error) {
    throw new Error('INVALID_SELECTOR:' + (error && error.message ? error.message : String(error)));
  }
  ${OPEN_DOM_VISIBILITY}
  ${OPEN_DOM_TRAVERSAL}
  var count = 0;
  var visibleCount = 0;
  var coverage = walkOpenDom(function (el, frameHosts) {
    if (!el.matches || !el.matches(selector)) return;
    count += 1;
    if (visible(el, frameHosts)) visibleCount += 1;
  });
  return JSON.stringify({ count: count, visibleCount: visibleCount, coverage: coverage });
})()`;
}
