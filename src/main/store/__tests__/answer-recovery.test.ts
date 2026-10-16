import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentEvent, SessionRecord } from '@shared/types';
import { CURRENT_SCHEMA_SQL } from '../schema';
import { eventRepo } from '../event-repo';
import { createEventRevisionReadRepo } from '../event-revision-read';
import { normalizeContinuationEvent } from '@main/session/continuation-context/event-normalizer';
import { AskUserService } from '@main/ask-user/service';
import { ServerCoreMcpPresentation } from '@hosts/server-core/mcp-presentation';
const holder = { db: null as Database.Database | null };
vi.mock('@main/store/db', () => ({ getDb: () => holder.db }));
vi.mock('@main/session/manager', () => ({ sessionManager: { ingest: vi.fn() } }));
beforeEach(() => {
  holder.db = new Database(':memory:'); holder.db.exec(CURRENT_SCHEMA_SQL);
  holder.db.prepare(`INSERT INTO sessions(id,agent_id,cwd,title,source,lifecycle,activity,started_at,last_event_at)
    VALUES('s','codex-cli','/repo','Example','sdk','active','working',1,1)`).run();
});
afterEach(() => holder.db?.close());
const args = { questions: [{ question: 'Constraints?' }] };
const answer = { answers: [{ question: 'Constraints?', selected: [], other: 'Remember expansion' }] };
describe('answer continuation durability', () => {
  it.each(['local', 'core'])('retains the acknowledged %s answer after interruption in the revision source', async host => {
    if (host === 'local') {
      const service = new AskUserService({ createId: () => 'ask-1', getSession: () => ({ id: 's' }) as SessionRecord,
        ingest: event => { eventRepo.insert(event); } });
      const pending = service.request('s', 'codex-cli', args);
      service.respond('s', 'ask-1', answer);
      service.cancelForSession('s');
      expect((await pending).status).toBe('answered');
    } else {
      const service = new ServerCoreMcpPresentation({ createId: () => 'ask-1', appendChange: vi.fn(),
        persistAnswer: (sessionId, requestId, answer) => { eventRepo.insert({ sessionId, agentId: 'codex-cli', kind: 'waiting-for-user',
          payload: { type: 'ask-question-answered', requestId, ...answer }, ts: 1 } as AgentEvent); } });
      await service.start(); const pending = service.requestAsk('s', args);
      service.respond('s', service.list('s')[0].id, 'submit', { q1: 'Remember expansion' });
      service.prepareSessionTransfer('s', 'next').commit();
      expect((await pending).status).toBe('answered'); await service.stop();
    }
    const repo = createEventRevisionReadRepo(holder.db!);
    const source = repo.listRawEvents({ sessionId: 's', throughRevision: repo.state('s')!.revision }).map(value => normalizeContinuationEvent(value));
    expect(source.filter(event => (event?.payload as { type?: string })?.type === 'ask-question-answered'))
      .toMatchObject([{ kind: 'waiting-for-user', payload: answer }]);
  });
});
