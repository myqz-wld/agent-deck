import { beforeEach, describe, expect, it, vi } from 'vitest';

interface AliasPageRequest {
  requestKey: string;
  successorSessionId: string;
  offset: number;
  limit: number;
}

interface AliasRow {
  sourceSessionId: string;
  successorSessionId: string;
}

interface AliasProbeRequest {
  requestKey: string;
  successorSessionId: string;
}

const mocks = vi.hoisted(() => ({
  successorForStrict: vi.fn<(sessionId: string) => string | null>(),
  pages: vi.fn<(
    requests: readonly AliasPageRequest[],
  ) => Array<{
    requestKey: string;
    sourceSessionId: string;
    successorSessionId: string;
  }>>(),
  probes: vi.fn<(
    requests: readonly AliasProbeRequest[],
  ) => Array<{
    requestKey: string;
    exhausted: boolean;
  }>>(),
}));

vi.mock('../cutover-coordinator', () => ({
  handOffCutoverCoordinator: { successorForStrict: mocks.successorForStrict },
}));

vi.mock('@main/store/session-handoff-alias-repo', () => ({
  listSessionHandOffAliasPages: mocks.pages,
  probeSessionHandOffAliases: mocks.probes,
}));

import {
  isCurrentHandOffOwner,
  sessionOwnershipLineage,
  sessionOwnershipLineages,
} from '../ownership';

beforeEach(() => {
  mocks.successorForStrict.mockReset().mockReturnValue(null);
  mocks.pages.mockReset().mockReturnValue([]);
  mocks.probes.mockReset().mockImplementation((requests) => requests.map((request) => ({
    requestKey: request.requestKey,
    exhausted: true,
  })));
});

function serveAliasPages(
  requests: readonly AliasPageRequest[],
  aliasesFor: (successorSessionId: string) => readonly AliasRow[],
) {
  return requests.flatMap((request) => aliasesFor(request.successorSessionId)
    .slice(request.offset, request.offset + request.limit)
    .map((alias) => ({ ...alias, requestKey: request.requestKey })));
}

function mockAliasGraph(aliasesFor: (successorSessionId: string) => readonly AliasRow[]): void {
  mocks.pages.mockImplementation((requests) => serveAliasPages(requests, aliasesFor));
  mocks.probes.mockImplementation((requests) => requests.map((request) => ({
    requestKey: request.requestKey,
    exhausted: aliasesFor(request.successorSessionId).length === 0,
  })));
}

describe('handoff logical ownership', () => {
  it('accepts only the current owner after a committed handoff', () => {
    mocks.successorForStrict.mockImplementation((id) => id === 'source' ? 'successor-2' : null);

    expect(isCurrentHandOffOwner('source', 'source')).toBe(false);
    expect(isCurrentHandOffOwner('source', 'successor-2')).toBe(true);
    expect(isCurrentHandOffOwner('source', 'successor-1')).toBe(false);
    expect(isCurrentHandOffOwner(null, 'successor-2')).toBe(false);

    mocks.successorForStrict.mockReturnValue(null);
    expect(isCurrentHandOffOwner('source', 'source')).toBe(true);
  });

  it('denies every caller when durable ownership resolution fails', () => {
    mocks.successorForStrict.mockImplementation(() => {
      throw new Error('database unavailable');
    });

    expect(isCurrentHandOffOwner('source', 'source')).toBe(false);
    expect(isCurrentHandOffOwner('source', 'successor')).toBe(false);
  });

  it('returns the current owner and all path-compressed predecessors', () => {
    mockAliasGraph((id) => id === 'current'
      ? [
          { sourceSessionId: 'source-1', successorSessionId: 'current' },
          { sourceSessionId: 'source-2', successorSessionId: 'current' },
          { sourceSessionId: 'source-1', successorSessionId: 'current' },
        ]
      : []);

    expect(sessionOwnershipLineage('current')).toEqual(['current', 'source-1', 'source-2']);
  });

  it('walks rename-created predecessor chains instead of stopping after one hop', () => {
    mockAliasGraph((id) => {
      if (id === 'later-successor') {
        return [{ sourceSessionId: 'renamed-source', successorSessionId: id }];
      }
      return id === 'renamed-source'
        ? [
            { sourceSessionId: 'old-source', successorSessionId: id },
            { sourceSessionId: 'parent-source', successorSessionId: id },
          ]
        : [];
    });

    expect(sessionOwnershipLineage('later-successor')).toEqual([
      'later-successor',
      'renamed-source',
      'old-source',
      'parent-source',
    ]);
  });

  it('caps one logical lineage before requesting unbounded alias fan-in', () => {
    mockAliasGraph((id) => id === 'current'
      ? Array.from({ length: 2_000 }, (_, index) => ({
          sourceSessionId: `source-${index}`,
          successorSessionId: id,
        }))
      : []);

    expect(sessionOwnershipLineage('current')).toHaveLength(1_024);
    expect(mocks.pages).toHaveBeenCalledWith([{
      requestKey: 'current:0',
      successorSessionId: 'current',
      offset: 0,
      limit: 64,
    }]);
  });

  it('reallocates unused page budget without starving a later successor', () => {
    const roots = [
      'root-a',
      ...Array.from({ length: 399 }, (_, index) => `empty-${index}`),
      'root-b',
    ];
    mockAliasGraph((id) =>
      id === 'root-a'
        ? Array.from({ length: 8_192 }, (_, index) => ({
            sourceSessionId: `a-source-${index}`,
            successorSessionId: id,
          }))
        : id === 'root-b'
          ? [{ sourceSessionId: 'b-source', successorSessionId: id }]
          : []);

    const lineages = sessionOwnershipLineages(roots);
    expect(lineages.get('root-a')).toHaveLength(1_024);
    expect(lineages.get('root-b')).toEqual(['root-b', 'b-source']);
  });

  it('does not let a capped root spend the budget needed by another root at deeper levels', () => {
    mockAliasGraph((id) => {
      if (id === 'root-a') {
        return Array.from({ length: 1_023 }, (_, index) => ({
          sourceSessionId: `a-${index + 1}`,
          successorSessionId: id,
        }));
      }
      if (/^a-\d+$/.test(id)) {
        return Array.from({ length: 8 }, (_, index) => ({
          sourceSessionId: `${id}-predecessor-${index + 1}`,
          successorSessionId: id,
        }));
      }
      if (id === 'root-b') return [{ sourceSessionId: 'b1', successorSessionId: id }];
      if (id === 'b1') return [{ sourceSessionId: 'b2', successorSessionId: id }];
      if (id === 'b2') return [{ sourceSessionId: 'b3', successorSessionId: id }];
      return [];
    });

    const lineages = sessionOwnershipLineages(['root-a', 'root-b']);
    expect(lineages.get('root-a')).toHaveLength(1_024);
    expect(lineages.get('root-b')).toEqual(['root-b', 'b1', 'b2', 'b3']);
    expect(mocks.pages.mock.calls.flatMap(([requests]) => requests)
      .some((request) => /^a-\d+$/.test(request.successorSessionId))).toBe(false);
    expect(mocks.probes.mock.calls.flatMap(([requests]) => requests)
      .some((request) => /^a-\d+$/.test(request.successorSessionId))).toBe(false);
  });

  it('probes a wide empty frontier in one batch instead of reading every leaf', () => {
    mockAliasGraph((id) => id === 'current'
      ? Array.from({ length: 1_022 }, (_, index) => ({
          sourceSessionId: `leaf-${index + 1}`,
          successorSessionId: id,
        }))
      : []);

    expect(sessionOwnershipLineage('current')).toHaveLength(1_023);
    expect(mocks.pages).toHaveBeenCalledTimes(16);
    expect(mocks.probes).toHaveBeenCalledTimes(1);
    expect(mocks.probes.mock.calls[0]?.[0]).toHaveLength(1_022);
  });

  it('shares one root credit across a batch of sparse non-empty frontier nodes', () => {
    mockAliasGraph((id) => {
      if (id === 'current') {
        return Array.from({ length: 128 }, (_, index) => ({
          sourceSessionId: `branch-${index + 1}`,
          successorSessionId: id,
        }));
      }
      if (/^branch-\d+$/.test(id)) {
        return [{ sourceSessionId: `${id}-parent`, successorSessionId: id }];
      }
      return [];
    });

    expect(sessionOwnershipLineage('current')).toHaveLength(257);
    expect(mocks.probes).toHaveBeenCalledTimes(2);
    expect(mocks.pages).toHaveBeenCalledTimes(7);
    expect(mocks.pages.mock.calls.some(([requests]) => requests.length === 64)).toBe(true);
    for (const [requests] of mocks.pages.mock.calls) {
      expect(requests.reduce((total, request) => total + request.limit, 0))
        .toBeLessThanOrEqual(64);
    }
  });

  it('falls back to the current id while the database is unavailable', () => {
    mocks.pages.mockImplementation(() => {
      throw new Error('db closed');
    });

    expect(sessionOwnershipLineage('current')).toEqual(['current']);
  });
});
