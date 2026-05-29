/**
 * message-delivery-state.ts 单测(REVIEW_56 §F14 修法 — coerceMessageStatus logger.warn 回归 test).
 *
 * **范围**: pure helper coerceMessageStatus 的两 case:
 * 1. 合法 status → 透传(无 warn)
 * 2. 非法 status → 'failed' fallback + logger.warn(prefix `[message-delivery-state]` + raw value)
 *
 * Step 3.3.2 console.warn → logger.warn migrate 后改 spy log.scope('store-message-delivery').warn
 * (vitest-setup.ts mock 让 log.scope() 返 cached vi.fn() object 同 name 同一个 obj).
 *
 * 不依赖 DB / fixture(coerceMessageStatus 是 pure function).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import log from 'electron-log/main';
import { coerceMessageStatus } from '../message-delivery-state';

describe('coerceMessageStatus — REVIEW_56 §F14 修法 (logger.warn 回归 test)', () => {
  const scopedLogger = log.scope('store-message-delivery');

  beforeEach(() => {
    (scopedLogger.warn as ReturnType<typeof vi.fn>).mockClear();
  });

  it('合法 status pending → 透传不 warn', () => {
    const result = coerceMessageStatus('pending');
    expect(result).toBe('pending');
    expect(scopedLogger.warn).not.toHaveBeenCalled();
  });

  it('合法 status delivered → 透传不 warn', () => {
    const result = coerceMessageStatus('delivered');
    expect(result).toBe('delivered');
    expect(scopedLogger.warn).not.toHaveBeenCalled();
  });

  it('非法 status → fallback failed + logger.warn (REVIEW_56 §F14)', () => {
    const result = coerceMessageStatus('not-a-valid-status');
    expect(result).toBe('failed');
    expect(scopedLogger.warn).toHaveBeenCalledTimes(1);
    expect(scopedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[message-delivery-state]'),
    );
    expect(scopedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not-a-valid-status'),
    );
    expect(scopedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("'failed'"));
  });

  it('空字符串 → fallback failed + logger.warn (脏数据边角)', () => {
    const result = coerceMessageStatus('');
    expect(result).toBe('failed');
    expect(scopedLogger.warn).toHaveBeenCalledTimes(1);
  });
});
