import { describe, expect, it, vi } from 'vitest';
import {
  REDACTED_VALUE,
  installSafeDiagnosticLogHook,
  safeDiagnostic,
  safeErrorSummary,
  toSafeErrorDetails,
} from '../safe-diagnostic';

describe('safeDiagnostic', () => {
  it('redacts credential, auth, cookie, prompt, input, payload, and raw-result fields', () => {
    const diagnostic = safeDiagnostic({
      authorization: 'Bearer authorization-secret',
      cookie: 'session=cookie-secret',
      nested: {
        apiKey: 'api-key-secret',
        password: 'password-secret',
        accessToken: 'token-secret',
        clientSecret: 'client-secret',
        prompt: 'customer prompt',
        input: 'customer input',
        payload: { customer: 'payload-secret' },
        rawResult: 'provider raw result',
      },
      safe: 'visible',
    });

    expect(diagnostic).toEqual({
      authorization: REDACTED_VALUE,
      cookie: REDACTED_VALUE,
      nested: {
        apiKey: REDACTED_VALUE,
        password: REDACTED_VALUE,
        accessToken: REDACTED_VALUE,
        clientSecret: REDACTED_VALUE,
        prompt: REDACTED_VALUE,
        input: REDACTED_VALUE,
        payload: REDACTED_VALUE,
        rawResult: REDACTED_VALUE,
      },
      safe: 'visible',
    });
  });

  it('redacts inline secrets and local home/temp paths in otherwise safe strings', () => {
    const diagnostic = String(safeDiagnostic(
      'Authorization: Bearer abc.def.ghi api_key=key-secret ' +
      'cookie=session-secret /Users/alice/private/file.txt /private/tmp/provider-output.json ' +
      '/workspace/customer/private-repo/file.ts',
    ));

    expect(diagnostic).not.toContain('abc.def.ghi');
    expect(diagnostic).not.toContain('key-secret');
    expect(diagnostic).not.toContain('session-secret');
    expect(diagnostic).not.toContain('/Users/alice');
    expect(diagnostic).not.toContain('/private/tmp');
    expect(diagnostic).not.toContain('/workspace/customer');
    expect(diagnostic).toContain('<home-path>');
    expect(diagnostic).toContain('<temp-path>');
    expect(diagnostic).toContain('<local-path>');
  });

  it('bounds strings, depth, object keys, and array entries', () => {
    const manyKeys = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`key${index}`, index]),
    );
    const diagnostic = safeDiagnostic({
      long: 'x'.repeat(20_000),
      deep: { one: { two: { three: { four: { five: 'hidden' } } } } },
      manyKeys,
      manyItems: Array.from({ length: 100 }, (_, index) => index),
    }) as Record<string, unknown>;

    expect(String(diagnostic.long).length).toBeLessThan(1_000);
    expect(JSON.stringify(diagnostic.deep)).not.toContain('hidden');
    expect(Object.keys(diagnostic.manyKeys as object).length).toBeLessThan(40);
    expect((diagnostic.manyItems as unknown[]).length).toBeLessThan(30);
  });

  it('handles circular objects and bounded Error causes without throwing', () => {
    const cause = Object.assign(new Error(`cause ${'z'.repeat(10_000)}`), {
      token: 'cause-token',
    });
    const error = Object.assign(new Error(`outer ${'y'.repeat(10_000)}`, { cause }), {
      apiKey: 'outer-api-key',
    });
    const circular: Record<string, unknown> = { error };
    circular.self = circular;

    const diagnostic = safeDiagnostic(circular) as {
      error: {
        message: string;
        stack?: string;
        cause?: { message?: string; token?: string };
        apiKey?: string;
      };
      self: string;
    };

    expect(diagnostic.self).toBe('[Circular]');
    expect(diagnostic.error.apiKey).toBe(REDACTED_VALUE);
    expect(diagnostic.error.cause?.token).toBe(REDACTED_VALUE);
    expect(diagnostic.error.message.length).toBeLessThan(1_000);
    expect(diagnostic.error.stack?.length ?? 0).toBeLessThan(3_000);
    expect(diagnostic.error.cause?.message?.length ?? 0).toBeLessThan(1_000);
  });

  it('turns arbitrary rejection objects into a content-free renderer error summary', () => {
    const details = toSafeErrorDetails({
      prompt: 'customer-plan-secret',
      payload: { rawResult: 'provider-secret' },
    });

    expect(details).toEqual({
      name: 'Error',
      message: 'Non-Error rejection (object)',
    });
    expect(JSON.stringify(details)).not.toContain('customer-plan-secret');
    expect(JSON.stringify(details)).not.toContain('provider-secret');
  });

  it('fails closed for hostile accessors and revoked rejection proxies', () => {
    const accessor = {};
    Object.defineProperty(accessor, 'payload', {
      enumerable: true,
      get: () => {
        throw new Error('getter-secret');
      },
    });
    expect(safeDiagnostic(accessor)).toEqual({ payload: REDACTED_VALUE });

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(safeDiagnostic(revocable.proxy)).toBe('[DiagnosticSerializationFailed]');
    expect(safeErrorSummary(revocable.proxy)).toEqual({ type: 'uninspectable' });
  });
});

describe('installSafeDiagnosticLogHook', () => {
  it('installs once and redacts both file and console messages without mutating the input', () => {
    const logger = { hooks: [] as Array<(message: {
      data: unknown[];
    }, transport: unknown, transportName?: string) => { data: unknown[] } | false> };
    installSafeDiagnosticLogHook(logger, { developmentConsoleDetail: true });
    installSafeDiagnosticLogHook(logger, { developmentConsoleDetail: true });
    expect(logger.hooks).toHaveLength(1);

    const original = {
      data: [{
        password: 'file-and-console-secret',
        note: 'n'.repeat(10_000),
      }],
    };
    const fileMessage = logger.hooks[0](original, vi.fn(), 'file');
    const consoleMessage = logger.hooks[0](original, vi.fn(), 'console');

    expect(fileMessage).not.toBe(false);
    expect(consoleMessage).not.toBe(false);
    expect(JSON.stringify(fileMessage)).not.toContain('file-and-console-secret');
    expect(JSON.stringify(consoleMessage)).not.toContain('file-and-console-secret');
    expect(JSON.stringify(fileMessage).length).toBeLessThan(2_000);
    expect(JSON.stringify(consoleMessage).length).toBeLessThan(6_000);
    expect(original.data[0]).toMatchObject({
      password: 'file-and-console-secret',
      note: 'n'.repeat(10_000),
    });
  });
});
