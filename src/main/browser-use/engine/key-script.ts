/**
 * Background-key fallback.
 *
 * Electron only delivers sendInputEvent to a focused window. Agent Deck browser tabs are hidden by
 * default, so this generated script dispatches keyboard events in the target realm and reproduces
 * the common native defaults that untrusted synthetic events do not receive automatically.
 */

import {
  MAX_OPEN_DOM_SCAN,
  OPEN_DOM_TRAVERSAL,
  OPEN_DOM_VISIBILITY,
  PAGE_STATE,
} from './scripts';

export function pressFallbackScript(domKey: string): string {
  return `(() => {
  var key = ${JSON.stringify(domKey)};
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
  var targetDocument = target.ownerDocument || document;
  var targetView = targetDocument.defaultView || window;
  var KeyboardEventConstructor = targetView.KeyboardEvent || KeyboardEvent;
  var EventConstructor = targetView.Event || Event;
  var init = { key: key, bubbles: true, cancelable: true };
  var allowDefault = target.dispatchEvent(new KeyboardEventConstructor('keydown', init));
  var effect = allowDefault ? 'dispatched' : 'prevented';

  function emitInput() {
    target.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  }

  function emitChange() {
    target.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  }

  function isTextControl() {
    return typeof target.value === 'string'
      && typeof target.selectionStart === 'number'
      && typeof target.selectionEnd === 'number';
  }

  function setTextValue(next, caret) {
    var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target) || {}, 'value');
    if (setter && setter.set) setter.set.call(target, next);
    else target.value = next;
    if (target.setSelectionRange) target.setSelectionRange(caret, caret);
    emitInput();
  }

  function replaceTextSelection(inserted) {
    var value = String(target.value || '');
    var start = target.selectionStart;
    var end = target.selectionEnd;
    setTextValue(value.slice(0, start) + inserted + value.slice(end), start + inserted.length);
    effect = 'inserted';
  }

  function editText(direction) {
    var value = String(target.value || '');
    var start = target.selectionStart;
    var end = target.selectionEnd;
    if (start === end) {
      if (direction < 0 && start > 0) start -= 1;
      if (direction > 0 && end < value.length) end += 1;
    }
    if (start !== end) {
      setTextValue(value.slice(0, start) + value.slice(end), start);
      effect = 'deleted';
    }
  }

  function moveTextCaret(direction) {
    var value = String(target.value || '');
    var start = target.selectionStart;
    var end = target.selectionEnd;
    var caret = start;
    if (direction === 'left') caret = start === end ? Math.max(0, start - 1) : start;
    if (direction === 'right') caret = start === end ? Math.min(value.length, end + 1) : end;
    if (direction === 'home') {
      caret = target.tagName === 'TEXTAREA' ? value.lastIndexOf('\\n', Math.max(0, start - 1)) + 1 : 0;
    }
    if (direction === 'end') {
      var lineEnd = target.tagName === 'TEXTAREA' ? value.indexOf('\\n', end) : -1;
      caret = lineEnd < 0 ? value.length : lineEnd;
    }
    if (direction === 'up') caret = Math.max(0, start - 1);
    if (direction === 'down') caret = Math.min(value.length, end + 1);
    if (direction === 'pageup') caret = 0;
    if (direction === 'pagedown') caret = value.length;
    if (target.setSelectionRange) target.setSelectionRange(caret, caret);
    effect = 'caret-moved';
  }

  function insertEditableText(text) {
    var selection = targetDocument.getSelection && targetDocument.getSelection();
    if (selection && selection.rangeCount > 0) {
      var range = selection.getRangeAt(0);
      if (target.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        var textNode = targetDocument.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        emitInput();
        effect = 'inserted';
        return;
      }
    }
    target.textContent = (target.textContent || '') + text;
    emitInput();
    effect = 'inserted';
  }

  function deleteEditable(direction) {
    var command = direction < 0 ? 'delete' : 'forwardDelete';
    if (targetDocument.execCommand && targetDocument.execCommand(command, false)) {
      emitInput();
      effect = 'deleted';
      return;
    }
    var value = String(target.textContent || '');
    var next = direction < 0 ? value.slice(0, -1) : value.slice(1);
    if (next !== value) {
      target.textContent = next;
      emitInput();
      effect = 'deleted';
    }
  }

  function activateTarget() {
    var role = target.getAttribute && target.getAttribute('role');
    var type = target.getAttribute && target.getAttribute('type');
    if (
      target.tagName === 'BUTTON'
      || target.tagName === 'A'
      || role === 'button'
      || type === 'checkbox'
      || type === 'radio'
      || type === 'button'
      || type === 'submit'
    ) {
      target.click();
      effect = 'activated';
      return true;
    }
    return false;
  }

  function moveSelect(direction) {
    if (target.tagName !== 'SELECT' || !target.options || target.options.length === 0) return false;
    var current = target.selectedIndex < 0 ? 0 : target.selectedIndex;
    var next = current;
    if (direction === 'up' || direction === 'left') next = Math.max(0, current - 1);
    if (direction === 'down' || direction === 'right') {
      next = Math.min(target.options.length - 1, current + 1);
    }
    if (direction === 'home' || direction === 'pageup') next = 0;
    if (direction === 'end' || direction === 'pagedown') next = target.options.length - 1;
    if (next !== current) {
      target.selectedIndex = next;
      emitInput();
      emitChange();
      effect = 'selection-changed';
    }
    return true;
  }

  function moveFocus() {
    var focusable = [];
    walkOpenDom(function (el, frameHosts) {
      if (el.matches && el.matches(FOCUSABLE) && visible(el, frameHosts)) focusable.push(el);
    });
    if (focusable.length === 0) return;
    var index = focusable.indexOf(target);
    var next = focusable[(index + 1) % focusable.length];
    if (next && next.focus) {
      next.focus();
      effect = 'focus-moved';
    }
  }

  function scrollDefault(scrollKey) {
    if (!targetView || !targetView.scrollBy || !targetView.scrollTo) return;
    if (scrollKey === 'Home') targetView.scrollTo(0, 0);
    else if (scrollKey === 'End') {
      targetView.scrollTo(0, targetDocument.body ? targetDocument.body.scrollHeight : 0);
    } else {
      var amount = scrollKey === 'PageUp' || scrollKey === 'PageDown'
        ? Math.max(1, Math.round((targetView.innerHeight || 800) * 0.8))
        : 40;
      var direction = (
        scrollKey === 'ArrowUp' || scrollKey === 'ArrowLeft' || scrollKey === 'PageUp'
      ) ? -1 : 1;
      var horizontal = scrollKey === 'ArrowLeft' || scrollKey === 'ArrowRight';
      targetView.scrollBy(horizontal ? amount * direction : 0, horizontal ? 0 : amount * direction);
    }
    effect = 'scrolled';
  }

  function dismissNativeSurface() {
    var dialogs = targetDocument.querySelectorAll
      ? targetDocument.querySelectorAll('dialog[open]')
      : [];
    var dialog = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
    if (dialog) {
      if (typeof dialog.requestClose === 'function') {
        dialog.requestClose();
      } else {
        var cancelEvent = new EventConstructor('cancel', { cancelable: true });
        if (dialog.dispatchEvent(cancelEvent) && typeof dialog.close === 'function') dialog.close();
      }
      effect = dialog.open ? 'cancel-prevented' : 'dismissed';
      return true;
    }
    if (targetDocument.fullscreenElement && targetDocument.exitFullscreen) {
      targetDocument.exitFullscreen();
      effect = 'fullscreen-exit-requested';
      return true;
    }
    if (targetDocument.pointerLockElement && targetDocument.exitPointerLock) {
      targetDocument.exitPointerLock();
      effect = 'pointer-lock-exited';
      return true;
    }
    return false;
  }

  if (allowDefault) {
    if (key === 'Tab') {
      moveFocus();
    } else if (key === 'Escape') {
      dismissNativeSurface();
    } else if (key === 'Enter') {
      if (target.tagName === 'TEXTAREA') replaceTextSelection('\\n');
      else if (target.isContentEditable === true) insertEditableText('\\n');
      else if (!activateTarget() && target.form && target.form.requestSubmit) {
        target.form.requestSubmit();
        effect = 'submitted';
      }
    } else if (key === 'Backspace' || key === 'Delete') {
      var direction = key === 'Backspace' ? -1 : 1;
      if (isTextControl()) editText(direction);
      else if (target.isContentEditable === true) deleteEditable(direction);
    } else if (
      key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
      || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown'
    ) {
      var directionName = key.toLowerCase().replace('arrow', '');
      if (isTextControl()) moveTextCaret(directionName);
      else if (!moveSelect(directionName)) scrollDefault(key);
    } else if (key === ' ') {
      if (isTextControl()) replaceTextSelection(' ');
      else if (target.isContentEditable === true) insertEditableText(' ');
      else activateTarget();
    } else if (key.length === 1) {
      if (isTextControl()) replaceTextSelection(key);
      else if (target.isContentEditable === true) insertEditableText(key);
    }
  }

  target.dispatchEvent(new KeyboardEventConstructor('keyup', init));
  return JSON.stringify({ pressed: key, effect: effect, page: pageState() });
})()`;
}
