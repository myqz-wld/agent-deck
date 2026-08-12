import { describe, expect, it } from 'vitest';

import { resolveServerCoreProviderSettings } from './provider-settings';
import { resolveServerCoreSessionCreateCatalog } from './session-create-catalog';

const settings = resolveServerCoreProviderSettings({});

describe('Server Core safe session creation catalog', () => {
  it('uses provider-independent defaults when no explicit safe catalog exists', () => {
    const catalog = resolveServerCoreSessionCreateCatalog({}, settings);
    expect(catalog.get('claude-code')).toMatchObject({
      providers: [],
      defaults: { provider: '', model: '', thinking: 'high' },
    });
    expect(catalog.get('grok-build')).toMatchObject({
      providers: [],
      defaults: { model: 'grok-4.5', sessionMode: 'default' },
    });
  });

  it('accepts a bounded explicit allowlisted provider projection', () => {
    const catalog = resolveServerCoreSessionCreateCatalog({
      sessionCreationCatalog: {
        schemaVersion: 1,
        adapters: [{
          adapterId: 'codex-cli',
          providers: ['team'],
          provider: 'team',
          model: 'gpt-5.6',
          thinking: 'xhigh',
          approvalPolicy: 'never',
        }],
      },
    }, settings);
    expect(catalog.get('codex-cli')).toMatchObject({
      providers: ['team'],
      defaults: {
        provider: 'team',
        model: 'gpt-5.6',
        thinking: 'xhigh',
        approvalPolicy: 'never',
      },
    });
  });

  it('rejects secret-shaped catalog values', () => {
    expect(() => resolveServerCoreSessionCreateCatalog({
      sessionCreationCatalog: {
        schemaVersion: 1,
        adapters: [{
          adapterId: 'codex-cli',
          providers: [],
          provider: '',
          thinking: 'high',
          approvalPolicy: 'never',
          model: 'sk-must-not-cross',
        }],
      },
    }, settings)).toThrow('sessionCreationCatalog');
  });

  it('rejects unknown catalog fields', () => {
    expect(() => resolveServerCoreSessionCreateCatalog({
      sessionCreationCatalog: {
        schemaVersion: 1,
        adapters: [{
          adapterId: 'codex-cli',
          providers: [],
          provider: '',
          thinking: 'high',
          approvalPolicy: 'never',
          model: 'gpt-5.6',
          token: 'private',
        }],
      },
    }, settings)).toThrow('sessionCreationCatalog');
  });
});
