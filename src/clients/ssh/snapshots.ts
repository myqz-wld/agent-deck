import { copyRemoteOwnerGrantClaim, type ClientHello, type HostHello } from '@contracts/index';

import type { SshConnectionState, SshHostProfile } from './types';

export function cloneClientHello(hello: ClientHello): ClientHello {
  return { ...hello, protocolVersion: { ...hello.protocolVersion } };
}

export function freezeClientHello(hello: ClientHello): ClientHello {
  const snapshot = cloneClientHello(hello);
  Object.freeze(snapshot.protocolVersion);
  return Object.freeze(snapshot);
}

export function cloneHostHello(hello: HostHello): HostHello {
  const access = hello.access.kind === 'authenticated-client'
    ? { ...hello.access, grant: copyRemoteOwnerGrantClaim(hello.access.grant) }
    : { ...hello.access };
  return {
    ...hello,
    protocolVersion: { ...hello.protocolVersion },
    authoritativeCore: { ...hello.authoritativeCore },
    access,
    capabilities: [...hello.capabilities],
    limits: { ...hello.limits },
  };
}

export function freezeHostHello(hello: HostHello): HostHello {
  const snapshot = cloneHostHello(hello);
  Object.freeze(snapshot.protocolVersion);
  Object.freeze(snapshot.authoritativeCore);
  Object.freeze(snapshot.access);
  Object.freeze(snapshot.capabilities);
  Object.freeze(snapshot.limits);
  return Object.freeze(snapshot);
}

export function cloneSshConnectionState(state: SshConnectionState): SshConnectionState {
  return { ...state, hello: state.hello ? cloneHostHello(state.hello) : null };
}

export function freezeSshConnectionState(state: SshConnectionState): SshConnectionState {
  return Object.freeze({ ...state, hello: state.hello ? freezeHostHello(state.hello) : null });
}

export function freezeSshHostProfile(profile: SshHostProfile): Readonly<SshHostProfile> {
  return Object.freeze({ ...profile });
}
