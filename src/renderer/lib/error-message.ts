export function errorMessage(error: unknown): string {
  return stripTransportErrorPrefix(error instanceof Error ? error.message : String(error));
}

function stripTransportErrorPrefix(message: string): string {
  let result = message.trim();
  result = result.replace(/^Error invoking remote method(?:\s+'[^']+')?:\s*/i, '');
  result = result.replace(/^(?:Error|RemoteHostPublicError):\s*/i, '');
  return result || '未知错误';
}
