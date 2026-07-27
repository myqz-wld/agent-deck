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
  var state = window['${REF_STATE_KEY}'] || (window['${REF_STATE_KEY}'] = { gen: 0, els: [] });
  state.gen = (state.gen || 0) + 1;
  state.els = [];
  var SELECTOR = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="textbox"],[contenteditable="true"],[onclick]';
  function visible(el) {
    if (!el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = window.getComputedStyle(el);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  }
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
  var candidates = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
  var elements = [];
  for (var i = 0; i < candidates.length; i += 1) {
    if (elements.length >= LIMIT) break;
    var el = candidates[i];
    if (!visible(el)) continue;
    state.els.push(el);
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
    });
  }
  var body = document.body;
  return JSON.stringify({
    refGeneration: state.gen,
    url: location.href,
    title: document.title,
    elementCount: elements.length,
    truncated: candidates.length > elements.length,
    elements: elements,
    text: INCLUDE_TEXT && body ? String(body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, TEXT_LIMIT) : undefined,
  });
})()`;
}

export function clickScript(ref: string): string {
  return `(() => {
  var ref = ${JSON.stringify(ref)};
  ${REF_LOOKUP}
  ${DESCRIBE_ELEMENT}
  ${PAGE_STATE}
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
  if (el.focus) el.focus();
  var target = describe(el);
  el.click();
  return JSON.stringify({ clicked: target, page: pageState() });
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
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
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
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ typedInto: describe(el), page: pageState() });
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
  ${PAGE_STATE}
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  var target = document.activeElement || document.body;
  var init = { key: key, bubbles: true, cancelable: true };
  var allowDefault = target.dispatchEvent(new KeyboardEvent('keydown', init));
  var effect = 'dispatched';

  if (allowDefault && key.length === 1) {
    if (target.isContentEditable === true) {
      target.textContent = (target.textContent || '') + key;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      effect = 'inserted';
    } else if (typeof target.value === 'string') {
      var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target) || {}, 'value');
      var next = target.value + key;
      if (setter && setter.set) setter.set.call(target, next);
      else target.value = next;
      target.dispatchEvent(new Event('input', { bubbles: true }));
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
    var focusable = Array.prototype.slice.call(document.querySelectorAll(FOCUSABLE)).filter(
      function (el) {
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
    );
    if (focusable.length > 0) {
      var index = focusable.indexOf(target);
      var next = focusable[(index + 1) % focusable.length];
      if (next && next.focus) {
        next.focus();
        effect = 'focus-moved';
      }
    }
  }

  target.dispatchEvent(new KeyboardEvent('keyup', init));
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
    var state = window['${REF_STATE_KEY}'];
    if (!state) throw new Error('NO_SNAPSHOT');
    var parts = String(ref).split('-');
    if (Number(parts[0]) !== state.gen) throw new Error('STALE_REF');
    var el = state.els[Number(parts[1]) - 1];
    if (!el || !el.isConnected) throw new Error('STALE_REF');
    el.scrollIntoView({ block: 'center', inline: 'center' });
  } else if (to === 'top') {
    window.scrollTo(0, 0);
  } else if (to === 'bottom') {
    window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
  } else {
    window.scrollBy(dx, dy);
  }
  return JSON.stringify({ scrollX: window.scrollX, scrollY: window.scrollY, page: pageState() });
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
  var matches;
  try {
    matches = Array.prototype.slice.call(document.querySelectorAll(selector));
  } catch (error) {
    throw new Error('INVALID_SELECTOR:' + (error && error.message ? error.message : String(error)));
  }
  function visible(el) {
    if (!el || !el.isConnected || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    var style = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  }
  var visibleCount = matches.filter(visible).length;
  return JSON.stringify({ count: matches.length, visibleCount: visibleCount });
})()`;
}
