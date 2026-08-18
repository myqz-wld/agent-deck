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
 * Main floating-window facade. Domain helpers share one mutable state object so lifecycle,
 * appearance, and sizing operations observe the same window generation.
 */
export class FloatingWindow {
  private _state: FloatingWindowState = createInitialState();

  /** Bootstrap callback for compact-state changes; close clears it with the shared state. */
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

  /**
   * REVIEW_104 MED-D (reviewer-claude + lead 独立): in-memory windowTransparent SSOT getter。
   * Cmd+Alt+T 全局快捷键用它读「当前透明态」算 next,替代旧的 `settingsStore.get('windowTransparent')`
   * —— 旧路径以 store 为源,而 setWindowTransparentImpl 只写 in-memory state 不写回 store,持久化
   * 唯一靠 renderer 收到 TransparentToggled 后 setSettings 往返;renderer 死 / webContents destroyed
   * 时 safeSend no-op → store 永久 stale → 下次按键读旧值算错 next → toggle 卡死/反向。pin 快捷键
   * 读 live `w.isAlwaysOnTop()` 永远自洽,本 getter 让透明快捷键对齐同款「读 live SSOT」语义。
   */
  get windowTransparent(): boolean {
    return this._state.windowTransparent;
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
    const current = getFloatingWindow().window;
    if (current == null || current.isDestroyed()) {
      getFloatingWindow().create();
    }
  });
}
