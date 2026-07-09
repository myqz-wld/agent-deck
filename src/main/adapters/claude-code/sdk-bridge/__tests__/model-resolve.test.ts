import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveClaudeModel } from '../model-resolve';
import { sessionRepo } from '@main/store/session-repo';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(),
  },
}));

describe('resolveClaudeModel', () => {
  beforeEach(() => {
    vi.mocked(sessionRepo.get).mockReset();
  });

  it('uses explicit model before the resumed model and profile default', () => {
    vi.mocked(sessionRepo.get).mockReturnValue({ model: 'stored-model' } as never);
    expect(
      resolveClaudeModel({
        resume: 'sid',
        model: 'explicit-model',
        profileDefaultModel: 'provider-default',
      }),
    ).toBe('explicit-model');
  });

  it('uses the resumed concrete model before a provider profile default', () => {
    vi.mocked(sessionRepo.get).mockReturnValue({ model: 'stored-concrete-model' } as never);
    expect(
      resolveClaudeModel({ resume: 'sid', profileDefaultModel: 'provider-default' }),
    ).toBe('stored-concrete-model');
  });

  it('uses the provider default only for a new session without an explicit model', () => {
    expect(resolveClaudeModel({ profileDefaultModel: 'provider-default' })).toBe(
      'provider-default',
    );
    expect(sessionRepo.get).not.toHaveBeenCalled();
  });
});
