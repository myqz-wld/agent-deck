import { afterEach, describe, expect, it } from 'vitest';
import { defaultFeishuModelPreference } from '@contracts/index';
import { cleanupFeishuWorkHarnesses, createFeishuWorkHarness, workRecord } from './feishu-work-management.fixture';
import { FeishuAssistantAuthority } from './feishu-assistant-authority';

afterEach(cleanupFeishuWorkHarnesses);
describe('registered assistant work management', () => {
  it('accepts the first work choice directly in creation and remembers it independently of the assistant', async () => {
    const t = createFeishuWorkHarness();
    t.store.write({ ...t.store.read(), session: defaultFeishuModelPreference() });
    const assistant = t.store.read().conversation;
    await expect(t.service.create('assistant-a', t.args)).rejects.toThrow(/selection.adapterId/);
    const created = await t.service.create('assistant-a', { ...t.args,
      selection: { adapterId: 'codex-cli', model: 'chosen-model', approvalPolicy: 'on-request' } });
    expect(created.preference).toMatchObject({ adapterId: 'codex-cli', model: 'chosen-model', approvalPolicy: 'on-request' });
    expect(t.store.read().session).toEqual(created.preference);
    expect(t.store.read().conversation).toEqual(assistant);
    expect(t.createSpawnSession).toHaveBeenCalledTimes(1);
  });
  it('moves registered authority to the current handoff owner even if the old process stays live', () => {
    const t = createFeishuWorkHarness();
    t.records.set('next-assistant', workRecord('next-assistant'));
    const authority = new FeishuAssistantAuthority({ read: () => ['assistant-a'] }, t.sessions,
      id => id === 'assistant-a' ? 'next-assistant' : null);
    expect(() => authority.caller('assistant-a')).toThrow(/current handoff owner/);
    expect(authority.caller('next-assistant').id).toBe('next-assistant');
    expect(() => authority.work('next-assistant', 'assistant-a')).toThrow(/open work/);
  });
  it('uses saved work controls rather than assistant controls, publishes ownership before output and replays creation', async () => {
    const t = createFeishuWorkHarness(); const before = t.store.read();
    const result = await t.service.create('assistant-a', t.args);
    expect(t.createSpawnSession.mock.calls[0][0].params).toMatchObject({ initialMessage: t.args.initialMessage,
      workingDirectory: '.', options: { model: 'work-model', thinking: 'medium', approvalPolicy: 'never', codexSandbox: 'workspace-write' } });
    expect(t.records.get(result.sessionId)?.title).toBe('连接验证');
    expect(t.records.get(result.sessionId)).toMatchObject({ spawnedBy: null, spawnDepth: 0 });
    expect(t.changes.map(c => c.kind)).toEqual(['session.updated', 'feishu.work.registered', 'feishu.work.committed']);
    expect(JSON.stringify(t.changes)).not.toContain(t.args.initialMessage);
    expect(await t.service.create('assistant-a', t.args)).toEqual(result);
    expect(t.createSpawnSession).toHaveBeenCalledTimes(1);
    expect(t.store.read()).toEqual(before);
    expect(t.records.get('assistant-a')?.title).toBe('Workspace');
    expect([...t.metadata.feishuWorkOrigins('assistant-a')]).toEqual([
      { assistantId: 'assistant-a', sessionId: result.sessionId },
    ]);
  });

  it('repairs only committed owner-created work and preserves genuine agent children', async () => {
    const t = createFeishuWorkHarness();
    const result = await t.service.create('assistant-a', t.args);
    Object.assign(t.records.get(result.sessionId)!, { spawnedBy: 'assistant-a', spawnDepth: 1 });
    t.records.set('real-child', workRecord('real-child', { spawnedBy: 'assistant-a', spawnDepth: 1 }));
    t.service.reconcileCreatedWork();
    expect(t.records.get(result.sessionId)).toMatchObject({ spawnedBy: null, spawnDepth: 0 });
    expect(t.records.get('real-child')?.spawnedBy).toBe('assistant-a');
    const revision = t.metadata.currentRevision();
    t.service.reconcileCreatedWork();
    expect(t.metadata.currentRevision()).toBe(revision);
    const lease = t.guard.reserve(t.records.get('assistant-a')!);
    expect(lease.snapshot().fanOut).toMatchObject({ activeChildren: 2, inFlight: 1 });
    lease.release();
  });

  it('keeps admission reserved until independent work provenance commits', async () => {
    const t = createFeishuWorkHarness();
    const create = t.createSpawnSession.getMockImplementation()!;
    t.createSpawnSession.mockImplementationOnce(async input => {
      const result = await create(input);
      const other = t.guard.reserve(t.records.get('assistant-a')!);
      expect(other.snapshot().fanOut).toMatchObject({ activeChildren: 0, inFlight: 2 });
      other.release();
      return result;
    });
    await t.service.create('assistant-a', t.args);
    const lease = t.guard.reserve(t.records.get('assistant-a')!);
    expect(lease.snapshot().fanOut).toMatchObject({ activeChildren: 1, inFlight: 1 });
    lease.release();
  });

  it('follows the canonical provider ID and retains a manual name changed during startup', async () => {
    const t = createFeishuWorkHarness();
    t.createSpawnSession.mockImplementationOnce(async input => {
      t.records.set('temporary-work', workRecord('temporary-work', { spawnedBy: 'assistant-a', spawnDepth: 1 }));
      input.initialSessionRegistration.onRegistered('temporary-work');
      t.records.set('canonical-work', { ...t.records.get('temporary-work')!, id: 'canonical-work' });
      t.records.delete('temporary-work');
      t.metadata.appendChange('session.renamed', 'canonical-work', { fromId: 'temporary-work', toId: 'canonical-work' });
      t.service.rename('assistant-a', { requestId: 'manual-name', sessionId: 'canonical-work',
        expectedTitle: '连接验证', title: '用户指定名称' });
      return { sessionId: 'canonical-work', revision: t.metadata.currentRevision() };
    });
    expect(await t.service.create('assistant-a', t.args)).toMatchObject({ sessionId: 'canonical-work', title: '用户指定名称' });
    expect(t.rollback).not.toHaveBeenCalled();
  });

  it('remembers an explicit same-adapter override without changing conversation defaults', async () => {
    const t = createFeishuWorkHarness(); const chat = t.store.read().conversation;
    const result = await t.service.create('assistant-a', { ...t.args, selection: { thinking: 'high', approvalPolicy: 'on-request' } });
    expect(result.preference).toEqual({ ...t.store.read().session, model: 'work-model', thinking: 'high', approvalPolicy: 'on-request' });
    expect(t.store.read().conversation).toEqual(chat);
    expect(result.settingsRevision).toBe(3);
    expect(t.createSpawnSession.mock.calls[0][0].params.options.approvalPolicy).toBe('on-request');
  });

  it('resets incompatible fields when changing adapters and rejects foreign controls', async () => {
    const t = createFeishuWorkHarness();
    const changed = await t.service.updatePreferences('assistant-a', { requestId: 'change-chat-adapter', purpose: 'conversation',
      preference: { adapterId: 'grok-build', model: 'custom-grok', sessionMode: 'ask' }, expectedSettingsRevision: 2 });
    expect(changed.conversation).toEqual({ adapterId: 'grok-build', provider: '', model: 'custom-grok', thinking: '', sessionMode: 'ask' });
    expect(changed.session.model).toBe('work-model');
    await expect(t.service.create('assistant-a', { ...t.args, expectedSettingsRevision: 3,
      selection: { permissionMode: 'bypassPermissions' } })).rejects.toThrow();
    expect(t.createSpawnSession).not.toHaveBeenCalled();
  });

  it('rejects stale preferences, unregistered callers and hidden/assistant rename targets', async () => {
    const t = createFeishuWorkHarness();
    await expect(t.service.create('assistant-a', { ...t.args, expectedSettingsRevision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(t.service.create('existing-work', t.args)).rejects.toThrow(/registered/);
    t.records.set('hidden-work', workRecord('hidden-work', { hiddenFromHistory: true }));
    for (const sessionId of ['assistant-a', 'hidden-work']) expect(() => t.service.rename('assistant-a', {
      requestId: `rename-${sessionId}`, sessionId, title: 'Rename', expectedTitle: 'Workspace',
    })).toThrow(/open work/);
    expect(t.createSpawnSession).not.toHaveBeenCalled();
  });

  it('rechecks caller liveness after asynchronous capability lookup before saving a choice', async () => {
    const t = createFeishuWorkHarness();
    t.capabilities.describe.mockImplementationOnce(async input => {
      const { sessionConsoleCapabilitiesFixture } = await import('@contracts/session-console-capabilities.fixture');
      t.records.get('assistant-a')!.lifecycle = 'closed';
      return sessionConsoleCapabilitiesFixture(input.adapterId as 'codex-cli');
    });
    await expect(t.service.updatePreferences('assistant-a', { requestId: 'closing-choice', purpose: 'session',
      preference: { thinking: 'high' }, expectedSettingsRevision: 2 })).rejects.toThrow(/registered/);
    expect(t.store.write).not.toHaveBeenCalled();
  });

  it('cleans only its partial target on startup failure and fences an unproved rollback', async () => {
    const t = createFeishuWorkHarness();
    const create = t.createSpawnSession.getMockImplementation()!;
    t.createSpawnSession.mockImplementation(async input => { await create(input); throw new Error('Startup failed'); });
    await expect(t.service.create('assistant-a', t.args)).rejects.toThrow('Startup failed');
    expect(t.records.has('created-work')).toBe(false);
    expect(t.records.has('existing-work')).toBe(true);
    expect(t.changes.at(-1)?.kind).toBe('feishu.work.failed');
    t.rollback.mockRejectedValueOnce(new Error('Close unproved'));
    await expect(t.service.create('assistant-a', t.args)).rejects.toMatchObject({ code: 'provider_lost' });
    const calls = t.createSpawnSession.mock.calls.length;
    await expect(t.service.create('assistant-a', t.args)).rejects.toMatchObject({ code: 'provider_lost' });
    expect(t.createSpawnSession).toHaveBeenCalledTimes(calls);
  });

  it('honors the shared spawn limit and conflicting creation keys without another provider start', async () => {
    const t = createFeishuWorkHarness();
    const lease = t.guard.reserve(t.records.get('assistant-a')!);
    for (let n = 0; n < 2; n++) t.records.set(`child-${n}`, workRecord(`child-${n}`, { spawnedBy: 'assistant-a', spawnDepth: 1 }));
    await expect(t.service.create('assistant-a', t.args)).rejects.toThrow(/fan-out/);
    lease.release();
    await t.service.create('assistant-a', t.args);
    await expect(t.service.create('assistant-a', { ...t.args, title: 'Another intent' })).rejects.toMatchObject({ code: 'conflict' });
    expect(t.createSpawnSession).toHaveBeenCalledTimes(1);
  });

  it('replays a preference patch after later edits without overwriting the newer choices', async () => {
    const t = createFeishuWorkHarness();
    const args = { requestId: 'first-choice', purpose: 'session' as const, preference: { thinking: 'high' }, expectedSettingsRevision: 2 };
    const first = await t.service.updatePreferences('assistant-a', args);
    await t.service.updatePreferences('assistant-a', { ...args, requestId: 'second-choice',
      preference: { thinking: 'low' }, expectedSettingsRevision: 3 });
    expect(await t.service.updatePreferences('assistant-a', args)).toEqual(first);
    expect(t.store.read().session.thinking).toBe('low');
    expect(t.store.write).toHaveBeenCalledTimes(2);
  });
});
