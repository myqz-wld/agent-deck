import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { FeishuPreferences } from '@contracts/index';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { SessionRecord } from '@shared/types';
import { FeishuAssistantAuthority } from './feishu-assistant-authority';
import { ServerCoreFeishuPreferenceService } from './feishu-preference-service';
import { ServerCoreSessionNameService } from './session-name-service';
import { ServerCoreRuntimeMetadataStore, type ServerCoreChangeRecord } from './runtime-metadata-store';
import { ServerCoreSpawnGuard } from './mcp-spawn-guard';
import { ServerCoreFeishuWorkManagement } from './feishu-work-management';
import type { ServerCoreSessionSpawnCreateInput } from './session-console-authority';

const cleanups: Array<() => void> = [];
export function cleanupFeishuWorkHarnesses(): void { for (const close of cleanups.splice(0)) close(); }
export function workRecord(id: string, fields: Partial<SessionRecord> = {}): SessionRecord {
  return { id, agentId: 'codex-cli', cwd: '/workspaces/demo', title: 'Workspace', source: 'sdk',
    lifecycle: 'active', activity: 'finished', startedAt: 1, lastEventAt: 2, endedAt: null, archivedAt: null, ...fields };
}

export function createFeishuWorkHarness() {
  const root = mkdtempSync(join(tmpdir(), 'feishu-work-management-'));
  const metadata = new ServerCoreRuntimeMetadataStore({ instanceId: 'instance-a',
    stateDirectory: join(root, 'state'), configurationDirectory: join(root, 'config'),
    logDirectory: join(root, 'logs'), runtimeDirectory: join(root, 'run'), socketPath: join(root, 'run/core.sock') });
  metadata.start();
  cleanups.push(() => { metadata.close(); rmSync(root, { recursive: true, force: true }); });
  const records = new Map<string, SessionRecord>([['assistant-a', workRecord('assistant-a')], ['existing-work', workRecord('existing-work')]]);
  const sessions = { get: (id: string) => records.get(id) ?? null,
    setTitle: vi.fn((id: string, title: string) => { const row = records.get(id); if (row) records.set(id, { ...row, title }); }),
    listChildren: (id: string, state: 'active') => [...records.values()].filter(r => r.spawnedBy === id && r.lifecycle === state) };
  let preferences: FeishuPreferences = {
    conversation: { adapterId: 'codex-cli', provider: '', model: 'chat-model', thinking: 'max', approvalPolicy: 'on-request' },
    session: { adapterId: 'codex-cli', provider: '', model: 'work-model', thinking: 'medium' }, settingsRevision: 2,
  };
  const store = { read: () => structuredClone(preferences), write: vi.fn((value: FeishuPreferences) => { preferences = structuredClone(value); }) };
  const capabilities = { describe: vi.fn(async (input: { adapterId: string | null }) => sessionConsoleCapabilitiesFixture(input.adapterId as 'claude-code' | 'codex-cli' | 'grok-build')) };
  const preferenceService = new ServerCoreFeishuPreferenceService(store, metadata, capabilities);
  const names = new ServerCoreSessionNameService(sessions, metadata);
  const guard = new ServerCoreSpawnGuard(sessions, () => 100, { maxDepth: 3, maxFanOut: 3, maxRate: 10 });
  const createSpawnSession = vi.fn(async (input: ServerCoreSessionSpawnCreateInput) => {
    records.set('created-work', workRecord('created-work', { agentId: input.params.adapterId as SessionRecord['agentId'],
      spawnedBy: input.initialSessionRegistration.spawnLink.parentSessionId,
      spawnDepth: input.initialSessionRegistration.spawnLink.depth }));
    input.initialSessionRegistration.onRegistered('created-work');
    return { sessionId: 'created-work', revision: metadata.currentRevision() };
  });
  const rollback = vi.fn(async (_adapter: string, id: string) => { records.delete(id); });
  const assistants = new FeishuAssistantAuthority({ read: () => ['assistant-a'] }, sessions, () => null);
  const service = new ServerCoreFeishuWorkManagement({ assistants, sessions, preferences: preferenceService,
    names, metadata, authority: { createSpawnSession }, capabilities, reserve: row => guard.reserve(row), rollback });
  const changes: ServerCoreChangeRecord[] = []; metadata.subscribe(change => { changes.push(change); });
  const args = { requestId: 'work-request-a', title: '连接验证', initialMessage: 'Only reply ready.', expectedSettingsRevision: 2 };
  return { root, service, records, sessions, metadata, store, capabilities, guard, createSpawnSession, rollback, changes, args };
}
