import { describe, expect, it } from 'vitest';

import {
  groupRemoteSessionSummaries,
  legacyRemoteSessionPresentation,
  remoteSessionActivityCounts,
  remoteSessionStatus,
} from './session-summary-presentation';

const row = (id: string, status: string) => legacyRemoteSessionPresentation({
  id,
  adapterId: 'codex-cli',
  title: id,
  status,
  createdAt: 1,
  updatedAt: 2,
});

describe('Remote session summary presentation', () => {
  it('decodes only exact legacy lifecycle/activity tokens', () => {
    expect(remoteSessionStatus('active-working'))
      .toEqual({ lifecycle: 'active', activity: 'working' });
    expect(remoteSessionStatus('dormant-idle'))
      .toEqual({ lifecycle: 'dormant', activity: 'idle' });
    expect(() => remoteSessionStatus('closed')).toThrow(/无法识别/);
    expect(() => remoteSessionStatus('waiting')).toThrow(/无法识别/);
    expect(() => remoteSessionStatus('future-idle')).toThrow(/无法识别/);
  });

  it('drives Remote sections and header counts from the same status decoder', () => {
    const sessions = [
      row('working', 'active-working'),
      row('waiting', 'active-waiting'),
      row('sleeping', 'dormant-idle'),
      row('closed', 'closed-finished'),
      row('closed-working', 'closed-working'),
    ];
    const grouped = groupRemoteSessionSummaries(sessions);
    expect(grouped.active.map((session) => session.id)).toEqual(['working', 'waiting']);
    expect(grouped.dormant.map((session) => session.id)).toEqual(['sleeping']);
    expect(grouped.closed.map((session) => session.id)).toEqual(['closed', 'closed-working']);
    expect(remoteSessionActivityCounts(sessions)).toEqual({ waiting: 1, working: 1 });
  });
});
