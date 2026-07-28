export function safeErrorData(error: unknown): {
  errorName: string;
  errorMessage: string;
} {
  if (!(error instanceof Error)) {
    return {
      errorName: 'Error',
      errorMessage: `Non-Error rejection (${error === null ? 'null' : typeof error})`,
    };
  }
  return {
    errorName: boundedSingleLine(error.name || 'Error', 80),
    errorMessage: boundedSingleLine(error.message || 'Unknown error', 320),
  };
}

function boundedSingleLine(value: string, limit: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit)}…`;
}
