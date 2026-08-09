import { describe, expect, it } from 'vitest';

import { IpcInvoke } from '@shared/ipc-channels';

import { CORE_METHOD_METADATA } from './methods';
import { CURRENT_API_CLASSIFICATION } from './current-api-classification';

describe('current API migration classification', () => {
  it('classifies every existing invoke channel exactly once', () => {
    expect(Object.keys(CURRENT_API_CLASSIFICATION).sort()).toEqual(
      Object.keys(IpcInvoke).sort(),
    );
  });

  it('never exposes client-host or split methods directly to Feishu', () => {
    for (const classification of Object.values(CURRENT_API_CLASSIFICATION)) {
      if (classification.feishu === 'session-console') {
        expect(classification.executionOwner).toBe('authoritative-core');
        expect(classification.sshMigration).toBe('core-protocol');
      }
    }
  });

  it('requires idempotency for durable Core mutations only', () => {
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
