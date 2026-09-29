import { Window, type DOMRect } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { BrowserEngine } from '../registry';
import { snapshotScript, typeScript } from '../scripts';
import { editorInputGuardScript } from '../editor-input';
import { typeText } from '../actions';
import { fakeWindowFactory } from './_fakes';

async function fixture() {
  const page = new Window({ url: 'http://localhost/editor' });
  page.document.body.innerHTML = '<div class="monaco-editor"><textarea>original</textarea></div><input>';
  const textarea = page.document.querySelector('textarea')!;
  vi.spyOn(textarea, 'getBoundingClientRect').mockReturnValue({ width: 20, height: 20 } as DOMRect);
  const snapshot = () => JSON.parse(page.eval(snapshotScript({
    limit: 10, includeText: false, textLimit: 0,
  })) as string).elements[0].ref as string;
  const factory = fakeWindowFactory();
  const engine = new BrowserEngine(factory);
  const tab = await engine.acquire({ kind: 'session', id: 'editor-test' }).openTab();
  const host = factory.windows[0];
  host.jsHandler = (code) => page.eval(code);
  return { page, textarea, snapshot, host, tab };
}

describe('Monaco input boundaries', () => {
  it('prepares rich input without claiming a DOM value write updated the model', async () => {
    const { page, textarea, snapshot } = await fixture();
    const result = JSON.parse(page.eval(typeScript(snapshot(), 'replacement', true)) as string);
    expect(result.nativeEditorInput).toBe(true);
    expect(textarea.value).toBe('original');
  });

  it('rejects a read-only textarea before sending keys or paste', async () => {
    const { textarea, snapshot, tab, host } = await fixture();
    textarea.readOnly = true;
    await expect(typeText(tab, snapshot(), 'replacement')).rejects.toThrow('不可输入');
    expect(textarea.value).toBe('original');
    expect(host.browserDebugger.sent).toEqual([
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true }, sessionId: undefined },
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false }, sessionId: undefined },
    ]);
  });

  it('fails closed if a newer snapshot arrives before the editor transaction', async () => {
    const { page, textarea, snapshot, tab, host } = await fixture();
    host.jsHandler = (code) => {
      const result = page.eval(code);
      if (code.includes('nativeEditorInput: true')) snapshot();
      return result;
    };
    await expect(typeText(tab, snapshot(), 'replacement')).rejects.toThrow('引用已失效');
    expect(textarea.value).toBe('original');
    expect(host.inputEvents).toEqual([]);
    expect(host.focused).toBe(false);
  });

  it('detects focus movement and detached elements before editor input', async () => {
    const { page, textarea, snapshot } = await fixture();
    const ref = snapshot();
    expect(page.eval(editorInputGuardScript(ref, true))).toBeNull();
    page.document.querySelector('input')!.focus();
    expect(page.eval(editorInputGuardScript(ref, false))).toContain('焦点已改变');
    textarea.remove();
    expect(page.eval(editorInputGuardScript(ref, false))).toBe('DETACHED_REF');
  });

  it('rejects overlapping typing before it can steal the first operation focus', async () => {
    const { snapshot, tab, host } = await fixture();
    let finish!: (value: string) => void;
    host.jsHandler = () => new Promise<string>((resolve) => { finish = resolve; });
    const ref = snapshot();
    const first = typeText(tab, ref, 'first');
    await expect(typeText(tab, ref, 'second')).rejects.toThrow('输入操作尚未完成');
    expect(host.webContents.executeJavaScript).toHaveBeenCalledOnce();
    finish('{}');
    await first;
  });
});
