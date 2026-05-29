import { BrowserWindow, app } from 'electron';

import {
  createInitialState,
  type FloatingWindowState,
} from './window/_deps';
import { createImpl, closeImpl } from './window/lifecycle';
import { setAlwaysOnTopImpl, setWindowTransparentImpl } from './window/pin-visual';
import { toggleCompactImpl, toggleMaximizeImpl, toggleDefaultImpl } from './window/sizing';
import { setIgnoreMouseImpl, flashImpl } from './window/polish';

/**
 * 应用主窗口单例 — 漂浮置顶 + 透明 + 自适配 vibrancy + 折叠 / 最大 / 默认 toggle。
 *
 * **拆分布局** (Phase 4 Step 4.7 / CHANGELOG_175):
 * - facade `window.ts`: class shell + thin delegate + module-level export
 * - `window/_deps.ts`: consts + FloatingWindowState interface + resolveIconPath/resolveIconImage
 * - `window/lifecycle.ts`: createImpl + closeImpl (含 BrowserWindow 创建 / dock icon / closed listener)
 * - `window/pin-visual.ts`: setAlwaysOnTopImpl + setWindowTransparentImpl + invalidate loop helpers
 * - `window/sizing.ts`: toggleCompactImpl + toggleMaximizeImpl + toggleDefaultImpl + 5 geometry helpers
 * - `window/polish.ts`: setIgnoreMouseImpl + flashImpl
 *
 * **state 设计** (Step 4.7 mini-spike user confirm):
 * 11 个 mutable 字段(含 emitCompactChanged 注入回调)收敛进 `_state: FloatingWindowState`
 * 单一 object,子模块 free function 通过 ctx 参数 read/write 同一引用。class 体仅保留:
 * (a) `_state` 字段 + (b) public method thin delegate + (c) `emitCompactChanged` getter/setter
 * forwarder (保 main/index.ts:294 `floating.emitCompactChanged = ...` 注入路径 byte-identical) +
 * (d) `window` getter (返 `_state.win`)。
 */
export class FloatingWindow {
  private _state: FloatingWindowState = createInitialState();

  /**
   * main/index.ts bootstrap 时注入 compact 状态变化回调(emit IpcEvent.CompactToggled)。
   * 经 getter/setter forwarder 路由到 `_state.emitCompactChanged`,保 byte-identical
   * 注入语义 (`floating.emitCompactChanged = ...`)。close() 必须置 null 防 closure 持
   * 旧 safeSend 引用 (R2 fix REVIEW_45 LOW)。
   */
  get emitCompactChanged(): ((compact: boolean) => void) | null {
    return this._state.emitCompactChanged;
  }
  set emitCompactChanged(cb: ((compact: boolean) => void) | null) {
    this._state.emitCompactChanged = cb;
  }

  create(): BrowserWindow {
    return createImpl(this._state);
  }

  get window(): BrowserWindow | null {
    return this._state.win;
  }

  setAlwaysOnTop(value: boolean): void {
    setAlwaysOnTopImpl(this._state, value);
  }

  setWindowTransparent(value: boolean): void {
    setWindowTransparentImpl(this._state, value);
  }

  toggleCompact(): boolean {
    return toggleCompactImpl(this._state);
  }

  toggleMaximize(): { width: number; height: number } {
    return toggleMaximizeImpl(this._state);
  }

  toggleDefault(): { width: number; height: number } {
    return toggleDefaultImpl(this._state);
  }

  setIgnoreMouse(ignore: boolean): void {
    setIgnoreMouseImpl(this._state, ignore);
  }

  flash(): void {
    flashImpl(this._state);
  }

  close(): void {
    closeImpl(this._state);
  }
}

let instance: FloatingWindow | null = null;

export function getFloatingWindow(): FloatingWindow {
  if (!instance) instance = new FloatingWindow();
  return instance;
}

export function ensureFocusableOnActivate(): void {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      getFloatingWindow().create();
    }
  });
}
