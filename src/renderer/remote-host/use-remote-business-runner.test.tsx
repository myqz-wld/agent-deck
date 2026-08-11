// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRef, useState } from 'react';

import { useRemoteBusinessRunner } from './use-remote-business-runner';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function useHarness() {
  const identity = useRef('core-a');
  const [, setRevision] = useState(0);
  return { identity, ...useRemoteBusinessRunner(identity, setRevision) };
}

describe('useRemoteBusinessRunner terminal outcomes', () => {
  it('preserves a terminal success after identity changes while ordinary work stays fenced', async () => {
    const hook = renderHook(() => useHarness());
    const terminal = deferred<string>();
    const ordinary = deferred<string>();
    let terminalResult!: Promise<string>;
    let ordinaryResult!: Promise<string>;
    act(() => {
      terminalResult = hook.result.current.runTerminal(() => terminal.promise);
      ordinaryResult = hook.result.current.run(() => ordinary.promise);
      hook.result.current.identity.current = 'core-b';
      terminal.resolve('successor-a');
      ordinary.resolve('stale-read');
    });

    await expect(terminalResult).resolves.toBe('successor-a');
    await expect(ordinaryResult).rejects.toThrow('数据源已切换，请重试。');
  });
});
