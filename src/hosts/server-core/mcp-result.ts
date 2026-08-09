export type ServerCoreMcpResult = {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function serverCoreMcpOk(value: unknown): ServerCoreMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
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
