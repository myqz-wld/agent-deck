import { describe, expect, it } from 'vitest';

import {
  CURRENT_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  ProtocolCompatibilityError,
} from './version';

describe('protocol version negotiation', () => {
  it('advertises canonical Server access claims as protocol 2.7', () => {
    expect(CURRENT_PROTOCOL_VERSION).toEqual({ major: 2, minor: 7 });
  });
  it('accepts only one exact protocol contract', () => {
    expect(negotiateProtocolVersion({ major: 2, minor: 7 })).toEqual({ major: 2, minor: 7 });
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

  it('rejects minor skew before ordinary calls', () => {
    expect(() =>
      negotiateProtocolVersion({ major: 2, minor: 6 }, { major: 2, minor: 7 }),
    ).toThrowError('Protocol version mismatch');
  });
});
