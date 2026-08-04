import type { HostHello } from '@contracts/index';
import { assertHostHello } from '@protocol/messages';
import { CURRENT_PROTOCOL_VERSION, negotiateProtocolVersion } from '@protocol/version';

import {
  assertBoundedSingleLine,
  SshTransportError,
  SSH_TEXT_LIMITS,
} from '@clients/ssh';

import type { ElectronHostProfile } from './model';

export function validateElectronHostHello(
  profile: ElectronHostProfile,
  hello: HostHello,
  pinnedInstanceId: string | null,
): void {
  try {
    assertHostHello(hello);
    negotiateProtocolVersion(CURRENT_PROTOCOL_VERSION, hello.protocolVersion);
    assertBoundedSingleLine(hello.instanceId, 'hello.instanceId', SSH_TEXT_LIMITS.instanceId);
    assertBoundedSingleLine(
      hello.authoritativeCore.id,
      'hello.authoritativeCore.id',
      SSH_TEXT_LIMITS.coreId,
    );
    assertBoundedSingleLine(hello.access.clientId, 'hello.access.clientId', SSH_TEXT_LIMITS.clientId);
    if (hello.topology !== profile.topology || hello.access.clientId !== profile.clientId) {
      throw new Error('Host hello does not match the registered topology/client identity');
    }
    if (profile.topology === 'standalone') {
      if (hello.access.kind !== 'standalone') throw new Error('Standalone access context mismatch');
    } else {
      if (
        hello.access.kind !== 'authenticated-client' ||
        hello.access.transport !== 'ssh' ||
        hello.access.surface !== 'desktop-full'
      ) {
        throw new Error('Remote desktop access context mismatch');
      }
      if (profile.ssh.expectedInstanceId && profile.ssh.expectedInstanceId !== hello.instanceId) {
        throw new Error('Host hello does not match profile expectedInstanceId');
      }
    }
    if (pinnedInstanceId && pinnedInstanceId !== hello.instanceId) {
      throw new Error('A registered host profile cannot change instanceId');
    }
    if (new Set(hello.capabilities).size !== hello.capabilities.length) {
      throw new Error('Host hello contains duplicate capabilities');
    }
  } catch (error) {
    if (error instanceof SshTransportError) throw error;
    throw new SshTransportError(
      'incompatible_handshake',
      error instanceof Error ? error.message : String(error),
      false,
      { cause: error },
    );
  }
}
