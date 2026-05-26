/**
 * message-delivery-state.ts 单测(REVIEW_56 §F14 修法 — coerceMessageStatus console.warn 回归 test)。
 *
 * **范围**: pure helper coerceMessageStatus 的两 case:
 * 1. 合法 status → 透传(无 warn)
 * 2. 非法 status → 'failed' fallback + console.warn(prefix `[message-delivery-state]` + raw value)
 *
 * 不依赖 DB / fixture(coerceMessageStatus 是 pure function)。
 */
import { describe, expect, it, vi } from 'vitest';
import { coerceMessageStatus } from '../message-delivery-state';

describe('coerceMessageStatus — REVIEW_56 §F14 修法 (console.warn 回归 test)', () => {
  it('合法 status pending → 透传不 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = coerceMessageStatus('pending');
    expect(result).toBe('pending');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('合法 status delivered → 透传不 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = coerceMessageStatus('delivered');
    expect(result).toBe('delivered');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('非法 status → fallback failed + console.warn (REVIEW_56 §F14)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = coerceMessageStatus('not-a-valid-status');
    expect(result).toBe('failed');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[message-delivery-state]'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('not-a-valid-status'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'failed'"));
    warnSpy.mockRestore();
  });

  it('空字符串 → fallback failed + console.warn (脏数据边角)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = coerceMessageStatus('');
    expect(result).toBe('failed');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
