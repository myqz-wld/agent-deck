import { posix } from 'node:path';
import { FeishuGatewayError } from './errors';
import type { FeishuGatewayBinding, FeishuServerProjectAuthorityPort } from './types';

const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function serverCoreCwd(value: string): string {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 4_096 ||
    PATH_CONTROL.test(value) ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value
  ) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Server Core project cwd must be absolute, normalized, bounded, and control-free',
    );
  }
  return value;
}

export function assertProjectAuthorityTopology(
  binding: FeishuGatewayBinding,
  authority: FeishuServerProjectAuthorityPort | null,
): void {
  if (binding.topology === 'relay' && authority !== null) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Relay gateway configuration cannot contain a Server cwd project authority',
    );
  }
}

export function resolveServerCoreProject(
  binding: FeishuGatewayBinding,
  authority: FeishuServerProjectAuthorityPort | null,
  alias: string,
): string | null {
  if (binding.topology !== 'server-core' || authority === null) return null;
  const cwd = authority.resolve(alias);
  return cwd === null ? null : serverCoreCwd(cwd);
}
