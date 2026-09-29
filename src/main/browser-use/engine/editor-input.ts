import type { EngineTab } from './tab';
import { REF_LOOKUP } from './scripts';

type RunScript = <T>(tab: EngineTab, script: string, options?: { userGesture?: boolean }) => Promise<T>;
const typingTabs = new WeakSet<EngineTab>();

export async function withTyping<T>(tab: EngineTab, action: () => Promise<T>): Promise<T> {
  if (typingTabs.has(tab)) throw new Error('此页面的输入操作尚未完成，请等待后重试。');
  typingTabs.add(tab);
  try { return await action(); } finally { typingTabs.delete(tab); }
}

export function editorInputGuardScript(ref: string, focus: boolean): string {
  return `(() => {
    try {
    var ref = ${JSON.stringify(ref)};
    ${REF_LOOKUP}
    var owner = document;
    for (var i = 0; i < frameHosts.length; i += 1) {
      if (frameHosts[i].ownerDocument !== owner) throw new Error('DETACHED_REF');
      owner = frameHosts[i].contentDocument;
    }
    if (el.ownerDocument !== owner) throw new Error('DETACHED_REF');
    if (el.tagName !== 'TEXTAREA' || !el.closest('.monaco-editor') || el.disabled || el.readOnly
      || el.getAttribute('aria-readonly') === 'true') {
      throw new Error('该编辑器不可输入，请重新获取快照并检查编辑权限。');
    }
    ${focus ? 'el.focus();' : ''}
    var targets = frameHosts.concat([el]);
    for (var j = 0; j < targets.length; j += 1) {
      if (targets[j].getRootNode().activeElement !== targets[j]) {
        throw new Error('编辑器焦点已改变，输入已停止。请重新获取快照。');
      }
    }
    return null;
    } catch (error) { return String(error && error.message || error); }
  })()`;
}

/** Use the target document's editor handlers; renderer focus emulation never raises the app. */
export async function typeEditorText(
  tab: EngineTab,
  ref: string,
  text: string,
  clear: boolean,
  runScript: RunScript,
  submit = false,
): Promise<void> {
  const mac = process.platform === 'darwin';
  let error: string | null;
  try {
    await tab.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    error = await runScript<string | null>(tab, `(async () => {
    try {
      var error = ${editorInputGuardScript(ref, true)};
      if (error) return error;
      var ref = ${JSON.stringify(ref)};
      ${REF_LOOKUP}
      var view = el.ownerDocument.defaultView;
      function guard() {
        var error = ${editorInputGuardScript(ref, false)};
        if (error) throw new Error(error);
      }
      function key(value, code, keyCode, command) {
        guard();
        var options = { key: value, code: code, keyCode: keyCode, which: keyCode,
          metaKey: command && ${mac}, ctrlKey: command && ${!mac},
          bubbles: true, cancelable: true, composed: true };
        var event = new view.KeyboardEvent('keydown', options);
        el.dispatchEvent(event);
        el.dispatchEvent(new view.KeyboardEvent('keyup', options));
        return event.defaultPrevented;
      }
      async function paste(value) {
        guard();
        var data = new view.DataTransfer();
        data.setData('text/plain', value);
        var event = new view.ClipboardEvent('paste', {
          clipboardData: data, bubbles: true, cancelable: true, composed: true
        });
        el.dispatchEvent(event);
        if (!event.defaultPrevented) throw new Error('编辑器未处理粘贴输入，请检查编辑权限。');
        // Monaco's paste providers settle asynchronously. Keep renderer focus until their
        // edit runs, and do not cancel that edit with a subsequent Enter/paste operation.
        await new Promise(function (resolve) { view.setTimeout(resolve, 120); });
        guard();
      }
      var selected = ${clear ? "key('a', 'KeyA', 65, true)" : mac
        ? "key('ArrowDown', 'ArrowDown', 40, true)" : "key('End', 'End', 35, true)"};
      if (!selected) throw new Error('编辑器未处理选择命令，输入已停止。');
      var text = ${JSON.stringify(text)};
      if (text.length > 0) await paste(text);
      else if (${clear} && !key('Backspace', 'Backspace', 8, false)) {
        throw new Error('编辑器未处理清空命令，输入已停止。');
      }
      if (${submit} && !key('Enter', 'Enter', 13, false)) await paste('\\n');
      guard();
      return null;
    } catch (error) { return String(error && error.message || error); }
  })()`, { userGesture: true });
  } finally {
    await tab.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  }
  if (error) {
    if (/NO_SNAPSHOT|STALE_REF|DETACHED_REF/.test(error)) {
      throw new Error('STALE_REF: 编辑器引用已失效，请重新获取快照并使用最新引用。');
    }
    throw new Error(error);
  }
}
