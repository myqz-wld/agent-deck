import { describe, expect, it } from 'vitest';
import {
  REDACTED_VALUE,
  safeDiagnosticString,
  safeDisplayText,
} from './safe-diagnostic-text';

describe('safe diagnostic text Core', () => {
  it('redacts inline credentials and local paths without desktop dependencies', () => {
    const safe = safeDisplayText(
      'Authorization: Bearer secret-token api_key=private-value ' +
      '/Users/alice/private/file.txt /private/tmp/provider-output.json ' +
      '/workspace/customer/repository/file.ts',
    );

    expect(safe).toContain(`Authorization: ${REDACTED_VALUE}`);
    expect(safe).toContain(`api_key=${REDACTED_VALUE}`);
    expect(safe).toContain('<home-path>');
    expect(safe).toContain('<temp-path>');
    expect(safe).toContain('<local-path>');
    expect(safe).not.toContain('secret-token');
    expect(safe).not.toContain('private-value');
    expect(safe).not.toContain('/Users/alice');
  });

  it('enforces the caller-owned text ceiling', () => {
    expect(safeDiagnosticString('abcdefgh', 4)).toBe('abcd…[truncated:4]');
    expect(safeDisplayText('x'.repeat(4_000))).toContain('…[truncated:928]');
  });
});
