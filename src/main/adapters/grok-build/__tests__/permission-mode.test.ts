import { describe, expect, it, vi } from 'vitest';
import { createGrokRuntime, recoverGrokRuntime } from '../runtime-factory';
import { buildGrokSessionMeta } from '../session-setup';
import { applyGrokPermissionMode } from '../permission-mode';
import { GrokRuntimeMutationController } from '../runtime-mutation-controller';
import type { GrokAcpSession } from '../acp-process';
import type { SessionRecord } from '@shared/types';

const setup = { mcpHttpUrl: '', isAgentDeckMcpEnabled: () => false,
  getAgentProfilePrompt: async () => null, getPluginDirectories: async () => [] };

describe('Grok common permission presets', () => {
  it.each(['auto', 'bypassPermissions'] as const)('restores %s with explicit, mutually exclusive native flags', async permissionMode => {
    const created = createGrokRuntime('session', { cwd: '/project', permissionMode }, null);
    const recovered = recoverGrokRuntime({ id: 'session', cwd: '/project', permissionMode,
      sessionMode: 'plan' } as SessionRecord);
    for (const runtime of [created, recovered]) {
      expect(await buildGrokSessionMeta(runtime, setup)).toMatchObject({
        autoMode: permissionMode === 'auto', yoloMode: permissionMode === 'bypassPermissions',
      });
      expect(runtime.sessionMode).toBe('default');
    }
  });

  it('clears YOLO when switching to auto and exits legacy planning before another prompt', async () => {
    const order: string[] = [];
    const notify = vi.fn(async () => { order.push('permissions'); });
    const request = vi.fn(async () => { order.push('work-mode'); return {}; });
    const runtime = createGrokRuntime('session', { cwd: '/project', permissionMode: 'bypassPermissions' }, null);
    runtime.nativeSessionId = 'native-session';
    runtime.process = { connection: { agent: { notify, request } } } as unknown as GrokAcpSession;
    await applyGrokPermissionMode(runtime, 'auto');
    expect(notify).toHaveBeenCalledWith('_x.ai/yolo_mode_changed', {
      yolo_mode: false, auto_mode: true, permission_mode: 'auto',
    });
    expect(request).toHaveBeenCalledWith('session/set_mode', {
      sessionId: 'native-session', modeId: 'default',
    }, expect.anything());
    expect(order).toEqual(['permissions', 'work-mode']);
  });

  it('restores persistence and disposes an uncertain native runtime when publication fails', async () => {
    const runtime = createGrokRuntime('session', { cwd: '/project', permissionMode: 'bypassPermissions' }, null);
    runtime.nativeSessionId = 'native-session';
    runtime.ready = true;
    runtime.process = { connection: { agent: { notify: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockResolvedValue({}) } } } as unknown as GrokAcpSession;
    const stored = { permissionMode: 'bypassPermissions', sessionMode: 'default' };
    let failPublish = true;
    const dispose = vi.fn(async () => { runtime.disposed = true; });
    const controller = new GrokRuntimeMutationController({
      getRuntime: () => runtime,
      getPersistedOptions: () => ({ model: null, thinking: null, ...stored } as never),
      persistModelOptions: vi.fn(), persistSessionMode: vi.fn(), dispose,
      persistPermissionMode: (_id, permissionMode, sessionMode) => {
        Object.assign(stored, { permissionMode, sessionMode });
        if (failPublish) { failPublish = false; throw new Error('publication failed'); }
      },
    });
    await expect(controller.setPermissionMode('session', 'auto')).rejects.toMatchObject({ code: 'remote-state-unknown' });
    expect(stored).toEqual({ permissionMode: 'bypassPermissions', sessionMode: 'default' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.permissionMode).toBe('bypassPermissions');
  });
});
