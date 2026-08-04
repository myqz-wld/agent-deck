import { describe, expect, it } from 'vitest';
import { mainBootstrapErrorDiagnostic } from '../bootstrap-diagnostics';

describe('mainBootstrapErrorDiagnostic', () => {
  it('keeps safe root-cause fields without persisting local or external content', () => {
    const error = Object.assign(
      new Error(
        'Cannot register route at /Users/private/repo token=private https://private.test/path?q=1',
      ),
      { code: 'FST_ERR_INSTANCE_ALREADY_LISTENING' },
    );
    error.name = 'FastifyError';

    const diagnostic = mainBootstrapErrorDiagnostic(error);

    expect(diagnostic).toMatchObject({
      name: 'FastifyError',
      code: 'FST_ERR_INSTANCE_ALREADY_LISTENING',
    });
    expect(diagnostic.fingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(diagnostic.message).toContain('Cannot register route');
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /Users\/private|token=private|private\.test|\/path\?q/,
    );
  });

  it('omits unstructured error codes instead of treating them as diagnostic metadata', () => {
    const error = Object.assign(new Error('bootstrap failed'), {
      code: 'token=private /Users/private',
    });

    const diagnostic = mainBootstrapErrorDiagnostic(error);

    expect(diagnostic.code).toBeUndefined();
    expect(JSON.stringify(diagnostic)).not.toMatch(/token=private|Users\/private/);
  });
});
