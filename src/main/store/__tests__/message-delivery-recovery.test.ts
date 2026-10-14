import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_SQL } from '../schema';
import { eventRepo } from '../event-repo';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { readMessageDeliveryRecovery } from '@shared/message-delivery-recovery';
import { makeInternalSession } from '@main/adapters/claude-code/sdk-bridge/types';
import { makeClaudeUserMessageCore } from '@main/adapters/claude-code/sdk-bridge/user-message-stream-core';
import { finalizeClaudeStreamCore } from '@main/adapters/claude-code/sdk-bridge/stream-finalize-core';

const holder = { db: null as Database.Database | null };
vi.mock('@main/store/db', () => ({ getDb: () => holder.db }));
beforeEach(() => {
  holder.db = new Database(':memory:');
  holder.db.pragma('foreign_keys = ON');
  holder.db.exec(CURRENT_SCHEMA_SQL);
  holder.db.prepare(`INSERT INTO sessions(id,agent_id,cwd,title,source,lifecycle,activity,started_at,last_event_at)
    VALUES('session-a','claude-code','/workspace','Synthetic','sdk','active','working',1,1)`).run();
});
afterEach(() => holder.db?.close());

describe('durable failed input recovery', () => {
  it('reloads the full original and attachments after the live runtime has been removed', () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    const sessions = new Map([['session-a', internal]]);
    const text = '界'.repeat(MAX_USER_MESSAGE_LENGTH);
    const attachments = [{ kind: 'uploaded' as const, path: '/synthetic/input.png', mime: 'image/png', bytes: 42 }];
    const pending = makeClaudeUserMessageCore('session-a', text, attachments, {
      now: () => 1, createProviderMessageId: () => 'input-a', readAttachmentBase64: async () => '',
    });
    pending.deferredUserEvent = { text, attachments, turnCorrelationId: 'input-a' };
    internal.submittingUserMessage = { pending, providerMessageId: 'input-a', status: 'submitting' };
    finalizeClaudeStreamCore({ sessions, emit: (event) => { eventRepo.insert(event); } }, internal,
      'session-a', { agentId: 'claude-code', now: () => 2, resolveModel: () => null,
        emitTokenRateTick: vi.fn(), releaseSdkClaim: vi.fn() });
    expect(sessions.size).toBe(0);
    const records = eventRepo.listForSession('session-a').map(readMessageDeliveryRecovery).filter(Boolean);
    expect(records).toHaveLength(1);
    expect(records[0]?.text === text).toBe(true);
    expect(records[0]?.attachments).toEqual(attachments);
    expect(records[0]?.status).toBe('unknown');
    expect(eventRepo.hasExactUserMessage('session-a', text)).toBe(false);
  });
});
