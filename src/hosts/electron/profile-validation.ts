import { isBoundedSingleLine, SSH_TEXT_LIMITS, validateSshHostProfile } from '@clients/ssh';

import type { ElectronHostProfile } from './model';

function requireText(value: string, field: string, maxBytes: number): void {
  if (!isBoundedSingleLine(value, maxBytes)) {
    throw new Error(
      `${field} must be free of wire control characters and at most ${maxBytes} UTF-8 bytes`,
    );
  }
}

export function validateElectronHostProfile(profile: ElectronHostProfile): void {
  requireText(profile.id, 'profile.id', SSH_TEXT_LIMITS.profileId);
  requireText(profile.label, 'profile.label', SSH_TEXT_LIMITS.profileLabel);
  requireText(profile.clientId, 'profile.clientId', SSH_TEXT_LIMITS.clientId);
  if (profile.topology === 'standalone') return;
  validateSshHostProfile(profile.ssh);
  if (profile.ssh.id !== profile.id || profile.ssh.topology !== profile.topology) {
    throw new Error('Electron profile and SSH profile identity/topology must match');
  }
}
