import { describe, expect, it } from 'vitest';

import type { RemoteHostSessionPresentationDto } from '@shared/remote-host';
import {
  groupRemoteSessionSummaries,
  remoteSessionActivityCounts,
} from './session-summary-presentation';

function row(
  id: string,
  lifecycle: RemoteHostSessionPresentationDto['lifecycle'],
  activity: RemoteHostSessionPresentationDto['activity'],
): RemoteHostSessionPresentationDto {
  return {
    id, adapterId: 'codex-cli', title: id, source: 'sdk', lifecycle, activity,
    archived: lifecycle === 'closed', pinned: false, createdAt: 1, updatedAt: 2,
    endedAt: null, model: null, thinking: null, runtimeProvider: null, context: null,
    spawnedBy: null, spawnDepth: 0, teams: [], summary: null,
    summaryGenerationSource: null, workspaceLabel: null, contextOnly: false,
  };
}

describe('Remote session summary presentation', () => {
  it('drives Remote sections and header counts from rich presentation fields', () => {
    const sessions = [
      row('working', 'active', 'working'),
      row('waiting', 'active', 'waiting'),
      row('sleeping', 'dormant', 'idle'),
      row('closed', 'closed', 'finished'),
      row('closed-working', 'closed', 'working'),
    ];
    const grouped = groupRemoteSessionSummaries(sessions);
    expect(grouped.active.map((session) => session.id)).toEqual(['working', 'waiting']);
    expect(grouped.dormant.map((session) => session.id)).toEqual(['sleeping']);
    expect(grouped.closed.map((session) => session.id)).toEqual(['closed', 'closed-working']);
    expect(remoteSessionActivityCounts(sessions)).toEqual({ waiting: 1, working: 1 });
  });
});
