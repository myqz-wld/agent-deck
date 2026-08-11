import { describe, expect, it } from 'vitest';

import {
  CURRENT_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  ProtocolCompatibilityError,
} from './version';

describe('protocol version negotiation', () => {
  it('advertises Remote handoff, context, and active input negotiation as protocol 2.3', () => {
    expect(CURRENT_PROTOCOL_VERSION).toEqual({ major: 2, minor: 3 });
  });
  it('selects the lower additive minor version for the same major', () => {
    expect(negotiateProtocolVersion({ major: 1, minor: 2 }, { major: 1, minor: 5 })).toEqual({
      major: 1,
      minor: 2,
    });
  });

  it('rejects a major mismatch before ordinary calls', () => {
    expect(() =>
      negotiateProtocolVersion({ major: 1, minor: 0 }, { major: 2, minor: 0 }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolCompatibilityError>>({
        code: 'incompatible_protocol',
      }),
    );
  });

  it('rejects clients older than the configured compatible minor floor', () => {
    expect(() =>
      negotiateProtocolVersion({ major: 1, minor: 1 }, { major: 1, minor: 4 }, 2),
    ).toThrowError('older than the host minimum');
  });
});
