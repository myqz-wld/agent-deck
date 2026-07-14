/** Main-process facade for the worker-safe event revision read model. */
import { getDb } from './db';
import {
  createEventRevisionReadRepo,
  type EventRevisionRepo,
} from './event-revision-read';

export * from './event-revision-read';

function getDefaultRepo(): EventRevisionRepo {
  // Unlike a long-lived injected repository, the production facade must not retain a closed DB
  // across app shutdown/reopen or an in-memory test DB replacement.
  return createEventRevisionReadRepo(getDb());
}

/** Production facade backed by the process database. */
export const eventRevisionRepo: EventRevisionRepo = {
  state: (sessionId) => getDefaultRepo().state(sessionId),
  listRawEvents: (input) => getDefaultRepo().listRawEvents(input),
};
