export type ServerCoreMcpResult = {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function serverCoreMcpOk(value: unknown): ServerCoreMcpResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Server Core MCP success payload must be an object');
  }
  return {
    content: [],
    structuredContent: value as Record<string, unknown>,
  };
}

export function serverCoreMcpError(
  error: unknown,
  hint: string,
): ServerCoreMcpResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: error instanceof Error ? error.message : 'Server Core MCP operation failed',
        hint,
      }),
    }],
    isError: true,
  };
}
