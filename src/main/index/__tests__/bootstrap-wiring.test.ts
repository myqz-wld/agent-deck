/**
 * plan log-noise-and-disposed-20260603 §D3 / Step 5: makeSafeSend 单元测试
 *
 * 范围:
 * 1. window 已 isDestroyed → 直接 return (守现有 contract)
 * 2. webContents.send 抛 'Render frame was disposed' 框架 race → safeSend 静默
 * 3. webContents.send 抛其他 Error (TypeError / 业务 bug) → safeSend 透传 throw
 * 4. window 本身 null (floating 未 create 异常路径) → 直接 return
 * 5. webContents 已 isDestroyed → 直接 return
 */
import { describe, expect, it, vi } from 'vitest';

import { makeSafeSend } from '../_deps';

// helper: build a fake BrowserWindow with controllable send
function fakeWindow(opts: { send?: ReturnType<typeof vi.fn>; windowDestroyed?: boolean; wcDestroyed?: boolean } = {}) {
  const send = opts.send ?? vi.fn();
  return {
    isDestroyed: vi.fn(() => opts.windowDestroyed ?? false),
    webContents: {
      send,
      isDestroyed: vi.fn(() => opts.wcDestroyed ?? false),
    },
  } as unknown as Electron.BrowserWindow;
}

describe('makeSafeSend', () => {
  it('1. window null → 直接 return 不调 send', () => {
    const safeSend = makeSafeSend(() => null);
    expect(() => safeSend('ch', { x: 1 })).not.toThrow();
  });

  it('2. window.isDestroyed → 直接 return 不调 send', () => {
    const send = vi.fn();
    const w = fakeWindow({ send, windowDestroyed: true });
    const safeSend = makeSafeSend(() => w);
    safeSend('ch', { x: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('3. webContents.isDestroyed → 直接 return 不调 send', () => {
    const send = vi.fn();
    const w = fakeWindow({ send, wcDestroyed: true });
    const safeSend = makeSafeSend(() => w);
    safeSend('ch', { x: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  // 注(reviewer-claude R3 INFO, plan §Fix E 修订历史): 生产中 webContents.send
  // 抛 'Render frame was disposed' 路径**实际不触发**此 catch — Electron framework
  // (v33) WebFrameMain.send 内部 native try/catch 吞错 + 走 console.error,应用层
  // try 永不进(R1 铁证 14/14 日志样本全带 framework console.error 前缀)。
  // 本 case 验的是 catch 逻辑正确性作 defense-in-depth,防未来 framework 行为
  // 变化或非 framework 路径同类 race;真磁盘日志降噪由 logger.ts file transport
  // hook 修(详 logger-end-to-end.test.ts)。
  it('4. send 抛 "Render frame was disposed" 框架 race → safeSend 静默不 throw (defense-in-depth, 生产不触发)', () => {
    const send = vi.fn(() => {
      // 框架实测样本:
      //   'Error sending from webFrameMain: Error: Render frame was disposed before WebFrameMain could be accessed'
      throw new Error('Render frame was disposed before WebFrameMain could be accessed');
    });
    const w = fakeWindow({ send });
    const safeSend = makeSafeSend(() => w);
    expect(() => safeSend('ch', { x: 1 })).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('5. send 抛 "TypeError: xxx" 等其他 Error → safeSend 透传 throw (不静默吞真错)', () => {
    const send = vi.fn(() => {
      throw new TypeError("Cannot read property 'foo' of undefined");
    });
    const w = fakeWindow({ send });
    const safeSend = makeSafeSend(() => w);
    expect(() => safeSend('ch', { x: 1 })).toThrow(TypeError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('6. send 抛非 Error (string / 任意) → safeSend 透传 (regex 仅命中 Error.message)', () => {
    const send = vi.fn(() => {
      // 非 Error 实例, instanceof Error = false, 走 throw
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string thrown';
    });
    const w = fakeWindow({ send });
    const safeSend = makeSafeSend(() => w);
    expect(() => safeSend('ch', { x: 1 })).toThrow('string thrown');
  });

  it('7. 正常路径 → send 调一次, 通道名 + payload 透传', () => {
    const send = vi.fn();
    const w = fakeWindow({ send });
    const safeSend = makeSafeSend(() => w);
    safeSend('agent-event', { id: 'abc' });
    expect(send).toHaveBeenCalledWith('agent-event', { id: 'abc' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
