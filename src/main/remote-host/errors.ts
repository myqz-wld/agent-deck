import {
  REMOTE_HOST_PUBLIC_MESSAGES,
  safeRemoteHostErrorCode,
} from '@shared/remote-host';

export class RemoteHostPublicError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RemoteHostPublicError';
  }
}

export function remoteHostErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return safeRemoteHostErrorCode((error as { code: string }).code);
  }
  if (error instanceof Error && error.name === 'RemoteHostInputError') return 'invalid_request';
  return 'internal_error';
}

export function publicRemoteHostError(error: unknown): RemoteHostPublicError {
  const code = remoteHostErrorCode(error);
  return new RemoteHostPublicError(
    code,
    REMOTE_HOST_PUBLIC_MESSAGES[code] ?? '远程主机操作失败，请重试。',
  );
}

export function publicConnectionError(
  error: { code: string; message: string } | null,
): { code: string; message: string } | null {
  if (!error) return null;
  const code = safeRemoteHostErrorCode(error.code);
  return {
    code,
    message: REMOTE_HOST_PUBLIC_MESSAGES[code] ?? '远程连接不可用，请检查配置后重试。',
  };
}
