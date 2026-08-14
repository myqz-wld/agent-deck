import { describe, expect, it } from 'vitest';

import { CORE_METHOD_METADATA } from './methods';

describe('Core method metadata', () => {
  it('requires idempotency for durable mutations only', () => {
    expect(CORE_METHOD_METADATA['desktop.broker.respond']).toMatchObject({
      mutation: true,
      idempotency: 'forbidden',
    });
    for (const [method, metadata] of Object.entries(CORE_METHOD_METADATA)) {
      const ephemeralMutation = method === 'desktop.broker.respond';
      expect(metadata.idempotency).toBe(
        metadata.mutation && !ephemeralMutation ? 'required' : 'forbidden',
      );
    }
  });
});
