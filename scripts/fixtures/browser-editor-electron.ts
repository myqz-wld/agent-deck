/** Real local Monaco input; no network dependency or live Browser profile. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';

import { click, snapshot, typeText, waitForSelector } from '../../src/main/browser-use/engine/actions';
import type { EngineTab } from '../../src/main/browser-use/engine/tab';

const requireFromRepo = createRequire(resolve('package.json'));
const monacoRoot = resolve(dirname(requireFromRepo.resolve('monaco-editor/package.json')), 'min/vs');

export function serveEditorFixture(url: string, response: ServerResponse): boolean {
  const pathname = new URL(url, 'http://localhost').pathname;
  if (pathname === '/editor-frame') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<iframe src="/editor" style="width:800px;height:500px"></iframe>');
    return true;
  }
  if (pathname.startsWith('/monaco/vs/')) {
    const file = resolve(monacoRoot, pathname.slice('/monaco/vs/'.length));
    if (!file.startsWith(monacoRoot + sep)) {
      response.writeHead(404).end();
      return true;
    }
    try {
      const data = readFileSync(file);
      const contentType = extname(file) === '.css' ? 'text/css' : 'text/javascript';
      response.writeHead(200, { 'content-type': contentType });
      response.end(data);
    } catch {
      response.writeHead(404).end();
    }
    return true;
  }
  if (pathname !== '/editor') return false;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
    <style>
      #editor { width: 700px; height: 350px; }
      label { display: inline-block; position: relative; }
      label input { position: absolute; opacity: 0; width: 20px; height: 20px; }
    </style>
    <label><input type="checkbox" id="scope">Receive messages</label>
    <div id="editor"></div>
    <script src="/monaco/vs/loader.js"></script>
    <script>
      require.config({ paths: { vs: '/monaco/vs' } });
      require(['vs/editor/editor.main'], function () {
        window.fixtureEditor = monaco.editor.create(document.querySelector('#editor'), {
          value: '{"sample": true}', language: 'json', automaticLayout: true,
          editContext: false, domReadOnly: true
        });
        document.body.dataset.ready = 'true';
      });
    </script>`);
  return true;
}

export async function verifyEditorInput(tab: EngineTab, origin: string, framed = false): Promise<void> {
  await tab.loadUrl(origin + (framed ? '/editor-frame' : '/editor'));
  const scope = framed ? 'document.querySelector("iframe").contentWindow' : 'window';
  await waitForSelector(tab, 'body[data-ready="true"]', 'attached', 15_000);
  const checkboxSnapshot = await snapshot(tab);
  const checkbox = checkboxSnapshot.elements.find((element) => element.type === 'checkbox');
  assert.ok(checkbox, 'styled checkbox must receive a ref');
  await click(tab, String(checkbox.ref));
  assert.equal(await tab.executeJs(`${scope}.document.querySelector("#scope").checked`), true);

  async function editorRef(): Promise<string> {
    const current = await snapshot(tab);
    const target = current.elements.find((element) => element.tag === 'textarea');
    assert.ok(target, 'Monaco textarea must receive a ref');
    return String(target.ref);
  }
  const content = '{\n  "scopes": ["im:message:send_as_bot"],\n  "label": "测试 🌏"\n}';
  const model = () => tab.executeJs<string>(`${scope}.fixtureEditor.getValue()`);
  await typeText(tab, await editorRef(), content);
  assert.equal(await model(), content, 'type must replace the actual Monaco model');
  await typeText(tab, await editorRef(), '\n追加', { clear: false });
  assert.equal(await model(), content + '\n追加', 'append must move to the model end');
  await typeText(tab, await editorRef(), '');
  assert.equal(await model(), '', 'empty replacement must clear the model');
  await typeText(tab, await editorRef(), 'submitted', { submit: true });
  assert.equal(await model(), 'submitted\n', 'submit must reach the editor Enter handler');

  await tab.executeJs(`${scope}.fixtureEditor.updateOptions({ readOnly: true })`);
  await assert.rejects(typeText(tab, await editorRef(), 'forbidden'), /不可输入/);
  assert.equal(await model(), 'submitted\n', 'read-only editors must remain unchanged');
}
