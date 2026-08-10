import { describe, expect, it } from 'vitest';

import {
  createPermissionPreviewDisplay,
  parsePermissionPreviewDisplay,
  PERMISSION_PREVIEW_MAX_INPUT_BYTES,
} from './permission-preview';

describe('permission preview contract', () => {
  it('preserves material Edit and structured MCP authorization fields', () => {
    const display = createPermissionPreviewDisplay('Edit', {
      file_path: '/workspace/src/app.ts',
      old_string: 'before',
      new_string: 'after',
      server_name: 'browser',
      tool_name: 'browser_type',
      arguments: { ref: 'field-1', text: 'public value' },
    });

    expect(display).toMatchObject({
      tool: 'Edit',
      complete: true,
      input: {
        file_path: '/workspace/src/app.ts',
        old_string: 'before',
        new_string: 'after',
        arguments: { ref: 'field-1', text: 'public value' },
      },
    });
    expect(parsePermissionPreviewDisplay(display)).toEqual(display);
  });

  it('redacts named secrets without dropping the surrounding authorization shape', () => {
    const display = createPermissionPreviewDisplay('mcp__service__call', {
      arguments: {
        endpoint: 'https://example.test',
        authorization: 'Bearer raw-secret',
        api_key: 'raw-secret',
        token: 'raw-token',
        client_secret: 'raw-client-secret',
        x_api_key: 'raw-x-api-key',
        credential: 'raw-credential',
        github_token: 'raw-github-token',
        auth_token: 'raw-auth-token',
      },
    });

    expect(display).toMatchObject({
      complete: true,
      redacted: true,
      input: {
        arguments: {
          endpoint: 'https://example.test',
          authorization: '[redacted]',
          api_key: '[redacted]',
          token: '[redacted]',
          client_secret: '[redacted]',
          x_api_key: '[redacted]',
          credential: '[redacted]',
          github_token: '[redacted]',
          auth_token: '[redacted]',
        },
      },
    });
    expect(JSON.stringify(display)).not.toContain('raw-');
  });

  it('conservatively redacts ambiguous token-named metadata instead of risking disclosure', () => {
    const display = createPermissionPreviewDisplay('mcp__service__call', {
      tokenBudget: 8_192,
      tokenizer: 'cl100k_base',
      retryBudget: 3,
    });

    expect(display).toMatchObject({
      complete: true,
      redacted: true,
      input: {
        tokenBudget: '[redacted]',
        tokenizer: '[redacted]',
        retryBudget: 3,
      },
    });
  });

  it('marks oversized or unsupported input incomplete and stays inside the wire bound', () => {
    const circular: Record<string, unknown> = { content: 'x'.repeat(100_000) };
    circular.circular = circular;
    const display = createPermissionPreviewDisplay('Write', circular);

    expect(display.complete).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(display.input)).byteLength)
      .toBeLessThanOrEqual(PERMISSION_PREVIEW_MAX_INPUT_BYTES);
    expect(() => parsePermissionPreviewDisplay({
      ...display,
      unexpected: true,
    })).toThrow('Invalid permission preview');
  });
});
