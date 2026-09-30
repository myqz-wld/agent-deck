import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FEISHU_SCHEMA_V4 } from './sqlite-schema-v4.fixture';
import { SqliteFeishuGatewayStore } from './sqlite-store';

const roots: string[] = [];
const binding = { appId: 'app-one', tenantKey: 'tenant-one', instanceId: 'instance-one', topology: 'relay' as const };
function oldDatabase() {
  const root = mkdtempSync(join(tmpdir(), 'feishu-context-migration-')); roots.push(root);
  const path = join(root, 'metadata.sqlite3');
  const db = new Database(path); chmodSync(path, 0o600);
  db.exec(FEISHU_SCHEMA_V4);
  db.exec(`INSERT INTO credentials VALUES ('app-one','tenant-one','owner-one','instance-one','credential-one','scope-one','relay','active','owner-equivalent');
    INSERT INTO contexts VALUES ('instance-one','credential-one','chat-one','owner-one','work-one',100,'p2p');
    INSERT INTO subscriptions VALUES ('instance-one','credential-one','chat-one','work-one','active',100);
    INSERT INTO cursors VALUES ('instance-one','credential-one','chat-one',17,100);`);
  return { path, db };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Feishu v5 assistant context migration', () => {
  it('preserves v4 work state and credentials, then persists separate assistant identity across reopen', () => {
    const old = oldDatabase(); old.db.close();
    const store = new SqliteFeishuGatewayStore(old.path, binding);
    const before = store.getContext(binding.instanceId, 'credential-one', 'chat-one')!;
    expect(before).toMatchObject({ activeSessionId: 'work-one', assistantSessionId: null, assistantGeneration: 0 });
    expect(store.listActiveCredentials()).toHaveLength(1);
    expect(store.getCursor(binding.instanceId, 'credential-one', 'chat-one')?.revision).toBe(17);
    expect(store.getSubscription(binding.instanceId, 'credential-one', 'chat-one', 'work-one'))
      .toMatchObject({ status: 'active', purpose: 'session' });
    store.putContext({ ...before, assistantSessionId: 'assistant-one', assistantGeneration: 1 });
    store.putSubscription({ instanceId: binding.instanceId, credentialId: 'credential-one', chatId: 'chat-one',
      sessionId: 'assistant-one', purpose: 'assistant', status: 'active', updatedAt: 101 });
    store.close();
    const next = new SqliteFeishuGatewayStore(old.path, binding);
    const saved = next.getContext(binding.instanceId, 'credential-one', 'chat-one')!;
    expect(saved).toMatchObject({ activeSessionId: 'work-one', assistantSessionId: 'assistant-one', assistantGeneration: 1 });
    next.putContext({ ...saved, assistantSessionId: 'assistant-two', assistantGeneration: 2, updatedAt: 102 });
    expect(next.getSubscription(binding.instanceId, 'credential-one', 'chat-one', 'assistant-one'))
      .toMatchObject({ purpose: 'assistant', status: 'inactive' });
    expect(next.getSubscription(binding.instanceId, 'credential-one', 'chat-one', 'work-one')?.status).toBe('active');
    next.close();
    const read = new Database(old.path, { readonly: true });
    expect(read.pragma('user_version', { simple: true })).toBe(5);
    expect(read.pragma('foreign_key_check')).toEqual([]); read.close();
  });

  it('refuses a modified v4 schema before changing any stored state', () => {
    const old = oldDatabase();
    old.db.exec('ALTER TABLE contexts ADD COLUMN unexpected TEXT'); old.db.close();
    expect(() => new SqliteFeishuGatewayStore(old.path, binding)).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
    const read = new Database(old.path, { readonly: true });
    expect(read.pragma('user_version', { simple: true })).toBe(4);
    expect(read.prepare('SELECT active_session_id FROM contexts').get()).toEqual({ active_session_id: 'work-one' });
    expect((read.pragma('table_info(contexts)') as Array<{ name: string }>).map(c => c.name)).not.toContain('assistant_session_id');
    read.close();
  });
});
