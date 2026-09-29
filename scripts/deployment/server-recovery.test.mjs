import { describe, expect, it, vi } from 'vitest';
import { recoverUpgradeState } from './server.mjs';

describe('Relay upgrade recovery through the instance manager', () => {
  it('resumes a durable failed operation before reading the recovered generation', async () => {
    const manager = vi.fn()
      .mockRejectedValueOnce({ managerCode: 'recovery_required' })
      .mockResolvedValueOnce({ currentVersion: 'git-previous' })
      .mockResolvedValueOnce({ generation: 20, currentVersion: 'git-previous' });
    await expect(recoverUpgradeState({ topology: 'relay' }, manager)).resolves.toMatchObject({ generation: 20 });
    expect(manager.mock.calls.map(([command]) => command)).toEqual(['describe', 'start', 'describe']);
  });

  it('does not restart for healthy inspection, other failures, or another topology', async () => {
    const healthy = vi.fn().mockResolvedValue({ generation: 20 });
    await recoverUpgradeState({ topology: 'relay' }, healthy);
    expect(healthy).toHaveBeenCalledOnce();
    for (const [topology, managerCode] of [['relay', 'invalid_input'], ['full', 'recovery_required']]) {
      const error = { managerCode }; const manager = vi.fn().mockRejectedValue(error);
      await expect(recoverUpgradeState({ topology }, manager)).rejects.toBe(error);
      expect(manager).toHaveBeenCalledOnce();
    }
  });

  it('stops when managed recovery fails instead of claiming a new generation', async () => {
    const error = new Error('recovery failed');
    const manager = vi.fn().mockRejectedValueOnce({ managerCode: 'recovery_required' }).mockRejectedValueOnce(error);
    await expect(recoverUpgradeState({ topology: 'relay' }, manager)).rejects.toBe(error);
    expect(manager).toHaveBeenCalledTimes(2);
  });
});
