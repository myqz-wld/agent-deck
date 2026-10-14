import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import type { CodexBridgeSessionRecordPort } from '../runtime-host-core';
import { setCodexPermissionMode } from '../permission-mode-controller';

function harness() {
  const record = { permissionMode: 'bypassPermissions', codexApprovalPolicy: 'never' } as SessionRecord;
  const records = {
    get: () => record,
    setPermissionMode: vi.fn((_id, value) => { record.permissionMode = value; }),
    setCodexApprovalPolicy: vi.fn((_id, value) => { record.codexApprovalPolicy = value; }),
    publishUpdated: vi.fn(),
  };
  const context = { operations: new Map<string, Promise<unknown>>(),
    records: records as unknown as CodexBridgeSessionRecordPort, applyLive: vi.fn() };
  return { context, record, records };
}

describe('Codex permission changes', () => {
  it('waits for recovery, then commits the selected mode for future recovery and live turns', async () => {
    const h = harness();
    let finish!: () => void;
    const recovery = new Promise<void>(resolve => { finish = resolve; })
      .finally(() => { h.context.operations.delete('session'); });
    h.context.operations.set('session', recovery);
    const pending = setCodexPermissionMode('session', 'auto', h.context);
    await Promise.resolve();
    expect(h.context.operations.get('session')).toBe(recovery);
    expect(h.records.setPermissionMode).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(h.record).toMatchObject({ permissionMode: 'auto', codexApprovalPolicy: 'on-request' });
    expect(h.context.applyLive).toHaveBeenCalledWith('session', 'auto');
    expect(h.context.operations.size).toBe(0);
  });

  it('restores persisted mode and policy when live application fails', async () => {
    const h = harness();
    h.context.applyLive.mockImplementationOnce(() => { throw new Error('projection failed'); });
    await expect(setCodexPermissionMode('session', 'auto', h.context)).rejects.toThrow('projection failed');
    expect(h.record).toMatchObject({ permissionMode: 'bypassPermissions', codexApprovalPolicy: 'never' });
    expect(h.context.applyLive).toHaveBeenCalledTimes(1);
    expect(h.context.operations.size).toBe(0);
  });

  it('restores the exact live snapshot if publishing the committed setting fails', async () => {
    const h = harness();
    const restore = vi.fn();
    h.context.applyLive.mockReturnValue(restore);
    h.records.publishUpdated.mockImplementationOnce(() => { throw new Error('publish failed'); });
    await expect(setCodexPermissionMode('session', 'auto', h.context)).rejects.toThrow('publish failed');
    expect(restore).toHaveBeenCalledOnce();
    expect(h.record).toMatchObject({ permissionMode: 'bypassPermissions', codexApprovalPolicy: 'never' });
  });

  it('still restores the live snapshot when one durable rollback step fails', async () => {
    const h = harness();
    const restore = vi.fn();
    h.context.applyLive.mockReturnValue(restore);
    h.records.setPermissionMode.mockImplementationOnce((_id, value) => { h.record.permissionMode = value; })
      .mockImplementationOnce(() => { throw new Error('rollback failed'); });
    h.records.publishUpdated.mockImplementationOnce(() => { throw new Error('publish failed'); });

    await expect(setCodexPermissionMode('session', 'auto', h.context))
      .rejects.toThrow('回退未完全成功');
    expect(restore).toHaveBeenCalledOnce();
    expect(h.record.codexApprovalPolicy).toBe('never');
    expect(h.context.operations.size).toBe(0);
  });
});
